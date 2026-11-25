import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import type { AnyToolDefinition, PackContext, PackDefinition } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import memoryPack, { createMemoryPack } from "../../../packs/memory/index.js";
import { MemoryStore, cosine, fromBlob, toBlob } from "../../../packs/memory/store.js";
import { CapabilityRouter } from "../../../src/core/capabilities/router.js";
import type { HostCapabilities } from "../../../src/core/packs/context.js";
import { PackLoader } from "../../../src/core/packs/loader.js";
import { createSecretStore } from "../../../src/core/secrets/index.js";
import { ToolRegistry } from "../../../src/core/tools/registry.js";

const PACK_DIR = fileURLToPath(new URL("../../../packs/memory", import.meta.url));
const DIMS = 32;

/** Deterministic bag-of-words embedding: each word adds 1 to a hashed slot. */
function fakeEmbed(text: string, dims = DIMS): number[] {
  const v = new Array<number>(dims).fill(0);
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    let h = 2166136261;
    for (const ch of word) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    v[h % dims] = (v[h % dims] as number) + 1;
  }
  // Never all-zero.
  v[dims - 1] = (v[dims - 1] as number) + 0.01;
  return v;
}

interface EmbedState {
  provider: string;
  model: string;
  dims: number;
}

function makeRouter(state: EmbedState) {
  const run = vi.fn(async (cap: string, input: unknown, opts: { provider?: string }) => {
    expect(cap).toBe("text.embed");
    const { texts } = input as { texts: string[] };
    return {
      embeddings: texts.map((t) => fakeEmbed(t, state.dims)),
      model: state.model,
      dimensions: state.dims,
      provider: opts.provider ?? state.provider,
    };
  });
  const router = {
    run,
    list: vi.fn(async () => []),
    has: () => true,
  } as unknown as HostCapabilities;
  return { run, router };
}

const harnesses: TestContext[] = [];
const packs: PackDefinition[] = [];
afterEach(async () => {
  for (const p of packs.splice(0)) await p.dispose?.();
  for (const t of harnesses.splice(0)) await t.dispose();
});

function tool(pack: PackDefinition, name: string): AnyToolDefinition {
  const tools = pack.tools;
  if (!Array.isArray(tools)) throw new Error("expected a static tool list");
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} missing`);
  return t;
}

function setup(opts: { vec: boolean; state?: EmbedState; dataDir?: string }) {
  const state = opts.state ?? { provider: "fake", model: "fake-embed-1", dims: DIMS };
  const { run, router } = makeRouter(state);
  const t = createTestContext({
    packDir: PACK_DIR,
    capabilityRouter: router,
    ...(opts.dataDir ? { dataDir: opts.dataDir } : {}),
  });
  harnesses.push(t);
  const pack = opts.vec ? createMemoryPack() : createMemoryPack({ loadVectorExtension: false });
  packs.push(pack);
  const call = async (name: string, args: unknown): Promise<Record<string, unknown>> => {
    const def = tool(pack, name);
    const ctx: PackContext = t.forTool(name);
    return (await def.run(def.input.parse(args), ctx)) as Record<string, unknown>;
  };
  return { call, run, state, t, pack };
}

const FACTS = [
  { id: "cat", text: "The cat sleeps on the warm windowsill", tags: ["pets"] },
  { id: "dog", text: "The dog barks at the mail carrier", tags: ["pets", "noise"] },
  { id: "rust", text: "Rust borrow checker ownership lifetimes", tags: ["code"] },
  { id: "deploy", text: "Deploy the daemon with systemd user service", tags: ["code", "ops"] },
];

describe("memory pack manifest and tools", () => {
  it("declares the tools with honest annotations", () => {
    const names = (memoryPack.tools as AnyToolDefinition[]).map((t) => t.name);
    expect(names).toEqual([
      "remember",
      "recall",
      "forget",
      "list_memory_collections",
      "list_memories",
    ]);
    expect(tool(memoryPack, "forget").annotations).toMatchObject({
      destructiveHint: true,
      readOnlyHint: false,
    });
    expect(tool(memoryPack, "recall").annotations).toMatchObject({ readOnlyHint: true });
    expect(tool(memoryPack, "list_memories").annotations).toMatchObject({ readOnlyHint: true });
  });

  it("needs the cap:text.embed grant", async () => {
    const { router } = makeRouter({ provider: "fake", model: "m", dims: DIMS });
    const t = createTestContext({
      manifest: {
        id: "memory",
        name: "Memory",
        version: "0.1.0",
        apiVersion: 1,
        entry: "./index.js",
        description: "no grant",
      },
      capabilityRouter: router,
    });
    harnesses.push(t);
    const pack = createMemoryPack({ loadVectorExtension: false });
    packs.push(pack);
    const def = tool(pack, "remember");
    await expect(
      def.run(def.input.parse({ text: "hello" }), t.forTool("remember")),
    ).rejects.toThrow(/cap:text\.embed/);
  });

  it("validates inputs", () => {
    const remember = tool(memoryPack, "remember");
    expect(() => remember.input.parse({})).toThrow();
    expect(() => remember.input.parse({ text: "a", items: [{ text: "b" }] })).toThrow();
    expect(() => remember.input.parse({ items: [{ text: "b" }], tags: ["x"] })).toThrow();
    expect(() => remember.input.parse({ text: "a", collection: "../etc" })).toThrow();
    expect(() =>
      remember.input.parse({ text: "a", metadata: { big: "x".repeat(20_000) } }),
    ).toThrow();
    expect(remember.input.parse({ text: "a" })).toMatchObject({ collection: "default" });
    const forget = tool(memoryPack, "forget");
    expect(() => forget.input.parse({ id: "a", confirm: "default" })).toThrow();
    expect(() => forget.input.parse({ id: "a", ids: ["b"] })).toThrow();
  });
});

for (const vec of [true, false]) {
  describe(`memory pack (${vec ? "sqlite-vec" : "JS fallback"})`, () => {
    it("remembers, recalls by meaning and ranks the closest first", async () => {
      const { call, run } = setup({ vec });
      const r = await call("remember", { items: FACTS, collection: "notes" });
      expect(r).toMatchObject({
        collection: "notes",
        created_collection: true,
        provider: "fake",
        model: "fake-embed-1",
        dimensions: DIMS,
      });
      expect((r.remembered as unknown[]).length).toBe(4);
      expect(run.mock.calls[0]?.[1]).toMatchObject({ input_type: "document" });

      const hit = await call("recall", {
        query: "where does the cat sleep",
        collection: "notes",
        k: 2,
      });
      expect(hit.mode).toBe(vec ? "sqlite-vec" : "js");
      const results = hit.results as { id: string; score: number; tags: string[] }[];
      expect(results).toHaveLength(2);
      expect(results[0]?.id).toBe("cat");
      expect(results[0]?.tags).toEqual(["pets"]);
      expect(results[0]?.score).toBeGreaterThan(results[1]?.score as number);
      // The query is embedded as a query, pinned to the collection's provider and model.
      const [, input, opts] = run.mock.calls.at(-1) as unknown as [
        string,
        Record<string, unknown>,
        object,
      ];
      expect(input).toMatchObject({ input_type: "query", model: "fake-embed-1" });
      expect(input.dimensions).toBeUndefined();
      expect(opts).toEqual({ provider: "fake" });

      const code = await call("recall", { query: "rust ownership", collection: "notes", k: 1 });
      expect((code.results as { id: string }[])[0]?.id).toBe("rust");
    });

    it("scores match plain cosine similarity", async () => {
      const { call } = setup({ vec });
      await call("remember", { items: FACTS });
      const q = "the dog and the cat";
      const out = await call("recall", { query: q, k: 4 });
      for (const r of out.results as { id: string; score: number }[]) {
        const text = FACTS.find((f) => f.id === r.id)?.text as string;
        expect(r.score).toBeCloseTo(cosine(fakeEmbed(q), fakeEmbed(text)), 4);
      }
    });

    it("filters by tags and min_score", async () => {
      const { call } = setup({ vec });
      await call("remember", { items: FACTS });
      const code = await call("recall", { query: "the cat sleeps", tags: ["code"], k: 10 });
      expect((code.results as { id: string }[]).map((r) => r.id).sort()).toEqual([
        "deploy",
        "rust",
      ]);
      const both = await call("recall", { query: "anything", tags: ["code", "ops"], k: 10 });
      expect((both.results as { id: string }[]).map((r) => r.id)).toEqual(["deploy"]);
      const strict = await call("recall", {
        query: "The cat sleeps on the warm windowsill",
        min_score: 0.99,
      });
      expect((strict.results as { id: string }[]).map((r) => r.id)).toEqual(["cat"]);
    });

    it("replaces a memory remembered again with the same id", async () => {
      const { call } = setup({ vec });
      await call("remember", { text: "favourite colour is blue", id: "colour", tags: ["pref"] });
      const again = await call("remember", {
        text: "favourite colour is green",
        id: "colour",
        metadata: { source: "chat" },
      });
      expect(again.remembered).toEqual([{ id: "colour", replaced: true }]);
      const page = await call("list_memories", {});
      expect(page.memories).toEqual([
        expect.objectContaining({
          id: "colour",
          text: "favourite colour is green",
          tags: [],
          metadata: { source: "chat" },
        }),
      ]);
      const hit = await call("recall", { query: "favourite colour green", k: 5 });
      expect(hit.results).toHaveLength(1);
    });

    it("lists collections with counts, model and dimensions, and pages memories", async () => {
      const { call } = setup({ vec });
      await call("remember", { items: FACTS, collection: "a" });
      await call("remember", { text: "one more", collection: "b" });
      const cols = await call("list_memory_collections", {});
      expect(cols.mode).toBe(vec ? "sqlite-vec" : "js");
      if (vec) expect(cols.sqlite_vec_version).toMatch(/^v\d/);
      else expect(cols.fallback_reason).toBeTruthy();
      expect(cols.collections).toEqual([
        expect.objectContaining({
          name: "a",
          count: 4,
          provider: "fake",
          model: "fake-embed-1",
          dimensions: DIMS,
        }),
        expect.objectContaining({ name: "b", count: 1 }),
      ]);

      const p1 = await call("list_memories", { collection: "a", limit: 3 });
      expect((p1.memories as { id: string }[]).map((m) => m.id)).toEqual(["deploy", "rust", "dog"]);
      expect(p1.next_cursor).toEqual(expect.any(String));
      const p2 = await call("list_memories", { collection: "a", limit: 3, cursor: p1.next_cursor });
      expect((p2.memories as { id: string }[]).map((m) => m.id)).toEqual(["cat"]);
      expect(p2.next_cursor).toBeNull();
      const pets = await call("list_memories", { collection: "a", tags: ["pets"] });
      expect((pets.memories as { id: string }[]).map((m) => m.id)).toEqual(["dog", "cat"]);
    });

    it("forgets by id, and a collection only with confirmation", async () => {
      const { call } = setup({ vec });
      await call("remember", { items: FACTS, collection: "notes" });
      const del = await call("forget", { collection: "notes", ids: ["dog", "nope"] });
      expect(del).toMatchObject({ deleted: ["dog"], not_found: ["nope"] });
      const hit = await call("recall", { query: "dog barks", collection: "notes", k: 10 });
      expect((hit.results as { id: string }[]).map((r) => r.id)).not.toContain("dog");

      const dry = await call("forget", { collection: "notes" });
      expect(dry).toMatchObject({ dry_run: true, would_delete: 3, deleted_collection: false });
      const wrong = await call("forget", { collection: "notes", confirm: "Notes" });
      expect(wrong).toMatchObject({ dry_run: true, deleted_collection: false });
      expect(((await call("list_memory_collections", {})).collections as unknown[]).length).toBe(1);

      const gone = await call("forget", { collection: "notes", confirm: "notes" });
      expect(gone).toMatchObject({ deleted_collection: true, deleted_count: 3 });
      expect((await call("list_memory_collections", {})).collections).toEqual([]);
      await expect(call("recall", { query: "x", collection: "notes" })).rejects.toThrow(
        /no memory collection/,
      );
      expect(await call("forget", { collection: "notes", confirm: "notes" })).toMatchObject({
        not_found: true,
      });
    });

    it("refuses embeddings from a different model or dimension count", async () => {
      const { call, state } = setup({ vec });
      await call("remember", { text: "pinned to the first model" });
      state.model = "other-model";
      await expect(call("remember", { text: "second" })).rejects.toThrow(
        /pinned to fake\/fake-embed-1/,
      );
      await expect(call("recall", { query: "first" })).rejects.toThrow(
        /pinned to fake\/fake-embed-1/,
      );
      state.model = "fake-embed-1";
      state.dims = 16;
      await expect(call("remember", { text: "third" })).rejects.toThrow(/32 dimensions/);
      state.dims = DIMS;
      await expect(call("remember", { text: "fourth", model: "something-else" })).rejects.toThrow(
        /already uses model fake-embed-1/,
      );
      const page = await call("list_memories", {});
      expect(page.memories).toHaveLength(1);
      // A different collection can use another model.
      state.model = "other-model";
      state.dims = 16;
      const other = await call("remember", { text: "fine", collection: "other" });
      expect(other).toMatchObject({ model: "other-model", dimensions: 16 });
    });

    it("passes provider, model and dimensions when creating a collection, then pins them", async () => {
      const { call, run } = setup({ vec });
      await call("remember", {
        text: "x",
        provider: "fake",
        model: "fake-embed-1",
        dimensions: DIMS,
      });
      expect(run.mock.calls[0]?.[1]).toMatchObject({ model: "fake-embed-1", dimensions: DIMS });
      expect(run.mock.calls[0]?.[2]).toEqual({ provider: "fake" });
      await call("recall", { query: "x" });
      expect(run.mock.calls[1]?.[1]).toMatchObject({ model: "fake-embed-1", dimensions: DIMS });
    });

    it("stores the database in the pack data directory", async () => {
      const { call, t } = setup({ vec });
      await call("remember", { text: "where am I" });
      expect(existsSync(join(t.dataDir, "memory.db"))).toBe(true);
    });
  });
}

describe("memory store across modes", () => {
  it("a database written without sqlite-vec is re-indexed when the extension loads", async () => {
    const shared = createTestContext({ packDir: PACK_DIR });
    harnesses.push(shared);
    const dataDir = join(shared.dataDir, "shared");

    const js = setup({ vec: false, dataDir });
    await js.call("remember", { items: FACTS.slice(0, 2), collection: "keep" });
    await js.call("remember", { items: FACTS.slice(2), collection: "drop" });
    await js.pack.dispose?.();

    const v1 = setup({ vec: true, dataDir });
    const hit = await v1.call("recall", { query: "cat windowsill", collection: "keep", k: 1 });
    expect(hit.mode).toBe("sqlite-vec");
    expect((hit.results as { id: string }[])[0]?.id).toBe("cat");
    await v1.pack.dispose?.();

    // Changes made without the extension (a delete, a dropped collection, a new
    // memory) reach the index on the next sqlite-vec open.
    const js2 = setup({ vec: false, dataDir });
    await js2.call("forget", { collection: "keep", id: "cat" });
    await js2.call("remember", {
      text: "a parrot talks all day",
      id: "parrot",
      collection: "keep",
    });
    await js2.call("forget", { collection: "drop", confirm: "drop" });
    await js2.pack.dispose?.();

    const v2 = setup({ vec: true, dataDir });
    const after = await v2.call("recall", {
      query: "cat windowsill parrot",
      collection: "keep",
      k: 5,
    });
    expect((after.results as { id: string }[]).map((r) => r.id).sort()).toEqual(["dog", "parrot"]);
    await v2.pack.dispose?.();

    const db = new Database(join(dataDir, "memory.db"), { readonly: true });
    try {
      const tables = (
        db.prepare("SELECT name FROM sqlite_master WHERE name GLOB 'vec_[0-9]*'").all() as {
          name: string;
        }[]
      ).map((r) => r.name);
      // Only the surviving collection's vec0 table (and its shadow tables) remain.
      expect(new Set(tables.map((n) => n.match(/^vec_(\d+)/)?.[1]))).toEqual(new Set(["1"]));
    } finally {
      db.close();
    }
  });

  it("falls back to JS search when the extension fails to load", async () => {
    const t = createTestContext({ packDir: PACK_DIR });
    harnesses.push(t);
    const store = await MemoryStore.open(t.dataDir, () => {
      throw new Error("no extension here");
    });
    try {
      expect(store.mode).toBe("js");
      expect(store.fallbackReason).toBe("no extension here");
    } finally {
      store.close();
    }
  });

  it("round-trips float32 blobs", () => {
    const v = [0.5, -1.25, 3, 0];
    expect([...fromBlob(toBlob(v))]).toEqual(v);
    expect(cosine([1, 0], [0, 1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
  });
});

describe("memory pack through the real loader", () => {
  it("loads as a builtin pack with its five tools", async () => {
    const t = createTestContext({ packDir: PACK_DIR });
    harnesses.push(t);
    const home = join(t.dataDir, "home");
    const silent = { debug() {}, info() {}, warn() {}, error() {} };
    const loader = new PackLoader({
      home,
      registry: new ToolRegistry(),
      host: { store: createSecretStore({ home, env: {}, backend: "memory" }), logger: silent },
      userDir: join(home, "packs"),
      capabilities: new CapabilityRouter({ home, logger: silent }),
    });
    try {
      await loader.loadAll();
      const memory = (await loader.listPacks()).find((p) => p.id === "memory");
      expect(memory).toMatchObject({ source: "builtin", state: "loaded" });
      expect([...(memory?.tools ?? [])].sort()).toEqual([
        "forget",
        "list_memories",
        "list_memory_collections",
        "recall",
        "remember",
      ]);
    } finally {
      await loader.close();
    }
  });
});
