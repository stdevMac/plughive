// Tests for examples/hello-pack, the pack that docs/writing-a-pack.md walks
// through. The first block runs its tools against createTestContext; the
// second loads the folder through the real loader as a user pack.
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type AnyToolDefinition, type PackDefinition, packApi } from "plughive/pack";
import { type TestContext, createMemoryLibrary, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it } from "vitest";
import { PackLoader } from "../../src/core/packs/loader.js";
import { createSecretStore } from "../../src/core/secrets/index.js";
import { ToolRegistry } from "../../src/core/tools/registry.js";

const packDir = fileURLToPath(new URL("../../examples/hello-pack", import.meta.url));
const silent = { debug() {}, info() {}, warn() {}, error() {} };

type PackFactory = (api: typeof packApi) => PackDefinition | Promise<PackDefinition>;

/** Imports the entry the way the loader does and calls the factory with the pack API. */
async function loadPack(): Promise<PackDefinition> {
  const mod = (await import(pathToFileURL(join(packDir, "index.js")).href)) as {
    default: PackFactory;
  };
  return mod.default(packApi);
}

type Library = Pick<ReturnType<typeof createMemoryLibrary>, "readBytes">;

async function noteText(library: Library | null | undefined, id: string): Promise<string> {
  if (!library?.readBytes) throw new Error("no library");
  return new TextDecoder().decode(await library.readBytes(id));
}

function tool(pack: PackDefinition, name: string): AnyToolDefinition {
  const found = (pack.tools as AnyToolDefinition[]).find((t) => t.name === name);
  if (!found) throw new Error(`${name} missing`);
  return found;
}

/** Validates the arguments like the daemon does, then runs the tool. */
async function call(t: TestContext, def: AnyToolDefinition, args: unknown): Promise<unknown> {
  const input = def.input.parse(args);
  return def.run(input, t.forTool(def.name));
}

describe("hello-pack tools", () => {
  let t: TestContext | undefined;
  afterEach(async () => {
    await t?.dispose();
    t = undefined;
  });

  it("greets by name", async () => {
    t = createTestContext({ packDir, source: "user" });
    const pack = await loadPack();
    expect(await call(t, tool(pack, "hello_greet"), { name: " Ada " })).toEqual({
      greeting: "Hello, Ada!",
    });
  });

  it("rejects an empty name", async () => {
    const pack = await loadPack();
    expect(() => tool(pack, "hello_greet").input.parse({ name: "" })).toThrow();
  });

  it("saves a note to the library", async () => {
    t = createTestContext({ packDir, source: "user" });
    const pack = await loadPack();
    const out = (await call(t, tool(pack, "hello_save_note"), {
      title: "Groceries",
      body: "Milk",
    })) as { id: string; url: string };
    expect(out.url).toBe(`http://127.0.0.1:7777/artifacts/${out.id}`);
    const rows = t.library?.all() ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mime).toBe("text/markdown");
    expect(rows[0]?.tool).toBe("hello-pack/hello_save_note");
    const text = await noteText(t.library, out.id);
    expect(text).toBe("# Groceries\n\nMilk\n");
  });

  it("leaves the signature out when the key is granted but not saved", async () => {
    t = createTestContext({ packDir, source: "user", grants: ["HELLO_SIGNATURE"] });
    const pack = await loadPack();
    const out = (await call(t, tool(pack, "hello_save_note"), {
      title: "Hi",
      body: "Text",
    })) as { id: string };
    expect(await noteText(t.library, out.id)).toBe("# Hi\n\nText\n");
  });
});

describe("hello-pack through the loader", () => {
  let home: string | undefined;
  afterEach(() => {
    if (home) rmSync(home, { recursive: true, force: true });
    home = undefined;
  });

  it("stays off until enabled, then registers its tools and reads the granted key", async () => {
    home = mkdtempSync(join(tmpdir(), "plughive-hello-"));
    const userDir = join(home, "packs");
    const builtinDir = join(home, "no-builtin");
    mkdirSync(builtinDir);
    cpSync(packDir, join(userDir, "hello-pack"), { recursive: true });
    const registry = new ToolRegistry();
    const store = createSecretStore({ home, env: {}, backend: "memory" });
    await store.set("HELLO_SIGNATURE", "Ada");
    const library = createMemoryLibrary();
    const loader = new PackLoader({
      home,
      registry,
      host: { store, logger: silent, library },
      userDir,
      builtinDir,
    });
    try {
      await loader.loadAll();
      const before = (await loader.listPacks()).find((p) => p.id === "hello-pack");
      expect(before?.enabled).toBe(false);
      expect(registry.list().map((x) => x.name)).not.toContain("hello_greet");

      await loader.enable("hello-pack", { grants: ["HELLO_SIGNATURE"] });
      await loader.settled();
      const after = (await loader.listPacks()).find((p) => p.id === "hello-pack");
      expect(after?.state).toBe("loaded");
      expect(after?.tools.sort()).toEqual(["hello_greet", "hello_save_note"]);

      const out = (await registry.invoke("hello_save_note", { title: "Hi", body: "Text" })) as {
        id: string;
      };
      expect(await noteText(library, out.id)).toBe("# Hi\n\nText\n\n-- Ada\n");
    } finally {
      await loader.close();
    }
  });
});
