// Two router guards:
//   - a named exposure profile only reaches (and only sees) the capability
//     providers of packs it exposes; the default profile and host code keep
//     reaching all of them;
//   - an error that says the provider may have charged, or that it is final,
//     never moves the call on to a second provider.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityError } from "plughive/pack";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityRouter, type ProviderBinding } from "../../../src/core/capabilities/router.js";
import { createScopeBuilder } from "../../../src/core/mcp/scope-for.js";
import { type RequestScope, requestScope } from "../../../src/core/mcp/scope.js";
import type { FetchObserver } from "../../../src/core/packs/context.js";
import { type Profile, profileExposesPack } from "../../../src/core/profiles.js";
import type { RegisteredTool } from "../../../src/core/tools/registry.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

interface FakeOpts {
  id: string;
  priority?: number;
  run?: (observe: FetchObserver) => unknown;
}

function provider(pack: string, o: FakeOpts): ProviderBinding & { calls: number } {
  let observer: FetchObserver = {};
  const binding = {
    calls: 0,
    def: {
      capability: "image.generate",
      id: o.id,
      ...(o.priority !== undefined ? { priority: o.priority } : {}),
      isConfigured: () => true,
      run: async () => {
        binding.calls++;
        if (o.run) return o.run(observer);
        return { artifacts: [{ id: `${o.id}-1`, url: "/x", mime: "image/png" }], model: "m" };
      },
    },
    context: (_call: unknown, _tool: string, obs: FetchObserver) => {
      observer = obs;
      return { pack } as never;
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

const tool = (name: string, packId: string): RegisteredTool =>
  ({ name, packId, origin: "pack", tags: [] }) as unknown as RegisteredTool;

const profile = (id: string, include: string[], exclude: string[] = []): Profile =>
  ({ id, name: id, include, exclude }) as unknown as Profile;

let home: string;
let router: CapabilityRouter;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plughive-router-pc-"));
  router = new CapabilityRouter({ home, logger: silent });
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const run = (opts: object = {}) =>
  router.run("image.generate", { prompt: "a cat" }, opts, caller()) as Promise<{
    provider: string;
  }>;

describe("capability routing follows the calling profile", () => {
  const registry = {
    list: () => [
      tool("generate_image", "media"),
      tool("fal_run", "fal"),
      tool("fal_status", "fal"),
      tool("gemini_edit", "gemini"),
    ],
  };
  const profiles: Record<string, Profile> = {
    default: profile("default", ["*"]),
    kids: profile("kids", ["pack:media", "pack:gemini"]),
    no_fal: profile("no_fal", ["*"], ["pack:fal"]),
    one_fal_tool: profile("one_fal_tool", ["pack:media", "tool:fal_status"]),
    fal_tools_out: profile("fal_tools_out", ["*"], ["tool:fal_run", "tool:fal_status"]),
  };
  const scopeFor = createScopeBuilder({ registry, profile: (id) => profiles[id] });
  const as = <T>(id: string | undefined, fn: () => Promise<T>) =>
    requestScope.run(scopeFor(id), fn);

  let fal: ProviderBinding & { calls: number };
  let gemini: ProviderBinding & { calls: number };
  beforeEach(() => {
    fal = provider("fal", { id: "fal", priority: 90 });
    gemini = provider("gemini", { id: "gemini", priority: 10 });
    router.registerPack("fal", "builtin", [fal]);
    router.registerPack("gemini", "builtin", [gemini]);
  });

  it("the default profile, and host code with no scope, reach every provider", async () => {
    expect((await run()).provider).toBe("fal");
    expect((await as("default", () => run())).provider).toBe("fal");
    expect((await as(undefined, () => run())).provider).toBe("fal");
    const listed = await as("default", () => router.list("image.generate"));
    expect(listed.map((p) => p.id).sort()).toEqual(["fal", "gemini"]);
    expect(fal.calls).toBe(3);
  });

  it.each(["kids", "no_fal", "fal_tools_out"])(
    "the profile %s never routes to the pack it leaves out, even though it ranks first",
    async (id) => {
      expect((await as(id, () => run())).provider).toBe("gemini");
      expect(fal.calls).toBe(0);
    },
  );

  it("a profile that exposes one tool of a pack reaches that pack's providers", async () => {
    expect((await as("one_fal_tool", () => run())).provider).toBe("fal");
    expect(gemini.calls).toBe(0);
  });

  it("does not list a hidden provider, and answers an explicit one like one that does not exist", async () => {
    const listed = await as("kids", () => router.list("image.generate"));
    expect(listed.map((p) => p.id)).toEqual(["gemini"]);
    expect((await as("kids", () => router.list())).some((p) => p.pack === "fal")).toBe(false);

    const hidden = await as("kids", () => run({ provider: "fal" })).catch((e) => e);
    const missing = await as("kids", () => run({ provider: "nope" })).catch((e) => e);
    expect(hidden).toBeInstanceOf(CapabilityError);
    expect(hidden.code).toBe("UNKNOWN_PROVIDER");
    expect(missing.code).toBe("UNKNOWN_PROVIDER");
    expect(hidden.message).toBe(missing.message.replace("nope", "fal"));
    expect(fal.calls).toBe(0);
    // The default profile can still ask for it by name.
    expect((await as("default", () => run({ provider: "fal" }))).provider).toBe("fal");
  });

  it("a hidden provider is not a fallback either", async () => {
    const failing = provider("gemini", {
      id: "gemini",
      priority: 99,
      run: (obs) => {
        obs.onRequest?.({ method: "GET" });
        obs.onResponse?.({ method: "GET", status: 503, headers: new Headers() });
        throw new Error("upstream 503");
      },
    });
    router.registerPack("gemini", "builtin", [failing]);
    await expect(as("kids", () => run())).rejects.toThrow(/503/);
    expect(fal.calls).toBe(0);
    // The same failure on the default profile does fall back.
    expect((await as("default", () => run())).provider).toBe("fal");
  });

  it("with every provider hidden the capability looks absent, with no pack named", async () => {
    const only = profile("only_media", ["pack:media"]);
    const scope = createScopeBuilder({ registry, profile: () => only })("only_media");
    await requestScope.run(scope, async () => {
      expect(router.has("image.generate")).toBe(false);
      const err = await run().catch((e) => e);
      expect(err.code).toBe("NO_PROVIDER");
      expect(err.message).toMatch(/available in this profile/);
      expect(err.message).not.toMatch(/fal|gemini/);
    });
    expect(router.has("image.generate")).toBe(true);
    expect(fal.calls + gemini.calls).toBe(0);
  });

  it("a deleted profile reaches no provider", async () => {
    const scope = createScopeBuilder({ registry, profile: () => undefined })("gone");
    await expect(requestScope.run(scope, () => run())).rejects.toMatchObject({
      code: "NO_PROVIDER",
    });
    expect(fal.calls + gemini.calls).toBe(0);
  });

  it("the restriction is read when the call is made, not when the scope was built", async () => {
    let allow = false;
    const scope: RequestScope = {
      profileId: "p",
      allowsProviderPack: (pack) => allow || pack === "gemini",
    };
    expect((await requestScope.run(scope, () => run())).provider).toBe("gemini");
    allow = true;
    expect((await requestScope.run(scope, () => run())).provider).toBe("fal");
  });

  it("the default profile's own excludes also stop provider routing", async () => {
    // The default profile ships with no excludes and reaches everything; once
    // the user excludes a pack from it, its providers are out of reach too.
    const profiles2: Record<string, Profile> = {
      default: profile("default", ["*"], ["pack:fal"]),
    };
    const scopeFor2 = createScopeBuilder({ registry, profile: (id) => profiles2[id] });
    const out = await requestScope.run(scopeFor2("default"), async () => ({
      provider: (await run()).provider,
      allowsFalTool: scopeFor2("default").allows?.("fal_run") ?? null,
    }));
    expect(out.provider).toBe("gemini");
    expect(out.allowsFalTool).toBe(false);
    expect(fal.calls).toBe(0);
    // A default profile without excludes still reaches every provider.
    const profiles3: Record<string, Profile> = { default: profile("default", ["*"]) };
    const scopeFor3 = createScopeBuilder({ registry, profile: (id) => profiles3[id] });
    expect((await requestScope.run(scopeFor3("default"), () => run())).provider).toBe("fal");
  });

  it("profileExposesPack judges a pack without tools by the selectors that can name it", () => {
    const none = { list: () => [tool("generate_image", "media")] };
    expect(profileExposesPack(profile("a", ["*"]), none, "fal")).toBe(true);
    expect(profileExposesPack(profile("a", ["pack:fal"]), none, "fal")).toBe(true);
    expect(profileExposesPack(profile("a", ["pack:media"]), none, "fal")).toBe(false);
    expect(profileExposesPack(profile("a", ["*"], ["pack:fal"]), none, "fal")).toBe(false);
    expect(profileExposesPack(profile("a", ["tool:generate_image"]), none, "media")).toBe(true);
    expect(profileExposesPack(profile("a", ["*"], ["tool:generate_image"]), none, "media")).toBe(
      false,
    );
  });
});

describe("an error that may have charged never falls back", () => {
  const pair = (fail: (obs: FetchObserver) => never) => {
    const first = provider("a", { id: "a", priority: 50, run: fail });
    const second = provider("b", { id: "b", priority: 10 });
    router.registerPack("a", "builtin", [first]);
    router.registerPack("b", "builtin", [second]);
    return { first, second };
  };
  const get503 = (obs: FetchObserver) => {
    obs.onRequest?.({ method: "GET" });
    obs.onResponse?.({ method: "GET", status: 503, headers: new Headers() });
  };

  it("control: the same 503 on a GET with a plain error does fall back", async () => {
    const { second } = pair((obs) => {
      get503(obs);
      throw new Error("upstream 503");
    });
    expect((await run()).provider).toBe("b");
    expect(second.calls).toBe(1);
  });

  it.each([
    [
      "mayHaveCharged on a plain error",
      () => Object.assign(new Error("paid lookup failed"), { mayHaveCharged: true }),
    ],
    [
      "mayHaveCharged on the cause",
      () =>
        new Error("wrapped", {
          cause: Object.assign(new Error("paid lookup failed"), { mayHaveCharged: true }),
        }),
    ],
    [
      "a CapabilityError that claims retryable but may have charged",
      () => new CapabilityError("accepted then lost", { retryable: true, mayHaveCharged: true }),
    ],
    [
      "retryable: false on a plain error",
      () => Object.assign(new Error("final"), { retryable: false }),
    ],
    [
      "a CapabilityError with retryable: false",
      () => new CapabilityError("final", { retryable: false }),
    ],
  ])("%s", async (_label, make) => {
    const { first, second } = pair((obs) => {
      get503(obs);
      throw make();
    });
    const err = await run().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(first.calls).toBe(1);
    expect(second.calls).toBe(0);
  });

  it("mayHaveCharged wins over a 401 that would otherwise be a clean refusal", async () => {
    const { second } = pair((obs) => {
      obs.onRequest?.({ method: "POST" });
      obs.onResponse?.({ method: "POST", status: 401, headers: new Headers() });
      throw Object.assign(new Error("unauthorized after billing"), { mayHaveCharged: true });
    });
    const err = await run().catch((e) => e);
    expect(err.message).toMatch(/via a failed/);
    expect(second.calls).toBe(0);
  });

  it("a CapabilityError cannot be both retryable and possibly charged", () => {
    const e = new CapabilityError("x", { retryable: true, mayHaveCharged: true });
    expect(e.retryable).toBe(false);
    expect(e.mayHaveCharged).toBe(true);
    expect(new CapabilityError("x", { retryable: true }).retryable).toBe(true);
    expect(new CapabilityError("x").mayHaveCharged).toBe(false);
  });
});
