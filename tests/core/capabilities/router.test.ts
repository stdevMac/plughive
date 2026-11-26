import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityError } from "plughive/pack";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CapabilityRouter,
  type ProviderBinding,
  getCapabilityPreferences,
  setCapabilityPreference,
  setCapabilityPreferences,
} from "../../../src/core/capabilities/router.js";
import type { FetchObserver } from "../../../src/core/packs/context.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

interface FakeOpts {
  id: string;
  priority?: number;
  configured?: boolean;
  models?: string[];
  setupHint?: string;
  /** Runs the provider: may report responses through `observe`. */
  run?: (observe: FetchObserver, ctx: { pack: string }) => unknown;
}

/** A provider binding whose context records which pack's context it got. */
function provider(pack: string, o: FakeOpts): ProviderBinding & { calls: number } {
  let observer: FetchObserver = {};
  const binding = {
    calls: 0,
    def: {
      capability: "image.generate",
      id: o.id,
      ...(o.priority !== undefined ? { priority: o.priority } : {}),
      ...(o.setupHint ? { setupHint: o.setupHint } : {}),
      ...(o.models ? { models: () => o.models as string[] } : {}),
      isConfigured: () => o.configured ?? true,
      run: async (_input: unknown, ctx: { pack: string }) => {
        binding.calls++;
        if (o.run) return o.run(observer, ctx);
        return { artifacts: [{ id: `${o.id}-1`, url: "/x", mime: "image/png" }], model: "m" };
      },
    },
    context: (_call: unknown, _tool: string, obs: FetchObserver) => {
      observer = obs;
      return { pack: pack } as never;
    },
  };
  return binding as unknown as ProviderBinding & { calls: number };
}

const caller = () => ({
  pack: "media",
  depth: 0,
  signal: new AbortController().signal,
  tool: "generate_image",
});

describe("CapabilityRouter", () => {
  let home: string;
  let now: number;
  let router: CapabilityRouter;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "plughive-router-"));
    now = 1_000_000;
    router = new CapabilityRouter({ home, logger: silent, now: () => now });
  });
  afterEach(() => rmSync(home, { recursive: true, force: true }));

  const run = (input: object = { prompt: "a cat" }, opts: object = {}) =>
    router.run("image.generate", input, opts, caller());

  it("runs the highest-priority configured provider and stamps its id", async () => {
    router.registerPack("lo", "builtin", [provider("lo", { id: "lo", priority: 10 })]);
    router.registerPack("hi", "builtin", [provider("hi", { id: "hi", priority: 50 })]);
    router.registerPack("off", "builtin", [
      provider("off", { id: "off", priority: 99, configured: false }),
    ]);
    const out = (await run()) as { provider: string; artifacts: { id: string }[] };
    expect(out.provider).toBe("hi");
    expect(out.artifacts[0]?.id).toBe("hi-1");
  });

  it("refuses invalid input before any provider runs", async () => {
    const p = provider("a", { id: "a" });
    router.registerPack("a", "builtin", [p]);
    await expect(run({ prompt: "" })).rejects.toThrow();
    expect(p.calls).toBe(0);
  });

  it("falls back on a retryable failure (5xx on a GET, nothing sent that could be accepted)", async () => {
    const first = provider("a", {
      id: "a",
      priority: 50,
      run: (obs) => {
        obs.onRequest?.({ method: "GET" });
        obs.onResponse?.({ method: "GET", status: 503, headers: new Headers() });
        throw new Error("upstream 503");
      },
    });
    const second = provider("b", { id: "b", priority: 10 });
    router.registerPack("a", "builtin", [first]);
    router.registerPack("b", "builtin", [second]);
    const out = (await run()) as { provider: string };
    expect(out.provider).toBe("b");
    expect(first.calls).toBe(1);
  });

  // H2: once a non-GET request left the daemon, only a clear refusal falls back.
  describe("after a non-idempotent request was dispatched", () => {
    const coded = (message: string, code: string) => {
      const cause = Object.assign(new Error(message), { code });
      return Object.assign(new TypeError("fetch failed"), { cause });
    };
    const timeout = () =>
      Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    const pair = (fail: (obs: FetchObserver) => never) => {
      const first = provider("a", { id: "a", priority: 50, run: fail });
      const second = provider("b", { id: "b", priority: 10 });
      router.registerPack("a", "builtin", [first]);
      router.registerPack("b", "builtin", [second]);
      return { first, second };
    };

    it.each([
      ["a timeout", () => timeout()],
      ["a reset connection", () => coded("read ECONNRESET", "ECONNRESET")],
      ["a closed socket", () => coded("other side closed", "UND_ERR_SOCKET")],
    ])(
      "%s is final: no second provider, and the error says to check the provider",
      async (_l, make) => {
        const { first, second } = pair((obs) => {
          obs.onRequest?.({ method: "POST" });
          const error = make();
          obs.onError?.({ method: "POST", error });
          throw error;
        });
        const err = (await run().catch((e) => e)) as Error & { code?: string };
        expect(err.message).toMatch(/may have accepted .* check the provider before retrying/);
        expect(err.code).toBe("PROVIDER_OUTCOME_UNKNOWN");
        expect(first.calls).toBe(1);
        expect(second.calls).toBe(0);
      },
    );

    it("a 5xx answer to the POST is final", async () => {
      const { second } = pair((obs) => {
        obs.onRequest?.({ method: "POST" });
        obs.onResponse?.({ method: "POST", status: 502, headers: new Headers() });
        throw new Error("upstream 502");
      });
      await expect(run()).rejects.toThrow(/check the provider before retrying/);
      expect(second.calls).toBe(0);
    });

    it("an ambiguous POST stays final even when a later request is clearly refused", async () => {
      const { second } = pair((obs) => {
        obs.onRequest?.({ method: "POST" });
        obs.onError?.({ method: "POST", error: timeout() });
        obs.onRequest?.({ method: "POST" });
        const refused = coded("connect ECONNREFUSED", "ECONNREFUSED");
        obs.onError?.({ method: "POST", error: refused });
        throw refused;
      });
      await expect(run()).rejects.toThrow(/check the provider before retrying/);
      expect(second.calls).toBe(0);
    });

    it.each([
      ["connection refused", "ECONNREFUSED"],
      ["DNS failure", "ENOTFOUND"],
      ["connect timeout", "UND_ERR_CONNECT_TIMEOUT"],
      ["TLS certificate failure", "CERT_HAS_EXPIRED"],
    ])("%s falls back: the request never left", async (_l, code) => {
      const { second } = pair((obs) => {
        obs.onRequest?.({ method: "POST" });
        const error = coded(`connect ${code}`, code);
        obs.onError?.({ method: "POST", error });
        throw error;
      });
      expect(((await run()) as { provider: string }).provider).toBe("b");
      expect(second.calls).toBe(1);
    });

    it.each([429, 401, 403])(
      "HTTP %i on the POST falls back: the provider refused it",
      async (status) => {
        const { second } = pair((obs) => {
          obs.onRequest?.({ method: "POST" });
          obs.onResponse?.({ method: "POST", status, headers: new Headers() });
          throw new Error(`upstream ${status}`);
        });
        expect(((await run()) as { provider: string }).provider).toBe("b");
        expect(second.calls).toBe(1);
      },
    );

    it("an explicit retryable CapabilityError still falls back", async () => {
      const { second } = pair((obs) => {
        obs.onRequest?.({ method: "POST" });
        obs.onResponse?.({ method: "POST", status: 400, headers: new Headers() });
        throw new CapabilityError("option refused", { retryable: true });
      });
      expect(((await run()) as { provider: string }).provider).toBe("b");
      expect(second.calls).toBe(1);
    });
  });

  it("never falls back once a provider accepted the job (2xx POST)", async () => {
    const first = provider("a", {
      id: "a",
      priority: 50,
      run: (obs) => {
        obs.onResponse?.({ method: "POST", status: 200, headers: new Headers() });
        obs.onResponse?.({ method: "GET", status: 500, headers: new Headers() });
        throw new Error("poll failed");
      },
    });
    const second = provider("b", { id: "b", priority: 10 });
    router.registerPack("a", "builtin", [first]);
    router.registerPack("b", "builtin", [second]);
    await expect(run()).rejects.toThrow(/image\.generate via a failed: poll failed/);
    expect(second.calls).toBe(0);
  });

  it("does not fall back on a plain (non-retryable) error, but does on a retryable CapabilityError", async () => {
    const bad = provider("a", {
      id: "a",
      priority: 50,
      run: () => {
        throw new Error("bad request");
      },
    });
    const b = provider("b", { id: "b", priority: 10 });
    router.registerPack("a", "builtin", [bad]);
    router.registerPack("b", "builtin", [b]);
    await expect(run()).rejects.toThrow(/bad request/);
    expect(b.calls).toBe(0);

    router.registerPack("a", "builtin", [
      provider("a", {
        id: "a",
        priority: 50,
        run: () => {
          throw new CapabilityError("aspect not supported", { retryable: true });
        },
      }),
    ]);
    expect(((await run()) as { provider: string }).provider).toBe("b");
  });

  it("a 429 cools the provider down (Retry-After, capped) and reorders it last", async () => {
    let limited = true;
    const a = provider("a", {
      id: "a",
      priority: 50,
      run: (obs) => {
        if (limited) {
          obs.onResponse?.({
            method: "POST",
            status: 429,
            headers: new Headers({ "retry-after": "30" }),
          });
          throw new Error("rate limited");
        }
        return { artifacts: [{ id: "a-1", url: "/x", mime: "image/png" }], model: "m" };
      },
    });
    const b = provider("b", { id: "b", priority: 10 });
    router.registerPack("a", "builtin", [a]);
    router.registerPack("b", "builtin", [b]);
    expect(((await run()) as { provider: string }).provider).toBe("b");
    let rows = await router.list("image.generate");
    expect(rows.map((r) => r.id)).toEqual(["b", "a"]);
    expect(rows.find((r) => r.id === "a")?.coolingDownUntil).toBe(
      new Date(now + 30_000).toISOString(),
    );

    limited = false;
    expect(((await run()) as { provider: string }).provider).toBe("b");
    expect(a.calls).toBe(1);
    now += 31_000;
    expect(((await run()) as { provider: string }).provider).toBe("a");
    rows = await router.list("image.generate");
    expect(rows[0]?.coolingDownUntil).toBeNull();
  });

  it("lists providers with their probes side by side, in priority order", async () => {
    let inFlight = 0;
    let peak = 0;
    for (let i = 0; i < 8; i++) {
      const p = provider(`p${i}`, { id: `p${i}`, priority: 100 - i });
      (p.def as unknown as { isConfigured: () => Promise<boolean> }).isConfigured = async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return i % 2 === 0;
      };
      router.registerPack(`p${i}`, "builtin", [p]);
    }
    const rows = await router.list("image.generate");
    expect(rows.map((r) => r.id)).toEqual(["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"]);
    expect(rows.map((r) => r.configured)).toEqual([
      true,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
    ]);
    expect(peak).toBeGreaterThan(1);
  });

  it("caps a huge Retry-After at ten minutes", async () => {
    router.registerPack("a", "builtin", [
      provider("a", {
        id: "a",
        run: (obs) => {
          obs.onResponse?.({
            method: "POST",
            status: 429,
            headers: new Headers({ "retry-after": "999999" }),
          });
          throw new Error("rate limited");
        },
      }),
    ]);
    await expect(run()).rejects.toThrow();
    const row = (await router.list("image.generate"))[0];
    expect(row?.coolingDownUntil).toBe(new Date(now + 10 * 60_000).toISOString());
  });

  it("follows the user's preference order over priority", async () => {
    router.registerPack("a", "builtin", [provider("a", { id: "a", priority: 50 })]);
    router.registerPack("b", "builtin", [provider("b", { id: "b", priority: 10 })]);
    setCapabilityPreference(home, "image.generate", ["b", "a"]);
    expect(getCapabilityPreferences(home).order["image.generate"]).toEqual(["b", "a"]);
    expect(((await run()) as { provider: string }).provider).toBe("b");
    expect(() => setCapabilityPreference(home, "image.generate", ["Bad Id"])).toThrow(
      /invalid provider/,
    );
    setCapabilityPreference(home, "image.generate", []);
    expect(getCapabilityPreferences(home).order["image.generate"]).toBeUndefined();
  });

  it("reports each provider's cost and setup hint, and refuses an unknown cost", async () => {
    const local = provider("loc", { id: "loc", setupHint: "  install the thing  " });
    (local.def as { cost?: string }).cost = "local";
    router.registerPack("loc", "builtin", [
      local,
      provider("loc", { id: "loc2", configured: false }),
    ]);
    const rows = await router.list("image.generate");
    expect(rows.find((r) => r.id === "loc")).toMatchObject({
      cost: "local",
      setupHint: "install the thing",
    });
    expect(rows.find((r) => r.id === "loc2")).toMatchObject({ cost: "paid", setupHint: null });
    const bad = provider("odd", { id: "odd" });
    (bad.def as { cost?: string }).cost = "free";
    expect(() => router.registerPack("odd", "builtin", [bad])).toThrow(/cost must be/);
  });

  it("sets several preference orders in one write", () => {
    setCapabilityPreferences(home, { "image.generate": ["b", "a", "b"], chat: ["x"] });
    expect(getCapabilityPreferences(home).order).toEqual({
      "image.generate": ["b", "a"],
      chat: ["x"],
    });
    expect(() =>
      setCapabilityPreferences(home, { chat: [], "image.generate": ["Bad Id"] }),
    ).toThrow(/invalid provider/);
    // A refused write changes nothing.
    expect(getCapabilityPreferences(home).order.chat).toEqual(["x"]);
    setCapabilityPreferences(home, { chat: [] });
    expect(getCapabilityPreferences(home).order).toEqual({ "image.generate": ["b", "a"] });
  });

  it("routes a non-builtin provider only when the user lists it", async () => {
    const user = provider("userimg", { id: "userimg", priority: 1000 });
    router.registerPack("userimg", "user", [user]);
    router.registerPack("a", "builtin", [provider("a", { id: "a", priority: 1 })]);
    expect(((await run()) as { provider: string }).provider).toBe("a");
    expect(user.calls).toBe(0);
    expect((await router.list("image.generate")).find((r) => r.id === "userimg")?.autoRoute).toBe(
      false,
    );
    setCapabilityPreference(home, "image.generate", ["userimg"]);
    expect(((await run()) as { provider: string }).provider).toBe("userimg");
    // Only a user pack: not routed without the preference.
    router.unregisterPack("a");
    setCapabilityPreference(home, "image.generate", []);
    expect(router.has("image.generate")).toBe(false);
  });

  // U3: preferences name a provider by id alone.
  it("a user pack cannot take a provider id outside its own name", async () => {
    setCapabilityPreference(home, "image.generate", ["fal"]);
    // The bundled pack that owns "fal" is switched off; a user pack tries the id.
    const squat = provider("evil", { id: "fal", priority: 1000 });
    expect(() => router.registerPack("evil", "user", [squat])).toThrow(
      /must be "evil" or start with "evil-"/,
    );
    expect(router.has("image.generate")).toBe(false);
    for (const id of ["evilx", "xevil", "fal-evil", "ev"]) {
      expect(() => router.registerPack("evil", "user", [provider("evil", { id })]), id).toThrow(
        /a user pack names its providers after itself/,
      );
    }
    // Its own ids are fine, and are routed only once the user lists them.
    router.registerPack("evil", "user", [
      provider("evil", { id: "evil" }),
      { ...provider("evil", { id: "evil-fast" }) },
    ]);
    expect(router.has("image.generate")).toBe(false);
    // The bundled pack comes back and gets its id, and the user's preference with it.
    const real = provider("fal", { id: "fal" });
    router.registerPack("fal", "builtin", [real]);
    expect(((await run()) as { provider: string }).provider).toBe("fal");
    expect(squat.calls).toBe(0);
  });

  it("explicit provider: no fallback, UNKNOWN_PROVIDER for a missing id", async () => {
    const a = provider("a", {
      id: "a",
      run: (obs) => {
        obs.onResponse?.({ method: "POST", status: 503, headers: new Headers() });
        throw new Error("down");
      },
    });
    const b = provider("b", { id: "b" });
    router.registerPack("a", "builtin", [a]);
    router.registerPack("b", "builtin", [b]);
    await expect(run({ prompt: "x" }, { provider: "a" })).rejects.toThrow(/down/);
    expect(b.calls).toBe(0);
    await expect(run({ prompt: "x" }, { provider: "zzz" })).rejects.toMatchObject({
      code: "UNKNOWN_PROVIDER",
    });
  });

  it("model routing picks a provider that serves the model, else NO_PROVIDER_FOR_MODEL", async () => {
    router.registerPack("a", "builtin", [
      provider("a", { id: "a", priority: 50, models: ["m-a"] }),
    ]);
    router.registerPack("b", "builtin", [
      provider("b", { id: "b", priority: 10, models: ["m-b"] }),
    ]);
    expect(((await run({ prompt: "x", model: "m-b" })) as { provider: string }).provider).toBe("b");
    await expect(run({ prompt: "x", model: "m-z" })).rejects.toMatchObject({
      code: "NO_PROVIDER_FOR_MODEL",
    });
  });

  it("NO_PROVIDER names each provider's setup hint", async () => {
    router.registerPack("g", "builtin", [
      provider("g", { id: "gemini", configured: false, setupHint: "set GEMINI_API_KEY" }),
    ]);
    router.registerPack("l", "builtin", [provider("l", { id: "local", configured: false })]);
    const err = (await run().catch((e: unknown) => e)) as CapabilityError;
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.code).toBe("NO_PROVIDER");
    expect(err.message).toContain("gemini: set GEMINI_API_KEY");
    expect(err.message).toContain('local: configure the "l" pack');
    const none = (await new CapabilityRouter({ home, logger: silent })
      .run("music.generate", { prompt: "x" }, {}, caller())
      .catch((e: unknown) => e)) as Error;
    expect(none).toBeInstanceOf(Error);
    expect(none.message).toMatch(/no provider for music\.generate is installed/);
  });

  it("refuses duplicate or invalid provider ids and keeps the old set on a bad update", () => {
    router.registerPack("a", "builtin", [provider("a", { id: "same" })]);
    expect(() => router.registerPack("b", "builtin", [provider("b", { id: "same" })])).toThrow(
      /already used by the pack "a"/,
    );
    expect(() =>
      router.registerPack("a", "builtin", [provider("a", { id: "x" }), provider("a", { id: "x" })]),
    ).toThrow(/declared twice/);
    expect(() => router.registerPack("a", "builtin", [provider("a", { id: "Bad" })])).toThrow(
      /provider id/,
    );
    expect(router.has("image.generate")).toBe(true);
  });

  it("runs each provider with its own pack's context and redacts error text", async () => {
    const seen: string[] = [];
    const redacting = new CapabilityRouter({
      home,
      logger: silent,
      redact: (s) => s.replaceAll("fixture-secret", "[redacted]"),
    });
    redacting.registerPack("prov", "builtin", [
      provider("prov", {
        id: "p",
        run: (_obs, ctx) => {
          seen.push(ctx.pack);
          throw new Error("boom fixture-secret");
        },
      }),
    ]);
    const err = (await redacting
      .run("image.generate", { prompt: "x" }, {}, caller())
      .catch((e: unknown) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(seen).toEqual(["prov"]);
    expect(err.message).not.toContain("fixture-secret");
    expect(err.message).toContain("[redacted]");
  });

  it("redacts a CapabilityError's text and keeps its code", async () => {
    const redacting = new CapabilityRouter({
      home,
      logger: silent,
      redact: (s) => s.replaceAll("fixture-secret", "[redacted]"),
    });
    redacting.registerPack("prov", "builtin", [
      provider("prov", {
        id: "p",
        run: () => {
          throw new CapabilityError("refused key fixture-secret", { code: "PROVIDER_AUTH" });
        },
      }),
    ]);
    const err = (await redacting
      .run("image.generate", { prompt: "x" }, {}, caller())
      .catch((e: unknown) => e)) as CapabilityError;
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.code).toBe("PROVIDER_AUTH");
    expect(err.message).toBe("refused key [redacted]");
  });

  it("records usage per provider attempt", async () => {
    const usage = { record: vi.fn() };
    const r = new CapabilityRouter({ home, logger: silent, usage });
    r.registerPack("a", "builtin", [provider("a", { id: "a" })]);
    await r.run("image.generate", { prompt: "x" }, {}, caller());
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "capability:image.generate",
        capability: "image.generate",
        provider: "a",
        vendor: "a",
        status: "ok",
      }),
    );
  });
});
