// Kernel pieces added for the cli-bridge pack: folder-list settings (an
// absolute spawn cwd inside a folder the user listed), killTree (a timeout or
// cancel kills the child's helpers too), the manifest notice and opt-in
// capability providers.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SpawnOptions } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it } from "vitest";
import {
  CapabilityRouter,
  type ProviderBinding,
  setCapabilityPreference,
} from "../../../src/core/capabilities/router.js";
import { spawnRootEntry } from "../../../src/core/packs/context.js";
import {
  PackLoader,
  consentItems,
  manifestConsentHash,
  spawnRootsFromSettings,
} from "../../../src/core/packs/loader.js";
import { type PackManifest, parseManifest } from "../../../src/core/packs/manifest.js";
import { createSecretStore } from "../../../src/core/secrets/index.js";
import { ToolRegistry } from "../../../src/core/tools/registry.js";
import { fakeBinary, itPosix } from "../../support/platform.js";

const base = { id: "demo", name: "Demo", version: "0.1.0", apiVersion: 1 };
const harnesses: TestContext[] = [];
const tmps: string[] = [];

function tmp(prefix = "plughive-roots-"): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  tmps.push(d);
  return d;
}

function harness(opts: Parameters<typeof createTestContext>[0]): TestContext {
  const t = createTestContext(opts);
  harnesses.push(t);
  return t;
}

afterEach(async () => {
  for (const t of harnesses.splice(0)) await t.dispose();
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const folderManifest = (spawn: string[] = ["tool"]) => ({
  ...base,
  permissions: { spawn },
  settings: {
    type: "object",
    properties: {
      folders: { type: "array", items: { type: "string" }, format: "folder-list", default: [] },
    },
  },
});

describe('format: "folder-list" settings', () => {
  it("must be a list setting", () => {
    expect(() =>
      parseManifest({
        ...base,
        settings: { type: "object", properties: { f: { type: "string", format: "folder-list" } } },
      }),
    ).toThrow(/folder-list.*array/);
    expect(() => parseManifest(folderManifest())).not.toThrow();
  });

  it("refuses relative, missing, file, root, home and plughive home entries", () => {
    const store = tmp();
    const ok = tmp();
    const file = join(ok, "f.txt");
    writeFileSync(file, "x");
    expect(() => spawnRootEntry("relative/dir", store)).toThrow(/absolute/);
    expect(() => spawnRootEntry(join(ok, "missing"), store)).toThrow(/does not exist/);
    expect(() => spawnRootEntry(file, store)).toThrow(/not a folder/);
    expect(() => spawnRootEntry("/", store)).toThrow(/root/);
    expect(() => spawnRootEntry(homedir(), store)).toThrow(/home folder/);
    expect(() => spawnRootEntry("~", store)).toThrow(/home folder/);
    mkdirSync(join(store, "pack-data", "x"), { recursive: true });
    expect(() => spawnRootEntry(join(store, "pack-data", "x"), store)).toThrow(/plughive home/);
    expect(() => spawnRootEntry(store, store)).toThrow(/plughive home/);
    expect(spawnRootEntry(ok, store)).toBe(ok);
  });

  it("are part of the consent hash and listed as a high-risk item", () => {
    const m = parseManifest(folderManifest());
    const plain = parseManifest({ ...base, permissions: { spawn: ["tool"] } });
    expect(manifestConsentHash(m)).not.toBe(manifestConsentHash(plain));
    expect(consentItems(m).find((i) => i.kind === "folders")?.risk).toBe("high");
  });

  it("lets an absolute cwd point inside a listed folder, and nowhere else", async () => {
    const project = tmp();
    mkdirSync(join(project, "sub"));
    const other = tmp();
    const seen: SpawnOptions[] = [];
    const t = harness({
      manifest: folderManifest(),
      settings: { folders: [project] },
      spawn: (_b, _a, o) => {
        seen.push(o);
        return { stdout: "" };
      },
    });
    const ctx = t.forTool("t");
    await ctx.spawn("tool", [], { cwd: join(project, "sub") });
    expect(seen[0]?.cwd).toBe(join(project, "sub"));
    await ctx.spawn("tool", [], { cwd: "." });
    expect(seen[1]?.cwd).toBe(realpathSync.native(t.dataDir));
    await expect(ctx.spawn("tool", [], { cwd: other })).rejects.toThrow();
    await expect(ctx.spawn("tool", [], { cwd: join(project, "..", "x") })).rejects.toThrow();
    expect(seen).toHaveLength(2);
  });

  it("without the setting an absolute cwd outside the data folder is refused", async () => {
    const project = tmp();
    const t = harness({ manifest: folderManifest(), spawn: () => ({ stdout: "" }) });
    await expect(t.forTool("t").spawn("tool", [], { cwd: project })).rejects.toThrow();
  });

  it("skips a listed folder that fails the checks (with a warning)", async () => {
    const t = harness({
      manifest: folderManifest(),
      settings: { folders: ["/", "relative"] },
      spawn: () => ({ stdout: "" }),
    });
    expect(t.logs.filter((l) => l.level === "warn" && /folder skipped/.test(l.msg))).toHaveLength(
      2,
    );
    await expect(t.forTool("t").spawn("tool", [], { cwd: "/" })).rejects.toThrow();
  });
});

describe("folder-list settings come only from the user", () => {
  it("a manifest may not ship a non-empty folder-list default", () => {
    const m = folderManifest();
    expect(() =>
      parseManifest({
        ...m,
        settings: {
          type: "object",
          properties: { folders: { ...m.settings.properties.folders, default: [tmpdir()] } },
        },
      }),
    ).toThrow(/non-empty default/);
  });

  it("spawn roots never come from a default, only from the values passed in", () => {
    const project = tmp();
    // Built by hand: parseManifest would refuse this default.
    const m = {
      ...parseManifest(folderManifest()),
      settings: {
        type: "object",
        properties: {
          folders: {
            type: "array",
            items: { type: "string" },
            format: "folder-list",
            default: [project],
          },
        },
      },
    } as unknown as PackManifest;
    expect(spawnRootsFromSettings(m, {}, tmp(), () => {})).toEqual([]);
    expect(spawnRootsFromSettings(m, { folders: [project] }, tmp(), () => {})).toEqual([project]);
  });

  it("through the loader, a folder counts only once the user saved it", async () => {
    const root = tmp();
    const home = join(root, "home");
    const builtinDir = join(root, "builtin");
    const project = tmp();
    const dir = join(builtinDir, "fl");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "pack.json"),
      JSON.stringify({ ...folderManifest(["node"]), id: "fl", name: "fl", entry: "./index.mjs" }),
    );
    writeFileSync(
      join(dir, "index.mjs"),
      `export default (api) => api.definePack({ tools: [api.defineTool({
  name: "fl_cwd", description: "cwd", input: api.z.object({ cwd: api.z.string() }),
  run: async (i, ctx) => (await ctx.spawn("node", ["-e", "process.stdout.write(process.cwd())"], { cwd: i.cwd })).stdout,
})] });\n`,
    );
    const registry = new ToolRegistry();
    const loader = new PackLoader({
      home,
      registry,
      host: {
        store: createSecretStore({ home, env: {}, backend: "memory" }),
        logger: { debug() {}, info() {}, warn() {}, error() {} },
        daemonPorts: [7777],
        spawnPath: dirname(process.execPath),
      },
      builtinDir,
      userDir: join(home, "packs"),
    });
    try {
      await loader.loadAll();
      expect((await loader.listPacks()).find((p) => p.id === "fl")?.state).toBe("loaded");
      expect(await registry.call("fl_cwd", { cwd: project })).toMatchObject({ ok: false });
      await loader.setSettings("fl", { folders: [project] });
      expect(await registry.call("fl_cwd", { cwd: project })).toEqual({
        ok: true,
        result: project,
      });
    } finally {
      await loader.close();
    }
  });
});

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return check();
}

// A parent that starts a helper (which records its pid) and then hangs.
const PARENT_SOURCE = (pidFile: string) => {
  const helper = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`;
  return `
const { spawn } = require("node:child_process");
spawn(process.execPath, ["-e", ${JSON.stringify(helper)}], { stdio: ["ignore", "inherit", "inherit"] });
process.stdout.write("started\\n");
setInterval(() => {}, 1000);
`;
};

describe("killTree", () => {
  itPosix("a timeout kills the helpers the child started", async () => {
    const bin = tmp("plughive-bin-");
    const pidFile = join(tmp(), "helper.pid");
    fakeBinary(bin, "tool", PARENT_SOURCE(pidFile));
    const t = harness({ manifest: { ...base, permissions: { spawn: ["tool"] } }, spawnPath: bin });
    // The child and its helper are two Node start-ups; 1.5 s was too short for
    // both on a busy machine, so the helper had not written its pid yet.
    const r = await t.forTool("t").spawn("tool", [], { timeoutMs: 6000, killTree: true });
    expect(r, JSON.stringify(r)).toMatchObject({ timedOut: true, exitCode: -1 });
    expect(existsSync(pidFile)).toBe(true);
    const helper = Number(readFileSync(pidFile, "utf8"));
    expect(await waitFor(() => !alive(helper))).toBe(true);
  });

  itPosix("cancelling the call kills the helpers too", async () => {
    const bin = tmp("plughive-bin-");
    const pidFile = join(tmp(), "helper.pid");
    fakeBinary(bin, "tool", PARENT_SOURCE(pidFile));
    const t = harness({ manifest: { ...base, permissions: { spawn: ["tool"] } }, spawnPath: bin });
    const ac = new AbortController();
    const ctx = t.forTool("t", { signal: ac.signal, depth: 0 });
    const p = ctx.spawn("tool", [], { timeoutMs: 30_000, killTree: true });
    expect(await waitFor(() => existsSync(pidFile))).toBe(true);
    const helper = Number(readFileSync(pidFile, "utf8"));
    ac.abort();
    await expect(p).rejects.toThrow(/cancelled/);
    expect(await waitFor(() => !alive(helper))).toBe(true);
  });

  itPosix("a normal exit returns the output", async () => {
    const bin = tmp("plughive-bin-");
    fakeBinary(bin, "tool", 'process.stdout.write("hello")');
    const t = harness({ manifest: { ...base, permissions: { spawn: ["tool"] } }, spawnPath: bin });
    const r = await t.forTool("t").spawn("tool", [], { killTree: true });
    expect(r).toMatchObject({ stdout: "hello", exitCode: 0, timedOut: false, truncated: false });
  });
});

describe("manifest notice", () => {
  it("is optional plain text up to 2000 characters", () => {
    expect(parseManifest({ ...base, notice: "Read the terms." }).notice).toBe("Read the terms.");
    expect(() => parseManifest({ ...base, notice: "x".repeat(2001) })).toThrow();
    expect(() => parseManifest({ ...base, notice: "" })).toThrow();
  });
});

describe("opt-in providers", () => {
  function chat(id: string, optIn: boolean): ProviderBinding {
    return {
      def: {
        capability: "chat",
        id,
        priority: 100,
        optIn,
        isConfigured: () => true,
        run: async () => ({ text: id, model: "m" }),
      },
      context: () => ({}) as never,
    } as unknown as ProviderBinding;
  }

  it("a bundled opt-in provider runs only once the user lists it", async () => {
    const home = tmp();
    const router = new CapabilityRouter({
      home,
      logger: { debug() {}, info() {}, warn() {}, error() {} },
    });
    router.registerPack("bridge", "builtin", [chat("bridge", true)]);
    expect(router.has("chat")).toBe(false);
    expect((await router.list("chat"))[0]?.autoRoute).toBe(false);
    const caller = { pack: "x", depth: 0, signal: new AbortController().signal, tool: "t" };
    await expect(
      router.run("chat", { messages: [{ role: "user", content: "hi" }] }, {}, caller),
    ).rejects.toThrow();
    // Named explicitly, it runs.
    const named = await router.run(
      "chat",
      { messages: [{ role: "user", content: "hi" }] },
      { provider: "bridge" },
      caller,
    );
    expect((named as { text: string }).text).toBe("bridge");
    setCapabilityPreference(home, "chat", ["bridge"]);
    expect(router.has("chat")).toBe(true);
    const routed = await router.run(
      "chat",
      { messages: [{ role: "user", content: "hi" }] },
      {},
      caller,
    );
    expect((routed as { provider: string }).provider).toBe("bridge");
  });
});

describe("programDir", () => {
  itPosix(
    "is the real folder of a declared program, null when missing, refused when undeclared",
    () => {
      const real = tmp("plughive-prog-");
      fakeBinary(real, "tool", "process.exit(0)");
      const t = harness({
        manifest: { ...base, permissions: { spawn: ["tool", "absent"] } },
        spawnPath: real,
      });
      const ctx = t.forTool("t");
      expect(ctx.programDir("tool")).toBe(real);
      expect(ctx.programDir("absent")).toBeNull();
      expect(() => ctx.programDir("other")).toThrow(/not declared in permissions.spawn/);
    },
  );
});
