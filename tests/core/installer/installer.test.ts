import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVAL_SIZE_MB,
  type Catalog,
  DOWNLOAD_HOSTS,
  loadCatalog,
  pickMethod,
  platformKey,
} from "../../../src/core/installer/catalog.js";
import { unsafeEntry } from "../../../src/core/installer/extract.js";
import { InstallError, Installer } from "../../../src/core/installer/installer.js";
import { LOCK_NAME, readLock, updateLock } from "../../../src/core/installer/lockfile.js";
import { type PackHost, createPackContext } from "../../../src/core/packs/context.js";
import { parseManifest } from "../../../src/core/packs/manifest.js";
import { createSecretStore } from "../../../src/core/secrets/index.js";
import { JobQueue } from "../../../src/lib/jobs.js";
import { canSymlink, itSymlink } from "../../support/platform.js";

// A switch that makes the installer's symlink fail as on a filesystem without symlinks.
const noSymlinks = vi.hoisted(() => ({ on: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    symlink: (...args: Parameters<typeof real.symlink>) => {
      if (!noSymlinks.on) return real.symlink(...args);
      return Promise.reject(
        Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" }),
      );
    },
  };
});

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const sha256 = (b: string | Buffer) => createHash("sha256").update(b).digest("hex");
const posix = process.platform !== "win32";

describe("catalog", () => {
  const catalog = loadCatalog();

  it("parses, with unique ids", () => {
    expect(catalog.items.length).toBeGreaterThan(10);
    expect(new Set(catalog.items.map((i) => i.id)).size).toBe(catalog.items.length);
  });

  it("pins every download: https on a GitHub release host with a sha256", () => {
    for (const item of catalog.items) {
      for (const src of Object.values(item.sources ?? {})) {
        const url = new URL(src.archive.url);
        expect(url.protocol).toBe("https:");
        expect(DOWNLOAD_HOSTS as readonly string[]).toContain(url.hostname);
        expect(src.archive.sha256).toMatch(/^[0-9a-f]{64}$/);
        for (const part of src.extra ?? []) {
          expect(DOWNLOAD_HOSTS as readonly string[]).toContain(new URL(part.url).hostname);
          expect(part.sha256).toMatch(/^[0-9a-f]{64}$/);
        }
      }
      if (item.uv) expect(item.uv.package).toMatch(/==/);
    }
  });

  it("refuses an unpinned uv package, a non-GitHub download and a bad sha", () => {
    const base = catalog.items.find((i) => i.id === "yt-dlp");
    expect(base).toBeDefined();
    const bad = (patch: Record<string, unknown>) =>
      expect(() => loadCatalog({ schema: 1, items: [{ ...base, ...patch }] })).toThrow();
    bad({ uv: { package: "yt-dlp", python: "3.12" } });
    bad({ uv: { package: "yt-dlp==1", python: "3.12", with: ["numpy"] } });
    bad({
      sources: {
        "linux-x64": {
          archive: {
            url: "https://example.com/x",
            sha256: "0".repeat(64),
            format: "raw",
            bin: { "yt-dlp": "x" },
          },
        },
      },
    });
    bad({
      sources: {
        "linux-x64": {
          archive: {
            url: "https://github.com/a/b/releases/download/1/x",
            sha256: "abc",
            format: "raw",
            bin: { "yt-dlp": "x" },
          },
        },
      },
    });
    bad({
      sources: {
        "linux-x64": {
          archive: {
            url: "https://github.com/a/b/releases/download/1/x",
            sha256: "0".repeat(64),
            format: "tar.gz",
            bin: { "yt-dlp": "../../etc/passwd" },
          },
        },
      },
    });
  });

  it("never runs apt: it becomes a command for the user", () => {
    const magick = catalog.items.find((i) => i.id === "imagemagick");
    expect(magick).toBeDefined();
    if (!magick) return;
    const none = { hasBrew: false, hasWinget: false, hasApt: false };
    expect(pickMethod(magick, "linux-x64", { ...none, hasApt: true })).toMatchObject({
      kind: "apt",
      command: expect.stringContaining("apt install"),
    });
    expect(pickMethod(magick, "darwin-arm64", { ...none, hasBrew: true }).kind).toBe("brew");
    expect(pickMethod(magick, "darwin-arm64", none).kind).toBe("link");
  });

  it("prefers a pinned download over a package manager, with ffprobe as an extra file", () => {
    const ffmpeg = catalog.items.find((i) => i.id === "ffmpeg");
    if (!ffmpeg) throw new Error("ffmpeg missing");
    const all = { hasBrew: true, hasWinget: true, hasApt: true };
    for (const key of [
      "darwin-arm64",
      "darwin-x64",
      "linux-x64",
      "linux-arm64",
      "win32-x64",
    ] as const) {
      const m = pickMethod(ffmpeg, key, all);
      expect(m.kind).toBe("archive");
      if (m.kind !== "archive") continue;
      expect(m.extra.flatMap((e) => Object.keys(e.bin))).toEqual(["ffprobe"]);
    }
    const pandoc = catalog.items.find((i) => i.id === "pandoc");
    if (!pandoc) throw new Error("pandoc missing");
    expect(pickMethod(pandoc, "win32-x64", all)).toMatchObject({
      kind: "archive",
      archive: { format: "zip", bin: { pandoc: "pandoc-3.14/pandoc.exe" } },
    });
  });

  it("refuses an extra file that is not raw, or a program listed twice", () => {
    const base = catalog.items.find((i) => i.id === "ffmpeg");
    const src = base?.sources?.["linux-x64"];
    if (!base || !src) throw new Error("ffmpeg linux source missing");
    const bad = (patch: Record<string, unknown>) =>
      expect(() =>
        loadCatalog({
          schema: 1,
          items: [{ ...base, sources: { "linux-x64": { ...src, ...patch } } }],
        }),
      ).toThrow();
    bad({ extra: [{ ...src.archive, format: "zip" }] });
    bad({ extra: [src.archive] });
  });

  it("pins every model file to a Hugging Face commit with a sha256, and refuses anything else", () => {
    const models = catalog.items.filter((i) => i.model);
    expect(models.map((m) => m.id)).toEqual(
      expect.arrayContaining(["whisper-model-base", "whisper-model-large-v3-turbo"]),
    );
    for (const m of models) {
      expect(m.model?.url).toMatch(/^https:\/\/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\//);
      expect(m.model?.url.endsWith(`/${m.model?.file}`)).toBe(true);
      expect(
        pickMethod(m, "win32-x64", { hasBrew: true, hasWinget: true, hasApt: true }).kind,
      ).toBe("model");
    }
    const base = models[0];
    const bad = (patch: Record<string, unknown>, model: Record<string, unknown> = {}) =>
      expect(() =>
        loadCatalog({
          schema: 1,
          items: [{ ...base, ...patch, model: { ...base?.model, ...model } }],
        }),
      ).toThrow();
    bad(
      {},
      { url: "https://example.com/a/b/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/x.bin" },
    );
    bad({}, { url: "https://huggingface.co/a/b/resolve/main/x.bin" });
    bad({}, { file: "../x.bin" });
    bad({}, { file: "model.exe" });
    bad({}, { dir: "../up" });
    bad({}, { sha256: "abc" });
    bad({ bins: ["x"] });
    bad({ probe: { bin: "x" } });
    // An entry that is neither a model nor probed is refused too.
    expect(() => loadCatalog({ schema: 1, items: [{ ...base, model: undefined }] })).toThrow(
      /probe/,
    );
  });

  it("refuses archive entries that leave the folder", () => {
    expect(unsafeEntry("../x")).toBe(true);
    expect(unsafeEntry("a/../../x")).toBe(true);
    expect(unsafeEntry("/etc/passwd")).toBe(true);
    expect(unsafeEntry("C:\\Windows\\x")).toBe(true);
    expect(unsafeEntry("bin/tool")).toBe(false);
  });
});

/** A one-file "program" that prints its version, as a raw download. */
const PROGRAM = "#!/bin/sh\necho demo-tool 1.2.3\n";

function demoCatalog(sha: string, extra: Record<string, unknown> = {}): Catalog {
  const key = platformKey();
  if (!key) throw new Error("unsupported test platform");
  return loadCatalog({
    schema: 1,
    items: [
      {
        id: "demo-tool",
        name: "Demo Tool",
        summary: "A test program.",
        version: "1.2.3",
        license: "MIT",
        size_mb: 1,
        gated: false,
        homepage: "https://example.com/demo",
        tags: ["test"],
        bins: ["demo-tool"],
        probe: { bin: "demo-tool", args: ["--version"], version: "demo-tool (\\S+)" },
        sources: {
          [key]: {
            archive: {
              url: "https://github.com/example/demo/releases/download/v1.2.3/demo-tool",
              sha256: sha,
              format: "raw",
              bin: { "demo-tool": "demo-tool" },
            },
          },
        },
        ...extra,
      },
      {
        id: "big-tool",
        name: "Big Tool",
        summary: "A large download.",
        version: "1.0.0",
        license: "Apache-2.0",
        size_mb: APPROVAL_SIZE_MB + 1,
        gated: false,
        homepage: "https://example.com/big",
        bins: ["big-tool"],
        probe: { bin: "big-tool", args: ["--version"] },
        sources: {
          [key]: {
            archive: {
              url: "https://github.com/example/big/releases/download/v1/big-tool",
              sha256: "0".repeat(64),
              format: "raw",
              bin: { "big-tool": "big-tool" },
            },
          },
        },
      },
    ],
  });
}

describe.skipIf(!posix)("installer", () => {
  let home: string;
  let db: Database.Database;
  let jobs: JobQueue;
  const served = { body: PROGRAM, hits: 0, byUrl: {} as Record<string, string> };
  const fetcher = async (url: string) => {
    served.hits++;
    expect(url).toMatch(/^https:\/\/github\.com\//);
    return new Response(served.byUrl[url] ?? served.body, { status: 200 });
  };

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "plughive-inst-")));
    db = new Database(join(home, "jobs.db"));
    jobs = new JobQueue({ db, concurrency: 1 });
    served.body = PROGRAM;
    served.hits = 0;
    served.byUrl = {};
  });
  afterEach(() => {
    jobs.stopWorker();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const make = (catalog: Catalog) =>
    new Installer({
      home,
      logger: silent,
      jobs,
      catalog,
      fetch: fetcher,
      searchDirs: [],
      packageManagers: { hasBrew: false, hasWinget: false, hasApt: false },
    });

  const finish = async (jobId: string) => {
    jobs.startWorker({ intervalMs: 10 });
    for (let i = 0; i < 400; i++) {
      const job = jobs.get(jobId);
      if (job && ["succeeded", "failed", "cancelled", "expired"].includes(job.status)) return job;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error("job did not finish");
  };

  it("installs a pinned download as a job: folder, shim, lock with sha256", async () => {
    const installer = make(demoCatalog(sha256(PROGRAM)));
    const start = await installer.startInstall("demo-tool");
    expect(start.status).toBe("started");
    if (start.status !== "started") return;
    const job = await finish(start.job_id);
    expect(job.status).toBe("succeeded");

    const target = join(home, "tools", "demo-tool", "1.2.3", "demo-tool");
    expect(readFileSync(target, "utf8")).toBe(PROGRAM);
    expect(lstatSync(join(home, "tools", "bin", "demo-tool")).isSymbolicLink()).toBe(canSymlink());
    const lock = readLock(join(home, "tools"));
    expect(lock.items["demo-tool"]).toMatchObject({
      version: "1.2.3",
      method: "archive",
      source_sha256: sha256(PROGRAM),
      bins: { "demo-tool": { target: "demo-tool/1.2.3/demo-tool", sha256: sha256(PROGRAM) } },
    });
    const status = await installer.statusOf("demo-tool");
    expect(status).toMatchObject({ installed: true, managed: true, detected_version: "1.2.3" });
    // Installed already: a second request does not download again.
    expect(await installer.startInstall("demo-tool")).toMatchObject({
      status: "already_installed",
    });
    expect(served.hits).toBe(1);
  });

  it("refuses a download whose sha256 does not match and installs nothing", async () => {
    const installer = make(demoCatalog(sha256(PROGRAM)));
    served.body = `${PROGRAM}echo tampered\n`;
    const start = await installer.startInstall("demo-tool");
    if (start.status !== "started") throw new Error(`unexpected ${start.status}`);
    const job = await finish(start.job_id);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("did not match its pinned sha256");
    expect(existsSync(join(home, "tools", "demo-tool"))).toBe(false);
    expect(existsSync(join(home, "tools", "bin", "demo-tool"))).toBe(false);
    expect(readLock(join(home, "tools")).items["demo-tool"]).toBeUndefined();
    // No staging left behind.
    const staging = join(home, "tools", ".staging");
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
  });

  const PROBE2 = "#!/bin/sh\necho demo-probe 1.2.3\n";
  const EXTRA_URL = "https://github.com/example/demo/releases/download/v1.2.3/demo-probe";
  const withExtra = (extraSha: string) => {
    const key = platformKey();
    if (!key) throw new Error("unsupported test platform");
    return demoCatalog(sha256(PROGRAM), {
      bins: ["demo-tool", "demo-probe"],
      sources: {
        [key]: {
          archive: {
            url: "https://github.com/example/demo/releases/download/v1.2.3/demo-tool",
            sha256: sha256(PROGRAM),
            format: "raw",
            bin: { "demo-tool": "demo-tool" },
          },
          extra: [
            {
              url: EXTRA_URL,
              sha256: extraSha,
              format: "raw",
              bin: { "demo-probe": "demo-probe" },
            },
          ],
        },
      },
    });
  };

  it("installs extra raw files next to the main one, each checked and shimmed", async () => {
    served.byUrl[EXTRA_URL] = PROBE2;
    const installer = make(withExtra(sha256(PROBE2)));
    const start = await installer.startInstall("demo-tool");
    if (start.status !== "started") throw new Error(`unexpected ${start.status}`);
    const job = await finish(start.job_id);
    expect(job.error).toBeFalsy();
    expect(job.status).toBe("succeeded");
    const dir = join(home, "tools", "demo-tool", "1.2.3");
    expect(readFileSync(join(dir, "demo-probe"), "utf8")).toBe(PROBE2);
    expect(existsSync(join(home, "tools", "bin", "demo-probe"))).toBe(true);
    const lock = readLock(join(home, "tools")).items["demo-tool"];
    expect(Object.keys(lock?.bins ?? {}).sort()).toEqual(["demo-probe", "demo-tool"]);
    expect(lock?.bins["demo-probe"]?.sha256).toBe(sha256(PROBE2));
    expect(served.hits).toBe(2);
  });

  it("refuses the whole install when an extra file does not match its sha256", async () => {
    served.byUrl[EXTRA_URL] = `${PROBE2}echo tampered\n`;
    const installer = make(withExtra(sha256(PROBE2)));
    const start = await installer.startInstall("demo-tool");
    if (start.status !== "started") throw new Error(`unexpected ${start.status}`);
    const job = await finish(start.job_id);
    expect(job.status).toBe("failed");
    expect(job.error).toContain("did not match its pinned sha256");
    expect(existsSync(join(home, "tools", "demo-tool"))).toBe(false);
    expect(existsSync(join(home, "tools", "bin", "demo-tool"))).toBe(false);
    expect(readLock(join(home, "tools")).items["demo-tool"]).toBeUndefined();
  });

  it("asks for approval for a large install unless approved, and refuses unknown ids", async () => {
    const installer = make(demoCatalog(sha256(PROGRAM)));
    const start = await installer.startInstall("big-tool");
    expect(start).toMatchObject({
      status: "approval_required",
      approval_path: "/software?install=big-tool",
      size_mb: APPROVAL_SIZE_MB + 1,
    });
    expect(served.hits).toBe(0);
    const approved = await installer.startInstall("big-tool", { approved: true });
    expect(approved.status).toBe("started");
    await expect(installer.startInstall("nope")).rejects.toBeInstanceOf(InstallError);
  });

  it("installs a uv tool with its pinned --with packages before the package", async () => {
    const uvDir = join(home, "uv-on-path");
    mkdirSync(uvDir);
    writeFileSync(join(uvDir, "uv"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const calls: string[][] = [];
    const installer = new Installer({
      home,
      logger: silent,
      jobs,
      catalog: loadCatalog({
        schema: 1,
        items: [
          {
            id: "py-tool",
            name: "Py Tool",
            summary: "A Python tool.",
            version: "4.1.0",
            license: "MIT",
            size_mb: 10,
            gated: false,
            homepage: "https://example.com/py",
            bins: ["py-tool"],
            probe: { bin: "py-tool", args: ["--help"], expect: "usage" },
            uv: { package: "py-tool==4.1.0", python: "3.11", with: ["numpy==2.3.5"] },
          },
        ],
      }),
      fetch: fetcher,
      searchDirs: [uvDir],
      packageManagers: { hasBrew: false, hasWinget: false, hasApt: false },
      runCommand: async (_file, args, opts) => {
        calls.push([...args]);
        const binDir = opts.env.UV_TOOL_BIN_DIR as string;
        mkdirSync(binDir, { recursive: true });
        writeFileSync(join(binDir, "py-tool"), "#!/bin/sh\necho usage\n", { mode: 0o755 });
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      probeRun: async () => ({ stdout: "usage: py-tool", stderr: "", exitCode: 0 }),
    });
    expect(installer.item("py-tool")).toBeDefined();
    await installer.install(installer.item("py-tool"));
    expect(calls).toEqual([
      [
        "tool",
        "install",
        "--python",
        "3.11",
        "--force",
        "--with",
        "numpy==2.3.5",
        "py-tool==4.1.0",
      ],
    ]);
    expect(readLock(join(home, "tools")).items["py-tool"]).toMatchObject({ method: "uv" });
  });

  it("uninstalls what it installed: folder, shim and lock entry", async () => {
    const installer = make(demoCatalog(sha256(PROGRAM)));
    await installer.install(installer.item("demo-tool"));
    expect(await installer.uninstall("demo-tool")).toMatchObject({ status: "removed" });
    expect(existsSync(join(home, "tools", "demo-tool"))).toBe(false);
    expect(existsSync(join(home, "tools", "bin", "demo-tool"))).toBe(false);
    expect(readLock(join(home, "tools")).items["demo-tool"]).toBeUndefined();
    await expect(installer.uninstall("demo-tool")).rejects.toMatchObject({ code: "not_installed" });
  });

  it("two installs running at once both land in lock.json", async () => {
    const key = platformKey();
    if (!key) throw new Error("unsupported test platform");
    const item = (id: string) => ({
      id,
      name: id,
      summary: "A test program.",
      version: "1.2.3",
      license: "MIT",
      size_mb: 1,
      gated: false,
      homepage: "https://example.com/demo",
      tags: ["test"],
      bins: [id],
      probe: { bin: id, args: ["--version"], version: "demo-tool (\\S+)" },
      sources: {
        [key]: {
          archive: {
            url: `https://github.com/example/demo/releases/download/v1/${id}`,
            sha256: sha256(PROGRAM),
            format: "raw",
            bin: { [id]: id },
          },
        },
      },
    });
    const installer = make(
      loadCatalog({ schema: 1, items: [item("demo-tool"), item("second-tool")] }),
    );
    await Promise.all([
      installer.install(installer.item("demo-tool")),
      installer.install(installer.item("second-tool")),
    ]);
    const lock = readLock(join(home, "tools"));
    expect(Object.keys(lock.items).sort()).toEqual(["demo-tool", "second-tool"]);
    expect(lock.items["second-tool"]?.bins["second-tool"]?.sha256).toBe(sha256(PROGRAM));
  });

  describe("without symlinks the shim is a copy, still checked against the lock", () => {
    beforeEach(() => {
      noSymlinks.on = true;
    });
    afterEach(() => {
      noSymlinks.on = false;
    });

    it("installs, runs, refuses a tampered copy and uninstalls", async () => {
      const installer = make(demoCatalog(sha256(PROGRAM)));
      await installer.install(installer.item("demo-tool"));
      const shim = join(home, "tools", "bin", "demo-tool");
      const st = lstatSync(shim);
      expect(st.isSymbolicLink()).toBe(false);
      expect(st.isFile()).toBe(true);
      expect(st.mode & 0o111).not.toBe(0);
      expect(readFileSync(shim, "utf8")).toBe(PROGRAM);

      mkdirSync(join(home, "packdata"));
      const ctx = () =>
        createPackContext({
          manifest: parseManifest({
            id: "demo",
            name: "Demo",
            version: "0.1.0",
            apiVersion: 1,
            permissions: { spawn: ["demo-tool"] },
          }),
          dataDir: join(home, "packdata"),
          settings: {},
          host: {
            store: createSecretStore({ home, env: {}, backend: "memory" }),
            logger: silent,
            spawnPath: "/usr/bin:/bin",
            trustedTools: installer.trustedTools(),
          },
        });
      const { base, binaries } = ctx();
      expect(binaries.get("demo-tool")).toBe(shim);
      expect((await base.spawn("demo-tool", ["--version"])).stdout).toContain("demo-tool 1.2.3");

      appendFileSync(shim, "echo pwned\n");
      await expect(ctx().base.spawn("demo-tool", ["--version"])).rejects.toMatchObject({
        code: "not_started",
        message: expect.stringContaining("integrity check"),
      });

      expect(await installer.uninstall("demo-tool")).toMatchObject({ status: "removed" });
      expect(existsSync(shim)).toBe(false);
    });
  });

  describe("spawn trusts tools/bin only while the lock matches", () => {
    let installer: Installer;
    let host: PackHost;
    const ctx = () =>
      createPackContext({
        manifest: parseManifest({
          id: "demo",
          name: "Demo",
          version: "0.1.0",
          apiVersion: 1,
          permissions: { spawn: ["demo-tool"] },
        }),
        dataDir: join(home, "packdata"),
        settings: {},
        host,
      });

    beforeEach(async () => {
      installer = make(demoCatalog(sha256(PROGRAM)));
      await installer.install(installer.item("demo-tool"));
      mkdirSync(join(home, "packdata"));
      host = {
        store: createSecretStore({ home, env: {}, backend: "memory" }),
        logger: silent,
        // Nothing else on PATH: the program is only reachable through tools/bin.
        spawnPath: "/usr/bin:/bin",
        trustedTools: installer.trustedTools(),
      };
    });

    it("runs the installed program", async () => {
      const { base, binaries } = ctx();
      // The shim is a symlink to the program, or (no symlink rights) a copy of it.
      expect(binaries.get("demo-tool")).toBe(realpathSync(join(home, "tools", "bin", "demo-tool")));
      const out = await base.spawn("demo-tool", ["--version"]);
      expect(out.stdout).toContain("demo-tool 1.2.3");
    });

    it("programDir is the install folder from the lock, not tools/bin", () => {
      const { base } = ctx();
      const lock = JSON.parse(readFileSync(join(home, "tools", LOCK_NAME), "utf8"));
      const target: string = lock.items["demo-tool"].bins["demo-tool"].target;
      expect(base.programDir("demo-tool")).toBe(
        join(realpathSync(join(home, "tools")), dirname(target)),
      );
      expect(base.programDir("demo-tool")).not.toBe(realpathSync(join(home, "tools", "bin")));
    });

    it("refuses a program that changed after it was installed", async () => {
      const { base } = ctx();
      appendFileSync(realpathSync(join(home, "tools", "bin", "demo-tool")), "echo pwned\n");
      await expect(base.spawn("demo-tool", ["--version"])).rejects.toMatchObject({
        code: "not_started",
        message: expect.stringContaining("integrity check"),
      });
    });

    it("refuses when the lock file was edited", async () => {
      const { base } = ctx();
      const lockPath = join(home, "tools", LOCK_NAME);
      const lock = JSON.parse(readFileSync(lockPath, "utf8"));
      lock.items["demo-tool"].bins["demo-tool"].sha256 = "f".repeat(64);
      writeFileSync(lockPath, JSON.stringify(lock));
      await expect(base.spawn("demo-tool", ["--version"])).rejects.toMatchObject({
        code: "not_started",
      });
    });

    itSymlink("does not trust a shim repointed outside the item folder", async () => {
      const elsewhere = join(home, "evil");
      writeFileSync(elsewhere, PROGRAM, { mode: 0o755 });
      rmSync(join(home, "tools", "bin", "demo-tool"));
      symlinkSync(elsewhere, join(home, "tools", "bin", "demo-tool"));
      const { binaries } = ctx();
      expect(binaries.get("demo-tool")).toBeNull();
    });

    it("sees a reinstall without a daemon restart", async () => {
      const { binaries } = ctx();
      expect(binaries.get("demo-tool")).not.toBeNull();
      await installer.uninstall("demo-tool");
      expect(binaries.get("demo-tool")).toBeNull();
    });
  });
});

describe("model files", () => {
  let home: string;
  let db: Database.Database;
  let jobs: JobQueue;
  const MODEL = Buffer.from("ggml fake model bytes");
  const URL_ =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/5359861c739e955e79d9a303bcbc70fb988958b1/ggml-tiny.bin";
  const served = { body: MODEL as Buffer | string, urls: [] as string[] };
  const fetcher = async (url: string) => {
    served.urls.push(url);
    return new Response(served.body, { status: 200 });
  };
  const catalog = (sha = sha256(MODEL), size_mb = 78) =>
    loadCatalog({
      schema: 1,
      items: [
        {
          id: "whisper-model-tiny",
          name: "Whisper tiny model",
          summary: "A test model.",
          version: "5359861",
          license: "MIT",
          size_mb,
          gated: false,
          homepage: "https://huggingface.co/ggerganov/whisper.cpp",
          bins: [],
          model: { url: URL_, sha256: sha, file: "ggml-tiny.bin", pack: "local", dir: "models" },
        },
      ],
    });
  const make = (c: Catalog) =>
    new Installer({
      home,
      logger: silent,
      jobs,
      catalog: c,
      fetch: fetcher,
      searchDirs: [],
      packageManagers: { hasBrew: false, hasWinget: false, hasApt: false },
    });
  const target = () => join(home, "pack-data", "local", "models", "ggml-tiny.bin");

  beforeEach(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), "plughive-model-")));
    db = new Database(join(home, "jobs.db"));
    jobs = new JobQueue({ db, concurrency: 1 });
    served.body = MODEL;
    served.urls = [];
  });
  afterEach(() => {
    jobs.stopWorker();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  it("saves the checked file into the pack's data folder and records it in the lock", async () => {
    const installer = make(catalog());
    expect(await installer.statusOf("whisper-model-tiny")).toMatchObject({
      method: "model",
      installed: false,
      managed: false,
    });
    await installer.install(installer.item("whisper-model-tiny"));
    expect(served.urls).toEqual([URL_]);
    expect(readFileSync(target())).toEqual(MODEL);
    expect(readLock(join(home, "tools")).items["whisper-model-tiny"]).toMatchObject({
      method: "model",
      version: "5359861",
      source_sha256: sha256(MODEL),
      bins: {},
      file: join("pack-data", "local", "models", "ggml-tiny.bin"),
    });
    expect(await installer.statusOf("whisper-model-tiny")).toMatchObject({
      installed: true,
      managed: true,
      detected_version: "5359861",
    });
    // No staging left behind, and nothing placed under tools/bin.
    const staging = join(home, "tools", ".staging");
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
    expect(existsSync(join(home, "tools", "bin", "ggml-tiny.bin"))).toBe(false);
  });

  it("refuses a file whose sha256 does not match and places nothing", async () => {
    const installer = make(catalog());
    served.body = "something else";
    await expect(installer.install(installer.item("whisper-model-tiny"))).rejects.toThrow(
      /did not match its pinned sha256/,
    );
    expect(existsSync(target())).toBe(false);
    expect(readLock(join(home, "tools")).items["whisper-model-tiny"]).toBeUndefined();
  });

  it("asks before a large model, like any large install", async () => {
    const installer = make(catalog(sha256(MODEL), APPROVAL_SIZE_MB + 374));
    expect(await installer.startInstall("whisper-model-tiny")).toMatchObject({
      status: "approval_required",
    });
    expect(served.urls).toEqual([]);
  });

  it("uninstalls a model it placed, and leaves a file it did not place to the user", async () => {
    const installer = make(catalog());
    await installer.install(installer.item("whisper-model-tiny"));
    expect(await installer.uninstall("whisper-model-tiny")).toMatchObject({ status: "removed" });
    expect(existsSync(target())).toBe(false);
    expect(readLock(join(home, "tools")).items["whisper-model-tiny"]).toBeUndefined();

    // A file the user put there themselves: found, not managed, never deleted by us.
    mkdirSync(join(home, "pack-data", "local", "models"), { recursive: true });
    writeFileSync(target(), "user model");
    expect(await installer.statusOf("whisper-model-tiny")).toMatchObject({
      installed: true,
      managed: false,
    });
    expect(await installer.uninstall("whisper-model-tiny")).toMatchObject({ status: "manual" });
    expect(readFileSync(target(), "utf8")).toBe("user model");
  });
});

describe("lock file updates", () => {
  it("serializes concurrent read-modify-write cycles in this process", async () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "plughive-lockfile-")));
    try {
      await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          updateLock(root, (lock) => {
            lock.items[`item-${i}`] = {
              version: "1",
              method: "uv",
              installed_at: "now",
              bins: {},
            };
          }),
        ),
      );
      expect(Object.keys(readLock(root).items)).toHaveLength(20);
      // The temp file is created exclusively: no two writers share one name.
      expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
