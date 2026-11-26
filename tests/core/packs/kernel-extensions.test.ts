// Negative tests for the kernel surfaces added with capability routing:
// cap:<name> permissions, library.materialize confinement, local-endpoint
// settings, and provider isolation from the calling pack's secrets.
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityRouter } from "../../../src/core/capabilities/router.js";
import {
  type HostCapabilities,
  type HostLibrary,
  PackPermissionError,
  localEndpointEntry,
} from "../../../src/core/packs/context.js";
import { PackLoader } from "../../../src/core/packs/loader.js";
import { createSecretStore } from "../../../src/core/secrets/index.js";
import { ToolRegistry } from "../../../src/core/tools/registry.js";
import { expectMode, itSymlink } from "../../support/platform.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const base = { id: "demo", name: "Demo", version: "0.1.0", apiVersion: 1 };
const harnesses: TestContext[] = [];
const tmps: string[] = [];

function tmp(): string {
  const d = realpathSync.native(mkdtempSync(join(tmpdir(), "plughive-kx-")));
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

function stubRouter(): HostCapabilities & { run: ReturnType<typeof vi.fn> } {
  return {
    run: vi.fn(async () => ({ text: "hi", model: "m", provider: "p" })),
    list: vi.fn(async () => [
      {
        capability: "chat",
        id: "p",
        pack: "x",
        priority: 0,
        configured: true,
        models: null,
        coolingDownUntil: null,
        preferred: null,
        autoRoute: true,
      },
      {
        capability: "image.generate",
        id: "q",
        pack: "y",
        priority: 0,
        configured: true,
        models: null,
        coolingDownUntil: null,
        preferred: null,
        autoRoute: true,
      },
    ]),
  } as never;
}

describe("ctx.capabilities permission", () => {
  it("refuses a capability the pack did not declare as cap:<name>", async () => {
    const router = stubRouter();
    const ctx = harness({ manifest: base, capabilityRouter: router }).forTool("t");
    await expect(
      ctx.capabilities.run("chat", { messages: [{ role: "user", content: "x" }] }),
    ).rejects.toBeInstanceOf(PackPermissionError);
    await expect(ctx.capabilities.run("chat", {} as never)).rejects.toThrow(/add "cap:chat"/);
    await expect(ctx.capabilities.list("chat")).rejects.toBeInstanceOf(PackPermissionError);
    await expect(ctx.capabilities.run("nope" as never, {} as never)).rejects.toThrow(
      /unknown capability/,
    );
    expect(router.run).not.toHaveBeenCalled();
    // An unfiltered list shows nothing the pack did not declare.
    expect(await ctx.capabilities.list()).toEqual([]);
  });

  it("passes only provider/model and the caller identity to the router", async () => {
    const router = stubRouter();
    const ctx = harness({
      manifest: { ...base, permissions: { tools: ["cap:chat"] } },
      capabilityRouter: router,
    }).forTool("ask");
    await ctx.capabilities.run("chat", { messages: [{ role: "user", content: "x" }] }, {
      provider: "p",
      extra: "dropped",
    } as never);
    const [cap, , opts, caller] = router.run.mock.calls[0] as unknown[];
    expect(cap).toBe("chat");
    expect(opts).toEqual({ provider: "p" });
    expect(caller).toMatchObject({ pack: "demo", tool: "ask", depth: 1 });
    expect((await ctx.capabilities.list()).map((r) => r.capability)).toEqual(["chat"]);
  });
});

describe("library.materialize", () => {
  const manifest = { ...base, permissions: { library: "read-all" } };

  function seeded(dataDir: string) {
    const t = harness({ manifest, dataDir });
    t.library?.seed({
      id: "a1",
      kind: "image",
      mime: "image/png",
      bytes: new Uint8Array([1, 2, 3]),
      tool: "x",
    });
    return t.forTool("t");
  }

  it("writes a read-only copy inside the pack's data dir and cleans it up", async () => {
    const dataDir = join(tmp(), "data"); // does not exist yet
    const ctx = seeded(dataDir);
    const copy = await ctx.library.materialize("a1");
    expect(copy.path.startsWith(dataDir + sep)).toBe(true);
    expect(copy.bytes).toBe(3);
    expect(copy.mime).toBe("image/png");
    expect([...readFileSync(copy.path)]).toEqual([1, 2, 3]);
    expectMode(copy.path, 0o400);
    await copy.cleanup();
    expect(() => lstatSync(copy.path)).toThrow();
    await copy.cleanup(); // idempotent
  });

  it("copies a file kept on disk and returns (no readBytes, no clone needed)", async () => {
    // A library that keeps files on disk, like the daemon's. Several MB so the
    // copy takes more than one read; it must finish and leave no handle open
    // (Node 26 waits forever on close() after an autoClose:false stream).
    const dir = tmp();
    const file = join(dir, "big.bin");
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    writeFileSync(file, bytes);
    const row = {
      id: "big",
      kind: "image" as const,
      mime: "image/png",
      bytes: bytes.length,
      tool: "x",
      model: null,
      prompt: null,
      meta: null,
      costUsd: null,
      createdAt: new Date().toISOString(),
      path: file,
    };
    const library = {
      get: (id: string) => (id === "big" ? row : null),
      list: () => [row],
      save: () => {
        throw new Error("read only");
      },
    };
    const t = harness({ manifest, dataDir: join(dir, "data"), library });
    const copy = await t.forTool("t").library.materialize("big");
    expect(copy.bytes).toBe(bytes.length);
    expect(readFileSync(copy.path).equals(bytes)).toBe(true);
    await copy.cleanup();
  }, 10_000);

  it("refuses a dir outside the data dir", async () => {
    const ctx = seeded(join(tmp(), "data"));
    await expect(ctx.library.materialize("a1", { dir: "../escape" })).rejects.toThrow();
    await expect(ctx.library.materialize("a1", { dir: "/tmp" })).rejects.toThrow();
    await expect(ctx.library.materialize("a1", { dir: "" })).rejects.toThrow(/non-empty/);
  });

  itSymlink("refuses a symlinked folder inside the data dir", async () => {
    const root = tmp();
    const dataDir = join(root, "data");
    const outside = join(root, "outside");
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, join(dataDir, "link"));
    const ctx = seeded(dataDir);
    await expect(ctx.library.materialize("a1", { dir: "link" })).rejects.toThrow();
    await expect(ctx.library.materialize("a1", { dir: "link/sub" })).rejects.toThrow();
  });

  itSymlink("never follows a symlinked stored file", async () => {
    const root = tmp();
    const secret = join(root, "secret.txt");
    writeFileSync(secret, "not for packs");
    const link = join(root, "a2.png");
    symlinkSync(secret, link);
    const lib = {
      get: (id: string) =>
        id === "a2"
          ? { id: "a2", kind: "image", mime: "image/png", path: link, bytes: 13, tool: "x" }
          : null,
      list: () => [],
      save: () => {
        throw new Error("no");
      },
    } as unknown as HostLibrary;
    const ctx = harness({ manifest, dataDir: join(root, "data"), library: lib }).forTool("t");
    await expect(ctx.library.materialize("a2")).rejects.toThrow();
  });

  it("needs the library permission", async () => {
    const t = harness({ manifest: base });
    await expect(t.forTool("t").library.materialize("a1")).rejects.toBeInstanceOf(
      PackPermissionError,
    );
  });
});

describe('format: "local-endpoint" settings', () => {
  const localPack = fileURLToPath(new URL("../../../packs/local", import.meta.url));

  it("refuses the daemon port, metadata, link-local and public hosts", () => {
    expect(() => localEndpointEntry("http://127.0.0.1:7777", [7777])).toThrow(/daemon/);
    expect(() => localEndpointEntry("http://localhost:7777/x", [7777])).toThrow(/daemon/);
    expect(() => localEndpointEntry("http://169.254.169.254/latest", [7777])).toThrow(/metadata/);
    expect(() => localEndpointEntry("http://metadata.google.internal", [7777])).toThrow(/metadata/);
    expect(() => localEndpointEntry("http://100.100.100.200", [7777])).toThrow();
    expect(() => localEndpointEntry("http://example.com:8188", [7777])).toThrow(
      /this machine or your LAN/,
    );
    expect(() => localEndpointEntry("file:///etc/passwd", [7777])).toThrow(/http/);
    expect(() => localEndpointEntry("http://u:p@127.0.0.1:8188", [7777])).toThrow(/password/);
    expect(localEndpointEntry("http://127.0.0.1:8188", [7777])).toBe("127.0.0.1:8188");
    expect(localEndpointEntry("http://192.168.1.20:11434/", [7777])).toBe("192.168.1.20:11434");
  });

  it("a pack with a daemon-port or metadata endpoint setting does not get a context", () => {
    expect(() =>
      createTestContext({ packDir: localPack, settings: { comfyUrl: "http://127.0.0.1:7777" } }),
    ).toThrow(/daemon/);
    expect(() =>
      createTestContext({ packDir: localPack, settings: { ollamaUrl: "http://169.254.169.254" } }),
    ).toThrow(/metadata/);
  });

  it("widens fetch to exactly the configured host:port", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const ctx = harness({
      packDir: localPack,
      fetch,
      settings: { comfyUrl: "http://192.168.1.20:8188" },
    }).forTool("t");
    await ctx.fetch("http://192.168.1.20:8188/system_stats");
    expect(fetch).toHaveBeenCalledTimes(1);
    await expect(ctx.fetch("http://192.168.1.20:8189/")).rejects.toThrow();
    await expect(ctx.fetch("http://127.0.0.1:7777/")).rejects.toThrow();
    await expect(ctx.fetch("http://169.254.169.254/")).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("the loader marks a pack failed when its endpoint setting points at the daemon", async () => {
    const root = tmp();
    const home = join(root, "home");
    const builtinDir = join(root, "builtin");
    const dir = join(builtinDir, "ep");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "pack.json"),
      JSON.stringify({
        ...base,
        id: "ep",
        entry: "./index.mjs",
        settings: {
          type: "object",
          properties: {
            url: { type: "string", format: "local-endpoint", default: "http://127.0.0.1:7777" },
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "index.mjs"),
      "export default (api) => api.definePack({ tools: [] });\n",
    );
    const loader = new PackLoader({
      home,
      registry: new ToolRegistry(),
      host: {
        store: createSecretStore({ home, env: {}, backend: "memory" }),
        logger: silent,
        daemonPorts: [7777],
      },
      builtinDir,
      userDir: join(home, "packs"),
    });
    await loader.loadAll();
    const ep = (await loader.listPacks()).find((p) => p.id === "ep");
    expect(ep?.state).toBe("failed");
    expect(ep?.error).toMatch(/daemon/);
    await loader.close();
  });
});

describe("capability providers run in their own pack's scope", () => {
  let root: string;
  let home: string;
  let builtinDir: string;
  const flags = globalThis as unknown as Record<string, unknown>;

  beforeEach(() => {
    root = tmp();
    home = join(root, "home");
    builtinDir = join(root, "builtin");
    const write = (id: string, manifest: object, code: string) => {
      const dir = join(builtinDir, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, "pack.json"),
        JSON.stringify({ ...base, id, name: id, entry: "./index.mjs", ...manifest }),
      );
      writeFileSync(join(dir, "index.mjs"), code);
    };
    // The provider pack declares PROV_KEY; it tries to read the caller's key.
    write(
      "prov",
      { secrets: [{ name: "PROV_KEY" }] },
      `export default (api) => api.definePack({
        providers: [api.defineProvider({
          capability: "chat", id: "fakechat", setupHint: "set PROV_KEY",
          isConfigured: async (ctx) => ctx.secrets.has("PROV_KEY"),
          async run(input, ctx) {
            const own = await ctx.secrets.get("PROV_KEY");
            let leaked = "refused";
            try { leaked = await ctx.secrets.get("CALLER_KEY"); } catch {}
            globalThis.__kxProvider = { pack: ctx.pack.id, own: own.length, leaked };
            return { text: "ok", model: "fake" };
          },
        })],
        tools: [],
      });\n`,
    );
    write(
      "callr",
      { secrets: [{ name: "CALLER_KEY" }], permissions: { tools: ["cap:chat"] } },
      `export default (api) => api.definePack({ tools: [
        api.defineTool({ name: "ask_it", description: "t", input: api.z.object({}), secrets: ["CALLER_KEY"],
          async run(_i, ctx) {
            await ctx.secrets.get("CALLER_KEY");
            const r = await ctx.capabilities.run("chat", { messages: [{ role: "user", content: "x" }] });
            return { text: r.text, provider: r.provider };
          } }),
        api.defineTool({ name: "ask_undeclared", description: "t", input: api.z.object({}),
          async run(_i, ctx) { return ctx.capabilities.run("image.generate", { prompt: "x" }); } }),
      ] });\n`,
    );
  });

  afterEach(() => {
    Reflect.deleteProperty(flags, "__kxProvider");
  });

  it("the provider sees its own secret and never the caller's; undeclared caps are refused", async () => {
    const registry = new ToolRegistry();
    const capabilities = new CapabilityRouter({ home, logger: silent });
    const loader = new PackLoader({
      home,
      registry,
      host: {
        store: createSecretStore({
          home,
          env: { PROV_KEY: "fixture-prov", CALLER_KEY: "fixture-caller" },
          backend: "memory",
        }),
        logger: silent,
        capabilities,
      },
      builtinDir,
      userDir: join(home, "packs"),
      capabilities,
    });
    await loader.loadAll();
    const res = await registry.call("ask_it", {});
    expect(res).toEqual({ ok: true, result: { text: "ok", provider: "fakechat" } });
    expect(flags.__kxProvider).toEqual({
      pack: "prov",
      own: "fixture-prov".length,
      leaked: "refused",
    });

    const denied = await registry.call("ask_undeclared", {});
    expect(denied).toMatchObject({ ok: false });
    expect(JSON.stringify(denied)).toMatch(/cap:image\.generate/);
    await loader.close();
    // Unloading a pack removes its providers.
    expect(capabilities.has("chat")).toBe(false);
  });
});
