// Core built-in tools: import_artifact stays inside the configured import
// roots (no `..`, no symlink, no URL), get_job_status never returns a job's
// arguments, gateway_status reports names and counts only.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type PackRuntime, createPackRuntime } from "../../../src/core/runtime.js";
import { createSecretStore } from "../../../src/core/secrets/index.js";
import { artifactTools, openImportSource } from "../../../src/core/tools/builtin/artifacts.js";
import { isInside, jobView, resolveImportSource } from "../../../src/core/tools/builtin/index.js";
import { JobQueue } from "../../../src/lib/jobs.js";
import { Library } from "../../../src/lib/library.js";
import { UsageLedger } from "../../../src/lib/usage.js";
import { itSymlink } from "../../support/platform.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const PNG = Buffer.from("89504e470d0a1a0a", "hex");
const STORED = "fixture-builtin-secret-value-1122";

describe("core built-in tools", () => {
  let tmp: string;
  let root: string;
  let outside: string;
  let library: Library;
  let usage: UsageLedger;
  let jobsDb: Database.Database;
  let runtime: PackRuntime | undefined;

  const boot = async (importRoots: string[]): Promise<PackRuntime> => {
    const home = join(tmp, "home");
    const builtinDir = join(tmp, "builtin");
    mkdirSync(home, { recursive: true });
    mkdirSync(builtinDir, { recursive: true });
    const store = createSecretStore({ home, env: {}, backend: "memory" });
    await store.set("SOME_KEY", STORED);
    runtime = await createPackRuntime({
      config: { port: 0, importRoots, bindHost: "127.0.0.1", accessKey: null },
      logger: silent,
      library,
      jobs: new JobQueue({ db: jobsDb, concurrency: 1 }),
      usage,
      store,
      home,
      builtinDir,
      userDir: join(home, "packs"),
      artifactUrl: (id) => `https://store.example.test/artifacts/${id}`,
      daemonPorts: [],
    });
    return runtime;
  };
  const importOf = (rt: PackRuntime, source_path: string, kind = "image") =>
    rt.registry.call("import_artifact", { source_path, kind });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "plughive-builtin-")));
    root = join(tmp, "imports");
    outside = join(tmp, "imports-private");
    mkdirSync(join(root, "sub"), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(root, "ok.png"), PNG);
    writeFileSync(join(root, "sub", "deep.png"), PNG);
    writeFileSync(join(root, "notes.txt"), "plain text");
    writeFileSync(join(outside, "private.png"), PNG);
    library = new Library({ root: join(tmp, "data"), baseUrl: "http://127.0.0.1:0" });
    usage = new UsageLedger({ root: join(tmp, "data") });
    jobsDb = new Database(join(tmp, "jobs.db"));
  });

  afterEach(async () => {
    await runtime?.loader.close();
    await runtime?.packMounts.stop();
    runtime = undefined;
    library.close();
    usage.close();
    jobsDb.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it("import_artifact is off until an import root is configured", async () => {
    const rt = await boot([]);
    expect(await importOf(rt, join(root, "ok.png"))).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("PLUGHIVE_IMPORT_ROOTS") },
    });
    expect(library.count()).toBe(0);
  });

  it("imports audio files as audio, with their type", async () => {
    writeFileSync(join(root, "song.mp3"), Buffer.from("ID3fake"));
    writeFileSync(join(root, "voice.m4a"), Buffer.from("fake"));
    const rt = await boot([root]);
    expect(await importOf(rt, join(root, "song.mp3"), "audio")).toMatchObject({
      ok: true,
      result: { artifact: { id: expect.stringMatching(/^aud_/), mime: "audio/mpeg" } },
    });
    expect(await importOf(rt, join(root, "voice.m4a"), "audio")).toMatchObject({
      ok: true,
      result: { artifact: { id: expect.stringMatching(/^aud_/), mime: "audio/mp4" } },
    });
    expect(await importOf(rt, join(root, "song.mp3"), "image")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("the file is audio, not an image") },
    });
  });

  itSymlink("imports a file inside a root and hands back the host's URL", async () => {
    const rt = await boot([root]);
    for (const path of [
      join(root, "ok.png"),
      join(root, "sub", "deep.png"),
      join(root, "sub", "..", "ok.png"),
    ]) {
      const res = await importOf(rt, path);
      expect(res, path).toMatchObject({ ok: true, result: { artifact: { mime: "image/png" } } });
      const ref = (res as { result: { artifact: { id: string; url: string } } }).result.artifact;
      expect(ref.url).toBe(`https://store.example.test/artifacts/${ref.id}`);
    }
    expect(library.count()).toBe(3);
    // A root given through a symlink is the same directory.
    symlinkSync(root, join(tmp, "root-link"));
    const viaLink = await boot([join(tmp, "root-link")]);
    expect(await importOf(viaLink, join(root, "ok.png"))).toMatchObject({ ok: true });
  });

  itSymlink("refuses everything that leaves the roots, without naming a directory", async () => {
    symlinkSync(join(outside, "private.png"), join(root, "link.png"));
    symlinkSync(outside, join(root, "linked-dir"));
    const rt = await boot([root]);
    const refused = [
      join(outside, "private.png"),
      join(root, "..", "imports-private", "private.png"),
      join(root, "sub", "..", "..", "imports-private", "private.png"),
      join(root, "link.png"),
      join(root, "linked-dir", "private.png"),
      join(root, "missing.png"),
      join(root, "sub"),
      root,
      "ok.png",
      "./ok.png",
      "../imports/ok.png",
      `${join(root, "ok.png")}\0.png`,
      "http://127.0.0.1/ok.png",
      "http://169.254.169.254/latest/meta-data/x.png",
      `file://${join(root, "ok.png")}`,
      "/etc/hosts",
    ];
    for (const path of refused) {
      const res = await importOf(rt, path);
      expect(res, path).toMatchObject({ ok: false });
      const message = JSON.stringify(res);
      expect(message, path).not.toContain(outside);
      expect(message, path).not.toContain(tmp);
    }
    expect(library.count()).toBe(0);

    expect(await importOf(rt, join(root, "notes.txt"), "other")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("unsupported file type") },
    });
    expect(await importOf(rt, join(root, "ok.png"), "video")).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("not a video") },
    });
    for (const args of [
      {},
      { source_path: "", kind: "image" },
      { source_path: join(root, "ok.png"), kind: "exe" },
      {
        source_path: join(root, "ok.png"),
        kind: "image",
        url: "https://example.test/x.png",
      },
    ]) {
      expect(await rt.registry.call("import_artifact", args)).toMatchObject({
        ok: false,
        error: { code: "INVALID_ARGUMENTS" },
      });
    }
    expect(library.count()).toBe(0);
  });

  // L4: no absolute path reaches a client.
  it("import_artifact and list_artifacts report a file name, never a path", async () => {
    const rt = await boot([root]);
    const imported = await importOf(rt, join(root, "ok.png"));
    const listed = await rt.registry.call("list_artifacts", {});
    for (const out of [imported, listed]) {
      const text = JSON.stringify(out);
      expect(text).not.toContain(tmp);
      expect(text).not.toContain('"path"');
    }
    const row = (listed as { result: { artifacts: { id: string; name: string }[] } }).result
      .artifacts[0];
    expect(row?.name).toMatch(/^[\w.-]+\.png$/);
    expect((imported as { result: { artifact: { name: string } } }).result.artifact.name).toBe(
      row?.name,
    );
  });

  // L5: the copy reads the descriptor that was checked, not the path again.
  itSymlink("a path swapped for a symlink after the check is not followed", async () => {
    const source = join(root, "sub", "deep.png");
    // Swap a directory on the path for a symlink to the private folder.
    const swapDir = () => {
      renameSync(join(root, "sub"), join(root, "sub-moved"));
      mkdirSync(join(outside, "sub-evil"), { recursive: true });
      writeFileSync(join(outside, "sub-evil", "deep.png"), "PRIVATE BYTES");
      symlinkSync(join(outside, "sub-evil"), join(root, "sub"));
    };
    await expect(openImportSource(source, [root], swapDir)).rejects.toThrow(
      /must resolve to an existing regular file inside the import roots/,
    );
    rmSync(join(root, "sub"));
    renameSync(join(root, "sub-moved"), join(root, "sub"));

    // And once opened, the library is handed the descriptor: a swap during the copy reads the original.
    const copied: string[] = [];
    const [, importTool] = artifactTools({
      importRoots: [root],
      urlFor: (id) => `https://store.example.test/artifacts/${id}`,
      library: {
        list: () => [],
        async importHandle(_row, handle) {
          rmSync(source);
          writeFileSync(join(outside, "private.png"), "PRIVATE BYTES");
          symlinkSync(join(outside, "private.png"), source);
          copied.push((await handle.readFile()).toString("hex"));
          return { id: "art_1", path: "/somewhere/private/art_1.png", url: "", mime: "image/png" };
        },
      },
    });
    const out = (await importTool?.run({ source_path: source, kind: "image" }, {})) as {
      artifact: Record<string, unknown>;
    };
    expect(copied).toEqual([PNG.toString("hex")]);
    expect(readFileSync(join(outside, "private.png")).toString("hex")).not.toBe(copied[0]);
    expect(out.artifact).toEqual({
      id: "art_1",
      name: "art_1.png",
      url: "https://store.example.test/artifacts/art_1",
      mime: "image/png",
    });
  });

  it("resolveImportSource and isInside treat a sibling with the same prefix as outside", () => {
    expect(isInside(root, join(root, "ok.png"))).toBe(true);
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, outside)).toBe(false);
    expect(isInside(root, join(root, "..", "imports-private"))).toBe(false);
    expect(resolveImportSource(join(root, "ok.png"), [join(tmp, "nope"), root])).toBe(
      join(root, "ok.png"),
    );
    expect(() => resolveImportSource(join(outside, "private.png"), [root])).toThrow(
      /outside the configured import roots/,
    );
    expect(() => resolveImportSource(join(root, "ok.png"), [])).toThrow(/importing is off/);
  });

  // L5: the extension is taken from the file the descriptor opened, not from an
  // earlier resolution of the same path.
  itSymlink(
    "a source swapped between the check and the open is not imported under the old type",
    async () => {
      symlinkSync(join(root, "ok.png"), join(root, "link"));
      // The first pass over the import roots retargets the link; the old code
      // resolved the path once more for the open and copied the new target under
      // the old extension.
      let swapped = false;
      const swap = () => {
        rmSync(join(root, "link"));
        symlinkSync(join(root, "notes.txt"), join(root, "link"));
      };
      const roots = new Proxy([root] as readonly string[], {
        get(t, p) {
          if (p === Symbol.iterator) {
            return function* () {
              if (!swapped) {
                swapped = true;
                swap();
              }
              yield* t as string[];
            };
          }
          return Reflect.get(t, p);
        },
      });
      const copied: string[] = [];
      const [, importTool] = artifactTools({
        importRoots: roots,
        urlFor: (id) => `https://store.example.test/artifacts/${id}`,
        library: {
          list: () => [],
          async importHandle(_row, handle) {
            copied.push((await handle.readFile()).toString("hex"));
            return { id: "art_1", path: "/x/art_1.png", url: "", mime: "image/png" };
          },
        },
      });
      const out = (await importTool?.run(
        { source_path: join(root, "link"), kind: "image" },
        {},
      )) as {
        artifact: Record<string, unknown>;
      };
      // The descriptor was opened at the path that was checked: the PNG bytes.
      expect(copied).toEqual([PNG.toString("hex")]);
      expect(out.artifact).toMatchObject({ mime: "image/png" });
      rmSync(join(root, "link"));
    },
  );

  it("a job view carries no arguments, and get_job_status validates the id", async () => {
    const rt = await boot([]);
    const view = jobView({
      id: "job_1",
      tool: "core.tool_call",
      status: "running",
      input: { tool: "some_tool", arguments: { prompt: "private prompt text" } },
      checkpoint: { progress_message: "half" },
      progress: 0.5,
      result: null,
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    } as never);
    expect(view).toMatchObject({ job_id: "job_1", tool: "some_tool", message: "half" });
    expect(JSON.stringify(view)).not.toContain("private prompt text");
    const done = jobView({
      id: "job_2",
      tool: "separate_stems",
      status: "succeeded",
      input: {},
      checkpoint: { progress_message: "saving vocals" },
      progress: 0.96,
      result: { artifacts: [] },
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    } as never);
    expect(done).toMatchObject({ status: "succeeded", progress: 1, message: null });
    const install = jobView({
      id: "job_3",
      tool: "system.install_software",
      status: "running",
      input: { id: "ffmpeg" },
      checkpoint: {},
      progress: null,
      result: null,
      error: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:01.000Z",
    } as never);
    expect(install.tool).toBe("install_software");

    expect(
      await rt.registry.call("get_job_status", { job_id: "job_does_not_exist" }),
    ).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("not found") },
    });
    for (const job_id of ["../../etc", "a b", "", "x".repeat(65)]) {
      expect(await rt.registry.call("get_job_status", { job_id })).toMatchObject({
        ok: false,
        error: { code: "INVALID_ARGUMENTS" },
      });
    }
  });

  it("gateway_status and usage_report show no secret value and are not metered", async () => {
    const rt = await boot([root]);
    const status = await rt.registry.call("gateway_status", {});
    expect(status).toMatchObject({ ok: true, result: { auth_required: false, import_roots: 1 } });
    expect(JSON.stringify(status)).not.toContain(STORED);
    expect(JSON.stringify(status)).not.toContain(root);
    await rt.registry.call("list_artifacts", {});
    const report = await rt.registry.call("usage_report", {});
    expect(report).toMatchObject({ ok: true });
    const text = JSON.stringify(report);
    expect(text).toContain("list_artifacts");
    expect(text).not.toContain("gateway_status");
    expect(text).not.toContain(STORED);
  });
});
