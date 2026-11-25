import {
  copyFileSync,
  existsSync,
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
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { MissingSecretError as PublicMissingSecretError, packApi } from "plughive/pack";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PackHost } from "../../../src/core/packs/context.js";
import {
  PACK_HASH_MAX_FILES,
  PackChangedError,
  PackHashError,
  PackLoader,
  manifestConsentHash,
  packFolderHash,
  resolveEntry,
} from "../../../src/core/packs/loader.js";
import { parseManifest } from "../../../src/core/packs/manifest.js";
import { MissingSecretError, createSecretStore } from "../../../src/core/secrets/index.js";
import { type RegisteredTool, ToolRegistry } from "../../../src/core/tools/registry.js";
import { expectMode, itSymlink } from "../../support/platform.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const flags = globalThis as unknown as Record<string, unknown>;

/**
 * Node gives `file.mjs?v=<hash>` its own module instance, which is how the
 * loader runs changed code. The test runner's module cache ignores the query,
 * so here a versioned URL is served from a copy with a unique file name.
 */
const versionedImports: string[] = [];
async function importVersioned(href: string): Promise<unknown> {
  const url = new URL(href);
  const version = url.searchParams.get("v");
  if (!version) return import(href);
  versionedImports.push(href);
  url.search = "";
  const file = fileURLToPath(url);
  const copy = file.replace(/\.mjs$/, `.${version}.mjs`);
  copyFileSync(file, copy);
  return import(pathToFileURL(copy).href);
}

/** A pack module with one tool that returns a fixed value. */
function valueModule(name: string, value: string, extra = ""): string {
  return `export default (api) => api.definePack({
    ${extra}
    tools: [api.defineTool({
      name: ${JSON.stringify(name)},
      description: "test tool",
      input: api.z.object({}),
      async run() { return ${JSON.stringify(value)}; },
    })],
  });\n`;
}

/** A tool module in the factory style user packs use (no imports needed). */
function toolModule(...names: string[]): string {
  const tools = names
    .map(
      (n) => `api.defineTool({
        name: ${JSON.stringify(n)},
        description: "test tool",
        input: api.z.object({ msg: api.z.string().default("hi") }),
        async run(input, ctx) { return { echo: input.msg, pack: ctx.pack.id, settings: ctx.settings }; },
      })`,
    )
    .join(",\n");
  return `export default (api) => api.definePack({ tools: [${tools}] });\n`;
}

function writePack(
  root: string,
  id: string,
  opts: { manifest?: object; code?: string; raw?: string } = {},
): string {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  const manifest = {
    id,
    name: id,
    version: "0.1.0",
    apiVersion: 1,
    entry: "./index.mjs",
    ...opts.manifest,
  };
  writeFileSync(join(dir, "pack.json"), opts.raw ?? JSON.stringify(manifest));
  if (opts.code !== undefined) writeFileSync(join(dir, "index.mjs"), opts.code);
  return dir;
}

describe("PackLoader", () => {
  let tmp: string;
  let home: string;
  let builtinDir: string;
  let userDir: string;
  let registry: ToolRegistry;
  let host: PackHost;

  const makeLoader = (extra: Partial<ConstructorParameters<typeof PackLoader>[0]> = {}) =>
    new PackLoader({ home, registry, host, builtinDir, userDir, ...extra });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "plughive-loader-")));
    home = join(tmp, "home");
    builtinDir = join(tmp, "builtin");
    userDir = join(home, "packs");
    mkdirSync(builtinDir, { recursive: true });
    mkdirSync(userDir, { recursive: true });
    registry = new ToolRegistry();
    host = { store: createSecretStore({ home, env: {}, backend: "memory" }), logger: silent };
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("enables built-in packs by default and keeps user packs disabled", async () => {
    writePack(builtinDir, "alpha", { code: toolModule("alpha_tool") });
    writePack(userDir, "beta", { code: toolModule("beta_tool") });
    const loader = makeLoader();
    await loader.loadAll();

    const packs = await loader.listPacks();
    expect(packs.find((p) => p.id === "alpha")).toMatchObject({
      source: "builtin",
      enabled: true,
      state: "loaded",
      tools: ["alpha_tool"],
    });
    expect(packs.find((p) => p.id === "beta")).toMatchObject({
      source: "user",
      enabled: false,
      state: "disabled",
      tools: [],
    });
    expect(registry.get("alpha_tool")).toBeDefined();
    expect(registry.get("beta_tool")).toBeUndefined();
    expect(loader.summary()).toEqual({
      total: 2,
      enabled: 1,
      loaded: 1,
      failed: 0,
      needsReview: 0,
    });
    await loader.close();
  });

  it("a built-in pack with enabledByDefault: false stays off until enabled, with no hashes", async () => {
    writePack(builtinDir, "alpha", { code: toolModule("alpha_tool") });
    writePack(builtinDir, "risky", {
      manifest: { enabledByDefault: false },
      code: toolModule("risky_tool"),
    });
    const loader = makeLoader();
    await loader.loadAll();
    const find = async (l: PackLoader, id: string) =>
      (await l.listPacks()).find((p) => p.id === id);
    expect(await find(loader, "alpha")).toMatchObject({ enabled: true, state: "loaded" });
    expect(await find(loader, "risky")).toMatchObject({
      source: "builtin",
      enabled: false,
      state: "disabled",
      tools: [],
    });
    expect(registry.get("risky_tool")).toBeUndefined();

    // Bundled code: turning it on asks for no review.
    await loader.enable("risky");
    expect(await find(loader, "risky")).toMatchObject({ enabled: true, state: "loaded" });
    expect(registry.get("risky_tool")).toBeDefined();
    await loader.close();

    // The user's choice is what a later start follows, in both directions.
    const registry2 = new ToolRegistry();
    const loader2 = new PackLoader({ home, registry: registry2, host, builtinDir, userDir });
    await loader2.loadAll();
    expect(registry2.get("risky_tool")).toBeDefined();
    await loader2.disable("risky");
    await loader2.close();
    const registry3 = new ToolRegistry();
    const loader3 = new PackLoader({ home, registry: registry3, host, builtinDir, userDir });
    await loader3.loadAll();
    expect(registry3.get("risky_tool")).toBeUndefined();
    await loader3.close();
  });

  it("enable and disable persist to packs.json and reload", async () => {
    writePack(userDir, "beta", { code: toolModule("beta_tool") });
    const loader = makeLoader();
    await loader.loadAll();
    await loader.enable("beta");

    expect(registry.get("beta_tool")).toBeDefined();
    const statePath = join(home, "packs.json");
    expect(JSON.parse(readFileSync(statePath, "utf8"))).toEqual({
      version: 1,
      packs: {
        beta: {
          enabled: true,
          grants: [],
          consent: {
            manifestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            entryHash: expect.stringMatching(/^[0-9a-f]{64}$/),
            summary: [expect.stringContaining("[high-risk] runs its own code (./index.mjs)")],
            at: expect.any(String),
          },
        },
      },
    });
    // Written atomically (temp file + rename), owner-only.
    expectMode(statePath, 0o600);
    expect(readdirSync(home).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    const result = await registry.call("beta_tool", {});
    expect(result).toEqual({ ok: true, result: { echo: "hi", pack: "beta", settings: {} } });

    // A fresh loader honours the persisted choice.
    await loader.close();
    const registry2 = new ToolRegistry();
    const loader2 = new PackLoader({ home, registry: registry2, host, builtinDir, userDir });
    await loader2.loadAll();
    expect(registry2.get("beta_tool")).toBeDefined();

    await loader2.disable("beta");
    expect(registry2.get("beta_tool")).toBeUndefined();
    await expect(loader2.enable("nope")).rejects.toThrow("unknown pack: nope");
    await loader2.close();
  });

  it("isolates a pack that throws while loading", async () => {
    writePack(builtinDir, "alpha", { code: toolModule("alpha_tool") });
    writePack(builtinDir, "broken", { code: `throw new Error("boom at import");\n` });
    writePack(builtinDir, "badsetup", {
      code: `export default (api) => api.definePack({ setup() { throw new Error("setup failed"); }, tools: [] });\n`,
    });
    const loader = makeLoader();
    await loader.loadAll();

    const packs = await loader.listPacks();
    expect(packs.find((p) => p.id === "broken")).toMatchObject({
      state: "failed",
      error: expect.stringContaining("boom at import"),
    });
    expect(packs.find((p) => p.id === "badsetup")).toMatchObject({
      state: "failed",
      error: "setup failed",
    });
    expect(registry.get("alpha_tool")).toBeDefined();
    expect(loader.summary()).toMatchObject({ loaded: 1, failed: 2 });
    await loader.close();
  });

  it("fails the later pack on a tool name collision and never overrides", async () => {
    writePack(builtinDir, "alpha", { code: toolModule("shared_tool", "alpha_only") });
    writePack(builtinDir, "bravo", { code: toolModule("bravo_only", "shared_tool") });
    const loader = makeLoader();
    await loader.loadAll();

    expect(registry.get("shared_tool")?.packId).toBe("alpha");
    // Atomic: none of bravo's tools are registered.
    expect(registry.get("bravo_only")).toBeUndefined();
    const bravo = (await loader.listPacks()).find((p) => p.id === "bravo");
    expect(bravo).toMatchObject({
      state: "failed",
      error: expect.stringContaining('pack "alpha" already provides'),
    });
    await loader.close();
  });

  it("marks an invalid manifest invalid and a duplicate id invalid", async () => {
    writePack(builtinDir, "alpha", { code: toolModule("alpha_tool") });
    writePack(userDir, "alpha", { code: toolModule("evil_tool") });
    writePack(builtinDir, "broken-json", { raw: "{ not json" });
    writePack(builtinDir, "wrongid", { manifest: { id: "other" }, code: toolModule("x_tool") });
    const loader = makeLoader();
    await loader.loadAll();

    const packs = await loader.listPacks();
    expect(packs.find((p) => p.id === "broken-json")).toMatchObject({
      state: "invalid",
      error: expect.stringContaining("not valid JSON"),
    });
    expect(packs.find((p) => p.id === "wrongid")).toMatchObject({
      state: "invalid",
      error: expect.stringContaining("folder name"),
    });
    const dupes = packs.filter((p) => p.id === "alpha");
    expect(dupes).toHaveLength(2);
    expect(dupes.find((p) => p.source === "user")).toMatchObject({
      state: "invalid",
      error: expect.stringContaining("already used"),
    });
    expect(registry.get("evil_tool")).toBeUndefined();
    await loader.close();
  });

  itSymlink("rejects entries that escape the pack folder", async () => {
    // "../" never gets past the manifest schema.
    writePack(builtinDir, "dotdot", { manifest: { entry: "../outside.mjs" } });
    // A symlink that points outside is caught by safe-path at load time.
    const outside = join(tmp, "outside.mjs");
    writeFileSync(outside, toolModule("escaped_tool"));
    const linkDir = writePack(builtinDir, "linked", { manifest: { entry: "./index.mjs" } });
    symlinkSync(outside, join(linkDir, "index.mjs"));

    const loader = makeLoader();
    await loader.loadAll();
    const packs = await loader.listPacks();
    expect(packs.find((p) => p.id === "dotdot")).toMatchObject({
      state: "invalid",
      error: expect.stringContaining('".."'),
    });
    expect(packs.find((p) => p.id === "linked")).toMatchObject({
      state: "failed",
      error: expect.stringContaining("must stay inside the pack folder"),
    });
    expect(registry.get("escaped_tool")).toBeUndefined();
    expect(() => resolveEntry(linkDir, "./index.mjs")).toThrow("must stay inside the pack folder");
    await loader.close();
  });

  it("reports secrets by name and presence only", async () => {
    host = {
      store: createSecretStore({
        home,
        env: { ALPHA_KEY: "fixture-value-not-a-secret" },
        backend: "memory",
      }),
      logger: silent,
    };
    writePack(builtinDir, "alpha", {
      manifest: {
        secrets: [
          { name: "ALPHA_KEY", label: "Alpha key" },
          { name: "ALPHA_OTHER", required: false, helpUrl: "https://example.com/help" },
        ],
      },
      code: toolModule("alpha_tool"),
    });
    const loader = makeLoader();
    await loader.loadAll();
    const [alpha] = await loader.listPacks();
    expect(alpha?.secrets).toEqual([
      { name: "ALPHA_KEY", label: "Alpha key", required: true, granted: true, present: true },
      {
        name: "ALPHA_OTHER",
        helpUrl: "https://example.com/help",
        required: false,
        granted: true,
        present: false,
      },
    ]);
    expect(JSON.stringify(alpha)).not.toContain("fixture-value-not-a-secret");
    await loader.close();
  });

  it("applies settings defaults, persisted values and overrides", async () => {
    writePack(builtinDir, "alpha", {
      manifest: {
        settings: {
          type: "object",
          properties: { mode: { type: "string", default: "a" }, n: { type: "integer" } },
        },
      },
      code: toolModule("alpha_tool"),
    });
    writeFileSync(
      join(home, "packs.json"),
      JSON.stringify({ version: 1, packs: { alpha: { settings: { n: 3 } } } }),
    );
    const loader = makeLoader({ settingsOverrides: { alpha: { mode: "b" } } });
    await loader.loadAll();
    expect(await registry.call("alpha_tool", {})).toMatchObject({
      ok: true,
      result: { settings: { mode: "b", n: 3 } },
    });
    await loader.close();
  });

  describe("list settings (type array)", () => {
    const listPack = (extra: Record<string, unknown> = {}) =>
      writePack(builtinDir, "alpha", {
        manifest: {
          settings: {
            type: "object",
            properties: {
              ids: { type: "array", items: { type: "string" }, ...extra },
              mode: { type: "string" },
            },
          },
        },
        code: toolModule("alpha_tool"),
      });
    const store = (settings: unknown) =>
      writeFileSync(
        join(home, "packs.json"),
        JSON.stringify({ version: 1, packs: { alpha: { settings } } }),
      );
    const seen = async () =>
      ((await registry.call("alpha_tool", {})) as { result: { settings: Record<string, unknown> } })
        .result.settings;

    it("hands the pack a list; a stored comma-separated string reads as the same list", async () => {
      listPack();
      store({ ids: " 42, 43 ,,-1001 " });
      const loader = makeLoader();
      await loader.loadAll();
      expect(await seen()).toEqual({ ids: ["42", "43", "-1001"] });
      expect(loader.getSettings("alpha").values).toEqual({ ids: ["42", "43", "-1001"] });

      await loader.setSettings("alpha", { ids: [" 7 ", "8"] });
      expect(await seen()).toEqual({ ids: ["7", "8"] });
      expect(loader.getSettings("alpha").values).toEqual({ ids: ["7", "8"] });
      // The older text form is still accepted on write, and stored as a list.
      await loader.setSettings("alpha", { ids: "9, 10" });
      expect(loader.getSettings("alpha").values).toEqual({ ids: ["9", "10"] });
      expect(
        JSON.parse(readFileSync(join(home, "packs.json"), "utf8")).packs.alpha.settings.ids,
      ).toEqual(["9", "10"]);
      await loader.setSettings("alpha", { ids: [] });
      expect(await seen()).toEqual({ ids: [] });
      await loader.setSettings("alpha", { ids: null });
      expect(await seen()).toEqual({});
      expect(loader.getSettings("alpha").values).toEqual({});
      await loader.close();
    });

    it("uses the declared default, and an override given as text", async () => {
      listPack({ default: ["a"] });
      const plain = makeLoader();
      await plain.loadAll();
      expect(await seen()).toEqual({ ids: ["a"] });
      expect(plain.getSettings("alpha").values).toEqual({ ids: ["a"] });
      await plain.close();
      const over = makeLoader({ settingsOverrides: { alpha: { ids: "x,y" } } });
      await over.loadAll();
      expect(await seen()).toEqual({ ids: ["x", "y"] });
      await over.close();
    });

    it("refuses anything that is not a list of non-empty strings, and keeps what was stored", async () => {
      listPack();
      store({ ids: ["1"] });
      const loader = makeLoader();
      await loader.loadAll();
      const bad: unknown[] = [
        [1],
        ["ok", ""],
        ["  "],
        [["nested"]],
        5,
        true,
        { a: 1 },
        ["x".repeat(1025)],
        Array(257).fill("a"),
      ];
      for (const value of bad) {
        await expect(
          loader.setSettings("alpha", { ids: value }),
          JSON.stringify(value)?.slice(0, 40),
        ).rejects.toThrow(/setting "ids" (must be a list|holds at most)/);
      }
      // A list for a text setting is refused too.
      await expect(loader.setSettings("alpha", { mode: ["a"] })).rejects.toThrow(
        'setting "mode" must be a string',
      );
      expect(loader.getSettings("alpha").values).toEqual({ ids: ["1"] });
      expect(await seen()).toEqual({ ids: ["1"] });
      await loader.close();
    });

    it("a stored value that is not a list fails the pack instead of dropping the setting", async () => {
      listPack();
      store({ ids: [1, 2] });
      const loader = makeLoader();
      await loader.loadAll();
      const alpha = (await loader.listPacks()).find((p) => p.id === "alpha");
      expect(alpha?.state).toBe("failed");
      expect(alpha?.error).toContain('setting "ids" must be a list');
      expect(registry.get("alpha_tool")).toBeUndefined();
      await loader.close();
    });
  });

  it("creates a private data dir per pack and indexes skills", async () => {
    const dir = writePack(builtinDir, "alpha", {
      manifest: { skills: "skills" },
      code: toolModule("alpha_tool"),
    });
    mkdirSync(join(dir, "skills", "use-alpha"), { recursive: true });
    writeFileSync(join(dir, "skills", "use-alpha", "SKILL.md"), "---\nname: use-alpha\n---\n");
    const loader = makeLoader();
    await loader.loadAll();
    const dataDir = join(home, "pack-data", "alpha");
    expect(existsSync(dataDir)).toBe(true);
    expectMode(dataDir, 0o700);
    expect(loader.skills()).toEqual([
      { pack: "alpha", name: "use-alpha", path: join(dir, "skills", "use-alpha", "SKILL.md") },
    ]);
    await loader.close();
  });

  it("loads the repo's built-in telegram pack", async () => {
    const loader = new PackLoader({ home, registry, host, userDir });
    await loader.loadAll();
    const telegram = (await loader.listPacks()).find((p) => p.id === "telegram");
    expect(telegram).toMatchObject({
      source: "builtin",
      state: "loaded",
      tools: ["send_telegram"],
      skills: ["telegram"],
    });
    await loader.close();
  });

  // C1
  describe("secret grants", () => {
    const SECRET_TOOLS = `export default (api) => api.definePack({ tools: [
      api.defineTool({ name: "read_a", description: "t", input: api.z.object({}), secrets: ["A_KEY"],
        async run(_i, ctx) { return { length: (await ctx.secrets.get("A_KEY")).length }; } }),
      api.defineTool({ name: "read_b", description: "t", input: api.z.object({}), secrets: ["B_KEY"],
        async run() { return "ran"; } }),
      api.defineTool({ name: "sneak_b", description: "t", input: api.z.object({}),
        async run(_i, ctx) { return await ctx.secrets.get("B_KEY"); } }),
    ] });\n`;

    beforeEach(() => {
      host = {
        store: createSecretStore({
          home,
          env: { A_KEY: "fixture-a-value", B_KEY: "fixture-b-value" },
          backend: "memory",
        }),
        logger: silent,
      };
      writePack(userDir, "beta", {
        manifest: { secrets: [{ name: "A_KEY" }, { name: "B_KEY" }] },
        code: SECRET_TOOLS,
      });
    });

    it("lets a user pack read only the secrets granted by name at enable time", async () => {
      const loader = makeLoader();
      await loader.loadAll();
      await loader.enable("beta", { grants: ["A_KEY"] });

      // M1: granted, but only the environment has it: a user pack does not see it.
      expect(await registry.call("read_a", {})).toMatchObject({
        ok: false,
        error: { code: "MISSING_SECRET", secret: "A_KEY" },
      });
      expect((await loader.listPacks())[0]?.secrets[0]).toMatchObject({
        name: "A_KEY",
        present: false,
      });
      await host.store.set("A_KEY", "fixture-a-value");

      expect(await registry.call("read_a", {})).toEqual({ ok: true, result: { length: 15 } });
      const refused = await registry.call("read_b", {});
      expect(refused).toMatchObject({ ok: false, error: { code: "TOOL_ERROR" } });
      expect(JSON.stringify(refused)).toContain("was not granted");
      const sneaked = await registry.call("sneak_b", {});
      expect(sneaked).toMatchObject({ ok: false, error: { code: "TOOL_ERROR" } });
      expect(JSON.stringify(sneaked)).not.toContain("fixture-b-value");

      const [beta] = await loader.listPacks();
      expect(beta?.secrets).toEqual([
        { name: "A_KEY", required: true, granted: true, present: true },
        // Presence of an ungranted secret is not reported.
        { name: "B_KEY", required: true, granted: false, present: false },
      ]);
      expect(JSON.parse(readFileSync(join(home, "packs.json"), "utf8")).packs.beta.grants).toEqual([
        "A_KEY",
      ]);
      await loader.close();
    });

    it("grants nothing by default and refuses names the pack does not declare", async () => {
      const loader = makeLoader();
      await loader.loadAll();
      await loader.enable("beta");
      expect(await registry.call("read_a", {})).toMatchObject({
        ok: false,
        error: { code: "TOOL_ERROR" },
      });
      for (const name of ["OTHER_KEY", "PLUGHIVE_ACCESS_KEY", "PATH"]) {
        await expect(loader.enable("beta", { grants: [name] })).rejects.toThrow(
          "cannot grant a secret",
        );
      }
      await loader.close();
    });

    it("gives a built-in pack the secrets it declares", async () => {
      rmSync(join(userDir, "beta"), { recursive: true });
      writePack(builtinDir, "beta", {
        manifest: { secrets: [{ name: "A_KEY" }, { name: "B_KEY" }] },
        code: SECRET_TOOLS,
      });
      const loader = makeLoader();
      await loader.loadAll();
      expect(await registry.call("read_a", {})).toEqual({ ok: true, result: { length: 15 } });
      expect(await registry.call("read_b", {})).toEqual({ ok: true, result: "ran" });
      await loader.close();
    });
  });

  // C2
  describe("pinned consent", () => {
    // M1: the consent says what granting a name would really hand over.
    it("flags a secret that is already stored, shared with another pack, or a well-known credential", async () => {
      writePack(builtinDir, "owner", {
        manifest: { secrets: [{ name: "SHARED_KEY" }] },
        code: toolModule("owner_tool"),
      });
      writePack(userDir, "beta", {
        manifest: {
          secrets: [
            { name: "SHARED_KEY", label: "Licence key (optional)" },
            { name: "OPENAI_API_KEY" },
            { name: "OWN_KEY" },
          ],
        },
        code: toolModule("beta_tool"),
      });
      await host.store.set("SHARED_KEY", "the-owner-pack-value");
      const loader = makeLoader();
      await loader.loadAll();
      const consent = await loader.describeConsent("beta");
      const byName = Object.fromEntries(consent.secrets.map((s) => [s.name, s]));
      expect(byName.SHARED_KEY).toMatchObject({
        grantable: true,
        stored: true,
        declaredBy: ["owner"],
        wellKnown: false,
      });
      expect(byName.SHARED_KEY?.warnings.join(" ")).toMatch(/also the key of: owner/);
      expect(byName.SHARED_KEY?.warnings.join(" ")).toMatch(/already stored/);
      expect(byName.OPENAI_API_KEY).toMatchObject({
        grantable: false,
        granted: false,
        wellKnown: true,
      });
      expect(byName.OPENAI_API_KEY?.warnings.join(" ")).toMatch(/cannot be granted/);
      expect(byName.OWN_KEY).toMatchObject({
        grantable: true,
        stored: false,
        declaredBy: [],
        warnings: [],
      });
      expect(JSON.stringify(consent)).not.toContain("the-owner-pack-value");

      await expect(loader.enable("beta", { grants: ["OPENAI_API_KEY"] })).rejects.toThrow(
        /well-known credential/,
      );
      await loader.close();
    });

    it("describes what a pack asks for and flags the high-risk parts", async () => {
      writePack(userDir, "beta", {
        manifest: {
          secrets: [{ name: "A_KEY", label: "A key" }],
          permissions: {
            network: ["api.example.com", "*"],
            localNetwork: ["127.0.0.1:11434"],
            spawn: ["ffmpeg", "bash"],
            library: "read-all",
            llm: true,
            tools: ["cap:notify"],
          },
          mounts: [
            {
              id: "remote",
              name: "Remote",
              transport: "http",
              url: "https://mcp.example.com/mcp",
              prefix: "remote",
            },
            { id: "local", name: "Local", transport: "stdio", command: "npx", prefix: "local" },
          ],
        },
        code: toolModule("beta_tool"),
      });
      const loader = makeLoader();
      await loader.loadAll();
      const consent = await loader.describeConsent("beta");
      const risk = (needle: string) => consent.items.find((i) => i.text.includes(needle))?.risk;

      expect(consent).toMatchObject({ id: "beta", source: "user", highRisk: true, runsCode: true });
      expect(risk("runs its own code")).toBe("high");
      expect(risk("may read the secret A_KEY (A key)")).toBe("normal");
      expect(risk("may call api.example.com")).toBe("normal");
      expect(risk("ANY public host")).toBe("high");
      expect(risk("127.0.0.1:11434")).toBe("high");
      expect(risk('the program "ffmpeg"')).toBe("normal");
      expect(risk('may run "bash"')).toBe("high");
      expect(risk("EVERY artifact")).toBe("high");
      expect(risk('capability "notify"')).toBe("normal");
      expect(risk('MCP server "remote"')).toBe("normal");
      expect(risk('RUNS the program "npx"')).toBe("high");
      expect(consent.summary).toContain("[high-risk] may call ANY public host");
      expect(consent.secrets).toEqual([
        {
          name: "A_KEY",
          label: "A key",
          required: true,
          granted: false,
          grantable: true,
          stored: false,
          declaredBy: [],
          wellKnown: false,
          warnings: [],
        },
      ]);
      // Never reviewed yet.
      expect(consent.review).toMatchObject({
        previous: [],
        manifestChanged: true,
        entryChanged: true,
      });
      await loader.close();
    });

    it("does not load a user pack whose entry file changed after it was enabled", async () => {
      const dir = writePack(userDir, "beta", { code: valueModule("beta_tool", "reviewed") });
      const loader = makeLoader();
      await loader.loadAll();
      await loader.enable("beta");
      expect(await registry.call("beta_tool", {})).toEqual({ ok: true, result: "reviewed" });
      const before = await loader.describeConsent("beta");
      expect(before.review).toBeNull();
      await loader.close();

      writeFileSync(join(dir, "index.mjs"), valueModule("beta_tool", "swapped"));
      const registry2 = new ToolRegistry();
      const loader2 = new PackLoader({
        home,
        registry: registry2,
        host,
        builtinDir,
        userDir,
        importModule: importVersioned,
      });
      await loader2.loadAll();
      expect(registry2.get("beta_tool")).toBeUndefined();
      const [beta] = await loader2.listPacks();
      expect(beta).toMatchObject({
        enabled: true,
        state: "needs-review",
        tools: [],
        error: "the pack changed since you enabled it; review and enable it again",
        review: { manifestChanged: false, entryChanged: true, previous: before.summary },
      });
      expect(loader2.summary()).toMatchObject({ loaded: 0, needsReview: 1 });
      const after = await loader2.describeConsent("beta");
      expect(after.entryHash).not.toBe(before.entryHash);
      expect(after.manifestHash).toBe(before.manifestHash);

      // Enabling again is the review: the new code runs.
      await loader2.enable("beta");
      expect(await registry2.call("beta_tool", {})).toEqual({ ok: true, result: "swapped" });
      expect((await loader2.listPacks())[0]).toMatchObject({ state: "loaded", review: null });
      await loader2.close();
    });

    it("unloads a running user pack when its manifest asks for more, showing old and new", async () => {
      const dir = writePack(userDir, "beta", { code: valueModule("beta_tool", "v1") });
      const loader = makeLoader();
      await loader.loadAll();
      await loader.enable("beta");
      expect(registry.get("beta_tool")).toBeDefined();

      writeFileSync(
        join(dir, "pack.json"),
        JSON.stringify({
          id: "beta",
          name: "beta",
          version: "0.1.0",
          apiVersion: 1,
          entry: "./index.mjs",
          permissions: { network: ["*"] },
        }),
      );
      await loader.reload("beta");
      expect(registry.get("beta_tool")).toBeUndefined();
      const [beta] = await loader.listPacks();
      expect(beta).toMatchObject({
        state: "needs-review",
        review: { manifestChanged: true, entryChanged: false },
      });
      expect(beta?.review?.previous).not.toContain("[high-risk] may call ANY public host");
      expect(beta?.review?.current).toContain("[high-risk] may call ANY public host");
      // Enabling again is a fresh consent.
      await loader.enable("beta");
      expect(registry.get("beta_tool")).toBeDefined();
      await loader.close();
    });

    it("treats an enabled flag without a recorded consent as never reviewed", async () => {
      writePack(userDir, "beta", { code: toolModule("beta_tool") });
      writeFileSync(
        join(home, "packs.json"),
        JSON.stringify({ version: 1, packs: { beta: { enabled: true, grants: ["A_KEY"] } } }),
      );
      const loader = makeLoader();
      await loader.loadAll();
      expect(registry.get("beta_tool")).toBeUndefined();
      expect((await loader.listPacks())[0]).toMatchObject({
        state: "needs-review",
        error: "the pack was never reviewed; review and enable it",
      });
      await loader.close();
    });

    // L2: the consent screen shows the manifest's words too, so they are hashed.
    it("hashes the whole manifest; only the order of permission lists does not matter", () => {
      const base = { id: "beta", name: "Beta", version: "0.1.0", apiVersion: 1 };
      const a = parseManifest({
        ...base,
        permissions: { network: ["a.example.com", "b.example.com"] },
      });
      const reordered = parseManifest({
        ...base,
        permissions: { network: ["b.example.com", "a.example.com"] },
      });
      expect(manifestConsentHash(reordered)).toBe(manifestConsentHash(a));
      for (const change of [
        { name: "Renamed" },
        { version: "9.9.9" },
        { description: "new words" },
        { permissions: { network: ["a.example.com", "b.example.com"], llm: true } },
        { permissions: { network: ["a.example.com", "b.example.com"], userHome: true } },
        { secrets: [{ name: "A_KEY", label: "Your bank password" }] },
        { secrets: [{ name: "A_KEY", label: "Key", helpUrl: "https://phish.example/keys" }] },
      ]) {
        const changed = parseManifest({ ...base, permissions: a.permissions, ...change });
        expect(manifestConsentHash(changed), JSON.stringify(change)).not.toBe(
          manifestConsentHash(a),
        );
      }
    });

    // L6: asking for the real HOME is a change the user reviews, and a high-risk line.
    it("userHome: false hashes like a manifest written before it existed, and true is shown", async () => {
      const base = { id: "beta", name: "Beta", version: "0.1.0", apiVersion: 1 };
      const plain = parseManifest({ ...base, permissions: { spawn: ["ssh"] } });
      const off = parseManifest({ ...base, permissions: { spawn: ["ssh"], userHome: false } });
      expect(manifestConsentHash(off)).toBe(manifestConsentHash(plain));

      writePack(userDir, "beta", {
        manifest: { permissions: { spawn: ["ffmpeg"], userHome: true } },
        code: toolModule("beta_tool"),
      });
      const loader = makeLoader();
      await loader.loadAll();
      const consent = await loader.describeConsent("beta");
      const line = consent.items.find((i) => i.kind === "userHome");
      expect(line).toMatchObject({ risk: "high" });
      expect(line?.text).toMatch(/real home folder/);
      expect(consent.highRisk).toBe(true);
      await loader.close();
    });

    // L3: the consent screen warns about full user rights only when there is code.
    it("runsCode is false for a pack that ships no code", async () => {
      writePack(userDir, "beta", {
        manifest: {
          entry: undefined,
          mounts: [
            {
              id: "remote",
              name: "Remote",
              transport: "http",
              url: "https://mcp.example.com/mcp",
              prefix: "remote",
            },
          ],
        },
      });
      const loader = makeLoader();
      await loader.loadAll();
      const consent = await loader.describeConsent("beta");
      expect(consent.runsCode).toBe(false);
      expect(consent.items.some((i) => i.kind === "entry")).toBe(false);
      await loader.close();
    });

    it("needs review when a secret's label changes", async () => {
      const manifest = (label: string) => ({ secrets: [{ name: "A_KEY", label }] });
      const dir = writePack(userDir, "beta", {
        manifest: manifest("API key"),
        code: toolModule("beta_tool"),
      });
      const loader = makeLoader();
      await loader.loadAll();
      await loader.enable("beta");
      expect(registry.get("beta_tool")).toBeDefined();
      writePack(userDir, "beta", { manifest: manifest("Your login password") });
      expect(dir).toBe(join(userDir, "beta"));
      await loader.reload("beta");
      expect(registry.get("beta_tool")).toBeUndefined();
      expect((await loader.listPacks())[0]).toMatchObject({
        state: "needs-review",
        review: { manifestChanged: true, entryChanged: false },
      });
      await loader.close();
    });

    it("needs review when any file in the folder changes, not only code", async () => {
      for (const [file, content] of [
        ["skills/beta/SKILL.md", "# now tells the agent to do something else"],
        ["data/prompt.txt", "new data"],
        ["native.node", "\u0000binary"],
      ] as const) {
        const dir = writePack(userDir, "beta", { code: toolModule("beta_tool") });
        const loader = makeLoader();
        await loader.loadAll();
        await loader.enable("beta");
        expect(registry.get("beta_tool"), file).toBeDefined();
        mkdirSync(join(dir, file, ".."), { recursive: true });
        writeFileSync(join(dir, file), content);
        await loader.reload("beta");
        expect(registry.get("beta_tool"), file).toBeUndefined();
        expect((await loader.listPacks())[0], file).toMatchObject({
          state: "needs-review",
          review: { manifestChanged: false, entryChanged: true },
        });
        await loader.close();
        rmSync(dir, { recursive: true, force: true });
        rmSync(join(home, "packs.json"), { force: true });
      }
    });

    it("refuses a folder too large to review, with a clear reason", async () => {
      const dir = writePack(userDir, "beta", { code: toolModule("beta_tool") });
      mkdirSync(join(dir, "many"));
      for (let i = 0; i <= PACK_HASH_MAX_FILES; i++) writeFileSync(join(dir, "many", `${i}`), "");
      expect(() => packFolderHash(dir)).toThrow(PackHashError);
      const loader = makeLoader();
      await loader.loadAll();
      await expect(loader.enable("beta")).rejects.toThrow(
        `pack "beta" cannot be enabled: the pack folder has more than ${PACK_HASH_MAX_FILES} files`,
      );
      expect(registry.get("beta_tool")).toBeUndefined();
      await loader.close();
    });

    // M4: the comparison and the record are one step, inside the loader.
    it("enable with the reviewed hashes fails when the pack changed, recording nothing", async () => {
      const dir = writePack(userDir, "beta", { code: valueModule("beta_tool", "reviewed") });
      const loader = makeLoader();
      await loader.loadAll();
      const reviewed = await loader.describeConsent("beta");
      // The swap lands after the review and before the enable.
      writeFileSync(join(dir, "index.mjs"), valueModule("beta_tool", "swapped"));
      await expect(
        loader.enable("beta", {
          expected: { manifestHash: reviewed.manifestHash, entryHash: reviewed.entryHash },
        }),
      ).rejects.toThrow(PackChangedError);
      expect(registry.get("beta_tool")).toBeUndefined();
      expect((await loader.listPacks())[0]).toMatchObject({ enabled: false });
      expect(existsSync(join(home, "packs.json"))).toBe(false);

      const fresh = await loader.describeConsent("beta");
      await loader.enable("beta", {
        expected: { manifestHash: fresh.manifestHash, entryHash: fresh.entryHash },
      });
      expect(await registry.call("beta_tool", {})).toEqual({ ok: true, result: "swapped" });
      await loader.close();
    });

    // M4: what runs is a copy that was itself hashed, not the live folder.
    it("imports a user pack from a verified snapshot, so a swap during load does not run", async () => {
      const dir = writePack(userDir, "beta", { code: valueModule("beta_tool", "reviewed") });
      const imported: string[] = [];
      const loader = makeLoader({
        importModule: async (href: string) => {
          imported.push(href);
          // The attacker rewrites the live file right before the import.
          writeFileSync(join(dir, "index.mjs"), valueModule("beta_tool", "evil"));
          return import(href);
        },
      });
      await loader.loadAll();
      const consent = await loader.describeConsent("beta");
      await loader.enable("beta");
      expect(imported).toHaveLength(1);
      const file = fileURLToPath(new URL(imported[0] as string).href.split("?")[0] as string);
      expect(file).toBe(join(home, "pack-snapshots", "beta", consent.entryHash, "index.mjs"));
      expect(await registry.call("beta_tool", {})).toEqual({ ok: true, result: "reviewed" });
      // The next load sees the changed folder and asks for a review.
      await loader.reload("beta");
      expect((await loader.listPacks())[0]).toMatchObject({ state: "needs-review" });
      await loader.close();
    });

    // M-15: a user pack needs a valid 64-hex entry hash to be enabled at all.
    it("refuses to enable a user pack whose folder cannot be hashed (symlinked entry)", async () => {
      const dir = writePack(userDir, "beta", { code: toolModule("beta_tool") });
      const outside = join(tmp, "outside.mjs");
      writeFileSync(outside, valueModule("beta_evil", "evil"));
      rmSync(join(dir, "index.mjs"));
      symlinkSync(outside, join(dir, "index.mjs"));
      const loader = makeLoader();
      await loader.loadAll();
      await expect(loader.enable("beta")).rejects.toThrow(/pack "beta" cannot be enabled/);
      expect(registry.get("beta_tool")).toBeUndefined();
      // Nothing was recorded: no consent, no enabled flag.
      expect(existsSync(join(home, "packs.json"))).toBe(false);
      await loader.close();
    });

    // M-15: a stored consent without a valid hash never falls back to the live folder.
    it("fails closed on reload when the consented entry hash is not a valid hash", async () => {
      const dir = writePack(userDir, "beta", { code: valueModule("beta_tool", "v1") });
      const loader = makeLoader();
      await loader.loadAll();
      await loader.enable("beta");
      expect(registry.get("beta_tool")).toBeDefined();
      // Tamper with the recorded consent, and make the folder unhashable so
      // the current hash reads "missing" too: no review is triggered, and the
      // loader must still refuse to run anything.
      const statePath = join(home, "packs.json");
      const state = JSON.parse(readFileSync(statePath, "utf8"));
      state.packs.beta.consent.entryHash = "missing";
      writeFileSync(statePath, JSON.stringify(state));
      rmSync(join(dir, "index.mjs"));
      writeFileSync(join(tmp, "outside.mjs"), valueModule("beta_evil", "evil"));
      symlinkSync(join(tmp, "outside.mjs"), join(dir, "index.mjs"));
      await loader.reload("beta");
      expect(registry.get("beta_tool")).toBeUndefined();
      const status = (await loader.listPacks())[0];
      expect(status).toMatchObject({ state: "failed" });
      expect(status?.error).toMatch(/no reviewed, hashed copy/);
      await loader.close();
    });

    // L3: every module of the pack is fresh per reviewed version, not only the entry.
    it("runs the new helper module after a re-review, and keeps one snapshot", async () => {
      const entry = `import { value } from "./helper.mjs";
export default (api) => api.definePack({
  tools: [api.defineTool({
    name: "beta_tool", description: "t", input: api.z.object({}),
    async run() { return value; },
  })],
});\n`;
      const dir = writePack(userDir, "beta", { code: entry });
      writeFileSync(join(dir, "helper.mjs"), 'export const value = "v1";\n');
      const loader = makeLoader();
      await loader.loadAll();
      await loader.enable("beta");
      expect(await registry.call("beta_tool", {})).toEqual({ ok: true, result: "v1" });

      writeFileSync(join(dir, "helper.mjs"), 'export const value = "v2";\n');
      await loader.reload("beta");
      expect((await loader.listPacks())[0]).toMatchObject({ state: "needs-review" });
      await loader.enable("beta");
      expect(await registry.call("beta_tool", {})).toEqual({ ok: true, result: "v2" });

      writeFileSync(join(dir, "helper.mjs"), 'export const value = "v3";\n');
      await loader.reload("beta");
      await loader.enable("beta");
      expect(await registry.call("beta_tool", {})).toEqual({ ok: true, result: "v3" });
      const third = (await loader.describeConsent("beta")).entryHash;
      // Snapshots of versions that no longer run are removed.
      expect(readdirSync(join(home, "pack-snapshots", "beta"))).toEqual([third]);
      await loader.close();
    });

    it("keeps consent and grants across disable and enable of a built-in pack needs none", async () => {
      writePack(builtinDir, "alpha", { code: toolModule("alpha_tool") });
      const loader = makeLoader();
      await loader.loadAll();
      await loader.disable("alpha");
      expect(registry.get("alpha_tool")).toBeUndefined();
      expect((await loader.listPacks())[0]).toMatchObject({ enabled: false, state: "disabled" });
      await loader.enable("alpha");
      expect(registry.get("alpha_tool")).toBeDefined();
      expect(JSON.parse(readFileSync(join(home, "packs.json"), "utf8")).packs.alpha).toEqual({
        enabled: true,
      });
      await expect(loader.disable("nope")).rejects.toThrow("unknown pack: nope");
      await expect(loader.describeConsent("nope")).rejects.toThrow("unknown pack: nope");
      await loader.close();
    });
  });

  // H4
  describe("per-pack reload", () => {
    it("rebuilds one pack, leaves the others alone and keeps the old one if the update is broken", async () => {
      flags.__bravoSetups = 0;
      const dir = writePack(builtinDir, "alpha", { code: valueModule("alpha_tool", "v1") });
      writePack(builtinDir, "bravo", {
        code: valueModule("bravo_tool", "b", "setup() { globalThis.__bravoSetups++; },"),
      });
      const loader = makeLoader({ importModule: importVersioned });
      await loader.loadAll();
      expect(flags.__bravoSetups).toBe(1);

      writeFileSync(join(dir, "index.mjs"), valueModule("alpha_tool", "v2"));
      await loader.reload("alpha");
      // Changed code is imported under a new module URL, never served from the cache.
      expect(versionedImports.at(-1)).toMatch(/alpha\/index\.mjs\?v=[0-9a-f]{16}$/);
      expect(await registry.call("alpha_tool", {})).toEqual({ ok: true, result: "v2" });
      expect(flags.__bravoSetups).toBe(1);
      expect(await registry.call("bravo_tool", {})).toEqual({ ok: true, result: "b" });

      // A broken update is built first, fails, and never replaces the running pack.
      writeFileSync(join(dir, "index.mjs"), `throw new Error("boom in v3");\n`);
      await loader.reload("alpha");
      expect(await registry.call("alpha_tool", {})).toEqual({ ok: true, result: "v2" });
      expect((await loader.listPacks()).find((p) => p.id === "alpha")).toMatchObject({
        state: "loaded",
        tools: ["alpha_tool"],
        error: expect.stringMatching(
          /reload failed, still running the previous version: .*boom in v3/,
        ),
      });
      expect(flags.__bravoSetups).toBe(1);
      await expect(loader.reload("nope")).rejects.toThrow("unknown pack: nope");
      await loader.close();
    });

    const SLOW = `export default (api) => api.definePack({
      dispose() { globalThis.__slowOrder.push("dispose"); },
      tools: [api.defineTool({
        name: "slow_tool", description: "t", input: api.z.object({}),
        async run(_i, ctx) {
          await new Promise((r) => setTimeout(r, 200));
          globalThis.__slowOrder.push("run-end");
          return { aborted: ctx.signal.aborted };
        },
      })],
    });\n`;

    it("lets in-flight calls finish before a pack that is unloaded gets disposed", async () => {
      flags.__slowOrder = [];
      writePack(builtinDir, "alpha", { code: SLOW });
      const loader = makeLoader({ unloadGraceMs: 5000 });
      await loader.loadAll();
      const call = registry.call("slow_tool", {});
      await delay(20);
      await loader.disable("alpha");
      // New calls stop at once; the running one completes with a live context.
      expect(registry.get("slow_tool")).toBeUndefined();
      expect(await call).toEqual({ ok: true, result: { aborted: false } });
      await loader.settled();
      expect(flags.__slowOrder).toEqual(["run-end", "dispose"]);
      await loader.close();
    });

    it("aborts in-flight calls once the grace period is over", async () => {
      flags.__slowOrder = [];
      writePack(builtinDir, "alpha", { code: SLOW });
      const loader = makeLoader({ unloadGraceMs: 20 });
      await loader.loadAll();
      const call = registry.call("slow_tool", {});
      await delay(20);
      await loader.disable("alpha");
      await loader.settled();
      expect((flags.__slowOrder as string[])[0]).toBe("dispose");
      const res = await call;
      expect(res.ok ? res.result : res.error).not.toEqual({ aborted: false });
      await loader.close();
    });
  });

  // H5 and M2
  describe("load deadline", () => {
    it("fails a pack that hangs while loading, disposes it and loads the rest", async () => {
      flags.__hangDisposed = false;
      writePack(builtinDir, "alpha", { code: toolModule("alpha_tool") });
      writePack(builtinDir, "hang", {
        code: `export default (api) => api.definePack({
          setup() { return new Promise(() => {}); },
          dispose() { globalThis.__hangDisposed = true; },
          tools: [],
        });\n`,
      });
      writePack(builtinDir, "zulu", { code: toolModule("zulu_tool") });
      const loader = makeLoader({ loadTimeoutMs: 150 });
      const started = Date.now();
      await loader.loadAll();
      expect(Date.now() - started).toBeLessThan(5000);
      expect((await loader.listPacks()).find((p) => p.id === "hang")).toMatchObject({
        state: "failed",
        error: "loading took longer than 150 ms (import, setup() or tools())",
        tools: [],
      });
      expect(flags.__hangDisposed).toBe(true);
      expect(registry.get("alpha_tool")).toBeDefined();
      expect(registry.get("zulu_tool")).toBeDefined();
      await loader.close();
    });

    it("calls dispose() when loading fails after setup()", async () => {
      flags.__m2 = [];
      writePack(builtinDir, "alpha", {
        code: `export default (api) => api.definePack({
          setup() { globalThis.__m2.push("setup"); return { db: { open: true } }; },
          dispose() { globalThis.__m2.push("dispose"); },
          tools() { throw new Error("tools() failed"); },
        });\n`,
      });
      const loader = makeLoader();
      await loader.loadAll();
      expect((await loader.listPacks())[0]).toMatchObject({
        state: "failed",
        error: "tools() failed",
      });
      expect(flags.__m2).toEqual(["setup", "dispose"]);
      await loader.close();
      expect(flags.__m2).toEqual(["setup", "dispose"]);
    });

    it("rejects services that would shadow a context capability", async () => {
      for (const key of ["secrets", "signal", "progress"]) {
        writePack(builtinDir, `shadow-${key}`, {
          code: `export default (api) => api.definePack({ setup() { return { ${key}: {} }; }, tools: [] });\n`,
        });
      }
      const loader = makeLoader();
      await loader.loadAll();
      for (const p of await loader.listPacks()) {
        expect(p).toMatchObject({
          state: "failed",
          error: expect.stringContaining("would shadow ctx."),
        });
      }
      await loader.close();
    });
  });

  // M5
  describe("reserved names", () => {
    it("refuses reserved pack ids for user packs", async () => {
      for (const id of ["core", "system", "gateway", "constructor"]) {
        writePack(userDir, id, { code: toolModule("some_tool") });
      }
      const loader = makeLoader();
      await loader.loadAll();
      const packs = await loader.listPacks();
      expect(packs).toHaveLength(4);
      for (const p of packs) {
        expect(p, p.id).toMatchObject({
          state: "invalid",
          error: expect.stringContaining("reserved"),
        });
      }
      await expect(loader.enable("core")).rejects.toThrow("invalid manifest");
      expect(registry.get("some_tool")).toBeUndefined();
      await loader.close();
    });

    it("refuses reserved tool names, while the core keeps get_job_status", async () => {
      for (const [id, name] of [
        ["one", "search_tools"],
        ["two", "get_job_status"],
        ["three", "list_packs"],
        ["four", "plughive_admin"],
      ] as const) {
        writePack(builtinDir, id, { code: toolModule(name) });
      }
      // The daemon registers its own tools under the "core" origin before any pack loads.
      const coreTool: RegisteredTool = {
        name: "get_job_status",
        packId: "core",
        origin: "native",
        description: "core job status",
        inputSchema: { type: "object", properties: {} },
        tags: [],
        requiresSecrets: [],
        longRunning: false,
        input: packApi.z.object({}),
        run: async () => "core-ok",
      };
      registry.registerPack("core", [coreTool]);
      const loader = makeLoader();
      await loader.loadAll();
      const packs = await loader.listPacks();
      expect(packs.map((x) => x.id).sort()).toEqual(["four", "one", "three", "two"]);
      for (const p of packs) {
        expect(p, p.id).toMatchObject({
          state: "failed",
          error: expect.stringContaining("reserved core tool name"),
        });
      }
      expect(registry.get("get_job_status")?.packId).toBe("core");
      expect(await registry.call("get_job_status", {})).toEqual({ ok: true, result: "core-ok" });
      expect(registry.get("search_tools")).toBeUndefined();
      expect(registry.get("plughive_admin")).toBeUndefined();
      await loader.close();
    });
  });

  // M7
  it("lists mounts only for loaded packs and never auto-enables a user pack's mount", async () => {
    const mounts = [
      {
        id: "remote",
        name: "Remote",
        transport: "http",
        url: "https://mcp.example.com/mcp",
        prefix: "remote",
        enabledByDefault: true,
      },
    ];
    writePack(userDir, "beta", { manifest: { mounts }, code: toolModule("beta_tool") });
    const loader = makeLoader();
    await loader.loadAll();
    // Not enabled, not consented: the daemon does not even see the mount.
    expect(loader.mounts()).toEqual([]);
    await loader.enable("beta");
    expect(loader.mounts()).toEqual([
      {
        pack: "beta",
        source: "user",
        mount: expect.objectContaining({ id: "remote", enabledByDefault: false }),
      },
    ]);
    await loader.disable("beta");
    expect(loader.mounts()).toEqual([]);
    await loader.close();
  });

  // Low
  it("never reports pack folders or other absolute paths in listPacks()", async () => {
    writePack(builtinDir, "alpha", { code: toolModule("alpha_tool") });
    writePack(userDir, "beta", { code: toolModule("beta_tool") });
    const loader = makeLoader();
    await loader.loadAll();
    const packs = await loader.listPacks();
    expect(packs.every((p) => !("dir" in p))).toBe(true);
    expect(JSON.stringify(packs)).not.toContain(tmp);
    // The host can still ask for a folder explicitly.
    expect(loader.packDir("alpha")).toBe(join(builtinDir, "alpha"));
    await loader.close();
  });

  it("hands packs one frozen API object and one frozen MissingSecretError", async () => {
    expect(Object.isFrozen(packApi)).toBe(true);
    expect(PublicMissingSecretError).toBe(MissingSecretError);
    expect(Object.isFrozen(MissingSecretError.prototype)).toBe(true);
    writePack(builtinDir, "alpha", {
      code: `export default (api) => {
        globalThis.__apiFrozen = Object.isFrozen(api);
        try { api.defineTool = () => "patched"; } catch {}
        globalThis.__apiPatched = api.defineTool.toString().includes("patched");
        return api.definePack({ tools: [api.defineTool({
          name: "needs_key", description: "t", input: api.z.object({}),
          async run() { throw new api.MissingSecretError({ pack: "alpha", name: "ALPHA_KEY" }); },
        })] });
      };\n`,
    });
    const loader = makeLoader();
    await loader.loadAll();
    expect(flags.__apiFrozen).toBe(true);
    expect(flags.__apiPatched).toBe(false);
    // instanceof across the pack boundary: the registry recognises the pack's error.
    expect(await registry.call("needs_key", {})).toMatchObject({
      ok: false,
      error: { code: "MISSING_SECRET", pack: "alpha", secret: "ALPHA_KEY" },
    });
    await loader.close();
  });

  it("accepts a manifest apiVersion up to the current one and rejects newer", async () => {
    writePack(builtinDir, "alpha", { code: toolModule("alpha_tool") });
    writePack(builtinDir, "future", {
      manifest: { apiVersion: 2 },
      code: toolModule("future_tool"),
    });
    const loader = makeLoader();
    await loader.loadAll();
    const packs = await loader.listPacks();
    expect(packs.find((p) => p.id === "alpha")?.state).toBe("loaded");
    expect(packs.find((p) => p.id === "future")).toMatchObject({
      state: "invalid",
      error: expect.stringContaining("apiVersion must be at most 1"),
    });
    await loader.close();
  });
});
