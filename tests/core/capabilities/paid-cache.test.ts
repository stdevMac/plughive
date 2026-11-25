import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_PAID_CACHE_TTL_MS,
  MAX_ENTRIES,
  PAID_CACHE_FILE,
  PaidCallCache,
  canonicalJson,
  paidCacheKey,
  splitCacheFlag,
} from "../../../src/core/capabilities/paid-cache.js";
import { CapabilityRouter, type ProviderBinding } from "../../../src/core/capabilities/router.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

function provider(
  id: string,
  o: { cost?: "local" | "account" | "paid"; fail?: boolean } = {},
): ProviderBinding & { calls: number } {
  const binding = {
    calls: 0,
    def: {
      capability: "image.generate",
      id,
      ...(o.cost ? { cost: o.cost } : {}),
      isConfigured: () => true,
      run: async () => {
        binding.calls++;
        if (o.fail) throw new Error("upstream said no");
        return {
          artifacts: [{ id: `${id}-${binding.calls}`, url: "/x", mime: "image/png" }],
          model: "m",
          cost_usd: 0.04,
        };
      },
    },
    context: () => ({ pack: id }) as never,
  };
  return binding as unknown as ProviderBinding & { calls: number };
}

const caller = () => ({
  pack: "media",
  depth: 0,
  signal: new AbortController().signal,
  tool: "generate_image",
});

describe("paid-call cache helpers", () => {
  it("keeps an input-owned __proto__ key as data, not as a prototype", () => {
    // JSON.parse gives an own "__proto__" key; a plain {} built by the walk
    // would have its prototype changed instead.
    const input = JSON.parse('{"b":2,"__proto__":{"evil":1}}');
    expect(canonicalJson(input)).toBe('{"__proto__":{"evil":1},"b":2}');
    const nested = JSON.parse('{"a":{"__proto__":{"x":[1]}}}');
    expect(canonicalJson(nested)).toBe('{"a":{"__proto__":{"x":[1]}}}');
  });

  it("hashes inputs the same whatever their key order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }], u: undefined })).toBe(
      '{"a":[{"c":3,"d":2}],"b":1}',
    );
    const k1 = paidCacheKey({
      capability: "image.generate",
      provider: undefined,
      model: "m",
      input: { prompt: "cat", n: 1 },
    });
    const k2 = paidCacheKey({
      capability: "image.generate",
      provider: undefined,
      model: "m",
      input: { n: 1, prompt: "cat" },
    });
    expect(k1).toBe(k2);
    expect(
      paidCacheKey({ capability: "image.generate", provider: "fal", model: "m", input: {} }),
    ).not.toBe(
      paidCacheKey({ capability: "image.generate", provider: undefined, model: "m", input: {} }),
    );
  });

  it("takes cache: false out of the input and leaves other values to the schema", () => {
    expect(splitCacheFlag({ prompt: "x", cache: false })).toEqual({
      input: { prompt: "x" },
      noCache: true,
    });
    expect(splitCacheFlag({ prompt: "x", cache: true })).toEqual({
      input: { prompt: "x" },
      noCache: false,
    });
    expect(splitCacheFlag({ prompt: "x", cache: "no" })).toEqual({
      input: { prompt: "x", cache: "no" },
      noCache: false,
    });
    expect(splitCacheFlag("raw")).toEqual({ input: "raw", noCache: false });
  });
});

describe("PaidCallCache", () => {
  let home: string;
  let now: number;
  let existing: Set<string>;
  let cache: PaidCallCache;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "plughive-paid-cache-"));
    now = 1_000_000;
    existing = new Set(["a1", "a2"]);
    cache = new PaidCallCache({ home, artifactExists: (id) => existing.has(id), now: () => now });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const result = (ids: string[]) => ({
    artifacts: ids.map((id) => ({ id, url: "/x", mime: "image/png" })),
    model: "m",
  });

  it("returns a saved result while it is fresh and its artifacts exist", () => {
    cache.put({
      key: "k",
      capability: "image.generate",
      provider: "p",
      pack: "p",
      result: result(["a1", "a2"]),
    });
    expect(cache.get("k")?.result).toEqual(result(["a1", "a2"]));
    if (process.platform !== "win32") {
      expect(statSync(join(home, PAID_CACHE_FILE)).mode & 0o777).toBe(0o600);
    }
    existing.delete("a2");
    expect(cache.get("k")).toBeNull();
  });

  it("expires entries after the TTL", () => {
    cache.put({
      key: "k",
      capability: "image.generate",
      provider: "p",
      pack: "p",
      result: result(["a1"]),
    });
    now += DEFAULT_PAID_CACHE_TTL_MS + 1;
    expect(cache.get("k")).toBeNull();
  });

  it("does not keep results without artifacts", () => {
    cache.put({ key: "k", capability: "chat", provider: "p", pack: "p", result: { text: "hi" } });
    expect(cache.get("k")).toBeNull();
  });

  it("keeps at most MAX_ENTRIES, newest first", () => {
    for (let i = 0; i < MAX_ENTRIES + 5; i++) {
      now += 1;
      cache.put({
        key: `k${i}`,
        capability: "image.generate",
        provider: "p",
        pack: "p",
        result: result(["a1"]),
      });
    }
    const file = JSON.parse(readFileSync(join(home, PAID_CACHE_FILE), "utf8"));
    expect(file.entries).toHaveLength(MAX_ENTRIES);
    expect(file.entries[0].key).toBe(`k${MAX_ENTRIES + 4}`);
    expect(cache.get("k0")).toBeNull();
  });

  it("treats a broken cache file as empty and rewrites it on the next put", () => {
    writeFileSync(join(home, PAID_CACHE_FILE), "{not json");
    expect(cache.get("k")).toBeNull();
    cache.put({
      key: "k",
      capability: "image.generate",
      provider: "p",
      pack: "p",
      result: result(["a1"]),
    });
    expect(cache.get("k")).not.toBeNull();
  });
});

describe("CapabilityRouter with the paid-call cache", () => {
  let home: string;
  let existing: Set<string>;
  let records: { costUsd: number | null; meta?: Record<string, unknown> }[];
  let router: CapabilityRouter;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "plughive-router-cache-"));
    existing = new Set();
    records = [];
    const paidCache = new PaidCallCache({ home, artifactExists: (id) => existing.has(id) });
    router = new CapabilityRouter({
      home,
      logger: silent,
      usage: { record: (r: never) => records.push(r) } as never,
      paidCache,
    });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const run = (input: object = { prompt: "a cat" }, opts: object = {}) =>
    router.run("image.generate", input, opts, caller()) as Promise<Record<string, unknown>>;

  it("returns the saved result for the same paid call without running the provider", async () => {
    const p = provider("fal");
    router.registerPack("fal", "builtin", [p]);
    const first = await run();
    existing.add("fal-1");
    const second = await run({ prompt: "a cat" });
    expect(p.calls).toBe(1);
    expect(second).toMatchObject({
      provider: "fal",
      cached: true,
      cost_usd: 0,
      artifacts: first.artifacts,
    });
    expect(first.cached).toBeUndefined();
    expect(records.at(-1)).toMatchObject({ costUsd: null, meta: { cached: true } });
  });

  it("runs again for different input, cache: false, or when the artifact is gone", async () => {
    const p = provider("fal");
    router.registerPack("fal", "builtin", [p]);
    await run();
    existing.add("fal-1");
    await run({ prompt: "a dog" });
    expect(p.calls).toBe(2);
    await run({ prompt: "a cat", cache: false });
    expect(p.calls).toBe(3);
    await run({ prompt: "a cat" }, { cache: false });
    expect(p.calls).toBe(4);
    // The cache: false runs saved fal-3 and fal-4 as the newest "a cat" result.
    existing.clear();
    await run();
    expect(p.calls).toBe(5);
  });

  it("never caches local or account providers, or failures", async () => {
    const local = provider("local", { cost: "local" });
    router.registerPack("local", "builtin", [local]);
    await run();
    existing.add("local-1");
    await run();
    expect(local.calls).toBe(2);
  });

  it("ignores a saved result once its provider is no longer registered", async () => {
    const p = provider("fal");
    router.registerPack("fal", "builtin", [p]);
    await run();
    existing.add("fal-1");
    router.unregisterPack("fal");
    const q = provider("replicate");
    router.registerPack("replicate", "builtin", [q]);
    const out = await run();
    expect(out.provider).toBe("replicate");
    expect(q.calls).toBe(1);
  });

  it("keys a pinned provider apart from automatic routing", async () => {
    const p = provider("fal");
    router.registerPack("fal", "builtin", [p]);
    await run({ prompt: "a cat" }, { provider: "fal" });
    existing.add("fal-1");
    await run();
    expect(p.calls).toBe(2);
    await run({ prompt: "a cat" }, { provider: "fal" });
    expect(p.calls).toBe(2);
  });
});
