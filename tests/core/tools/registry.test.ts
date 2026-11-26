import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { MissingSecretError, Redactor } from "../../../src/core/secrets/index.js";
import {
  InvalidArgumentsError,
  MAX_COST_USD,
  MAX_ERROR_MESSAGE_CHARS,
  MAX_INLINE_RESULT_BYTES,
  type MountedToolSource,
  type RegisteredTool,
  ToolNameConflictError,
  ToolRegistry,
  UnknownToolError,
  extractCostUsd,
} from "../../../src/core/tools/registry.js";

// L4: a cost comes from a pack or a mounted server; only a plausible amount is recorded.
describe("extractCostUsd", () => {
  it("takes a finite amount from 0 up to the cap", () => {
    expect(extractCostUsd({ cost_usd: 0.25 })).toBe(0.25);
    expect(extractCostUsd({ costUsd: 0 })).toBe(0);
    expect(extractCostUsd({ cost_usd: MAX_COST_USD })).toBe(MAX_COST_USD);
    expect(
      extractCostUsd({ artifacts: [{ cost_usd: 0.1 }, { costUsd: 0.2 }, null, {}] }),
    ).toBeCloseTo(0.3);
  });

  it.each([
    ["NaN", Number.NaN],
    ["negative", -1],
    ["infinite", Number.POSITIVE_INFINITY],
    ["minus infinity", Number.NEGATIVE_INFINITY],
    ["over the cap", MAX_COST_USD + 1],
    ["huge", 1e308],
  ])("ignores a %s cost", (_label, value) => {
    expect(extractCostUsd({ cost_usd: value })).toBeNull();
    expect(extractCostUsd({ costUsd: value })).toBeNull();
    // A bad artifact does not poison the good ones.
    expect(extractCostUsd({ artifacts: [{ cost_usd: value }, { cost_usd: 0.5 }] })).toBe(0.5);
    expect(extractCostUsd({ artifacts: [{ cost_usd: value }] })).toBeNull();
  });

  it("ignores a cost that is not a number, and a sum over the cap", () => {
    expect(extractCostUsd({ cost_usd: "12" })).toBeNull();
    expect(extractCostUsd({ artifacts: [{ cost_usd: "12" }, { costUsd: true }] })).toBeNull();
    expect(
      extractCostUsd({ artifacts: [{ cost_usd: MAX_COST_USD }, { cost_usd: MAX_COST_USD }] }),
    ).toBeNull();
    expect(extractCostUsd(null)).toBeNull();
    expect(extractCostUsd("x")).toBeNull();
  });
});

const FIXTURE_SECRET = "fixture-registry-value-123";

function tool(
  name: string,
  run: RegisteredTool["run"],
  input: z.ZodType = z.object({ n: z.number().default(1) }),
): RegisteredTool {
  return {
    name,
    packId: "p",
    origin: "native",
    description: `${name} tool`,
    inputSchema: {},
    tags: [],
    requiresSecrets: [],
    longRunning: false,
    input,
    run,
  };
}

function registryWithSecret() {
  const redactor = new Redactor();
  redactor.register(FIXTURE_SECRET);
  const usage = { record: vi.fn() };
  return {
    registry: new ToolRegistry({ redactor, usage, meteringExempt: new Set(["exempt_tool"]) }),
    usage,
  };
}

describe("ToolRegistry", () => {
  // R2-L2 / D-M2: what one call returns inline, and its error message, are bounded.
  it("refuses a result over the inline size limit and cuts a long error message", async () => {
    const registry = new ToolRegistry();
    registry.registerPack("p", [
      tool("huge_tool", async () => ({ text: "x".repeat(MAX_INLINE_RESULT_BYTES + 1) })),
      tool("loud_tool", async () => {
        throw new Error("e".repeat(MAX_ERROR_MESSAGE_CHARS * 10));
      }),
    ]);
    const huge = await registry.call("huge_tool", {});
    expect(huge.ok).toBe(false);
    expect(!huge.ok && huge.error.code).toBe("TOOL_ERROR");
    expect(!huge.ok && huge.error.message).toContain("byte limit for a result");
    const loud = await registry.call("loud_tool", {});
    expect(!loud.ok && loud.error.message.length).toBeLessThan(MAX_ERROR_MESSAGE_CHARS + 50);
    expect(!loud.ok && loud.error.message).toContain("(message cut)");
  });

  it("redacts a secret before cutting an error message, so no part of it is kept", async () => {
    const { registry } = registryWithSecret();
    const pad = "p".repeat(MAX_ERROR_MESSAGE_CHARS - 5);
    registry.registerPack("p", [
      tool("leaky_tool", async () => {
        throw new Error(`${pad}${FIXTURE_SECRET}`);
      }),
    ]);
    const res = await registry.call("leaky_tool", {});
    expect(!res.ok && res.error.message).not.toContain(FIXTURE_SECRET.slice(0, 5));
  });

  it("validates arguments with zod and returns INVALID_ARGUMENTS", async () => {
    const run = vi.fn(async () => "never");
    const registry = new ToolRegistry();
    registry.registerPack("p", [tool("strict_tool", run, z.object({ n: z.number() }))]);
    const res = await registry.call("strict_tool", { n: "x" });
    expect(res.ok).toBe(false);
    expect(!res.ok && res.error).toMatchObject({
      code: "INVALID_ARGUMENTS",
      message: expect.stringContaining("invalid arguments for strict_tool"),
    });
    expect(!res.ok && res.error.issues?.length).toBeGreaterThan(0);
    expect(run).not.toHaveBeenCalled();
    await expect(registry.invoke("strict_tool", {})).rejects.toBeInstanceOf(InvalidArgumentsError);
  });

  it("passes parsed input (with defaults) to run", async () => {
    const registry = new ToolRegistry();
    registry.registerPack("p", [tool("echo_tool", async (input) => input)]);
    expect(await registry.call("echo_tool", undefined)).toEqual({ ok: true, result: { n: 1 } });
  });

  it("reports unknown tools", async () => {
    const registry = new ToolRegistry();
    expect(await registry.call("no_such_tool", {})).toEqual({
      ok: false,
      error: { code: "UNKNOWN_TOOL", message: "unknown tool: no_such_tool", retryable: false },
    });
    await expect(registry.invoke("no_such_tool", {})).rejects.toBeInstanceOf(UnknownToolError);
  });

  it("maps MissingSecretError to MISSING_SECRET with pack, secret, label and helpUrl", async () => {
    const registry = new ToolRegistry();
    registry.registerPack("p", [
      tool("needs_key", async () => {
        throw new MissingSecretError({
          pack: "p",
          name: "P_API_KEY",
          label: "P key",
          helpUrl: "https://example.com/p",
        });
      }),
    ]);
    const res = await registry.call("needs_key", {});
    expect(res).toEqual({
      ok: false,
      error: {
        code: "MISSING_SECRET",
        message: 'Pack "p" needs the secret P_API_KEY, which is not set.',
        retryable: false,
        pack: "p",
        secret: "P_API_KEY",
        label: "P key",
        helpUrl: "https://example.com/p",
      },
    });
  });

  it("redacts a secret echoed in a result", async () => {
    const { registry } = registryWithSecret();
    registry.registerPack("p", [
      tool("leaky", async () => ({ token: FIXTURE_SECRET, nested: [`Bearer ${FIXTURE_SECRET}`] })),
    ]);
    const res = await registry.call("leaky", {});
    expect(JSON.stringify(res)).not.toContain(FIXTURE_SECRET);
    expect(res).toEqual({
      ok: true,
      result: { token: "[redacted]", nested: ["Bearer [redacted]"] },
    });
  });

  it("redacts a secret in a thrown error and in invalid-argument echoes", async () => {
    const { registry, usage } = registryWithSecret();
    registry.registerPack("p", [
      tool("throws", async () => {
        throw new Error(`upstream rejected key ${FIXTURE_SECRET}`);
      }),
      tool("strict", async () => null, z.object({ n: z.number() })),
    ]);
    const thrown = await registry.call("throws", {});
    expect(thrown).toEqual({
      ok: false,
      error: { code: "TOOL_ERROR", message: "upstream rejected key [redacted]", retryable: false },
    });
    expect(JSON.stringify(usage.record.mock.calls)).not.toContain(FIXTURE_SECRET);

    const invalid = await registry.call("strict", { n: FIXTURE_SECRET });
    expect(JSON.stringify(invalid)).not.toContain(FIXTURE_SECRET);
  });

  it("never echoes an unknown tool name raw (H2)", async () => {
    const { registry } = registryWithSecret();
    const odd = await registry.call(`x ${FIXTURE_SECRET}\n<script>`, {});
    expect(odd).toEqual({
      ok: false,
      error: { code: "UNKNOWN_TOOL", message: "unknown tool: (invalid name)", retryable: false },
    });
    // A name that passes the character check is still redacted.
    const shaped = await registry.call(FIXTURE_SECRET, {});
    expect(JSON.stringify(shaped)).not.toContain(FIXTURE_SECRET);
    expect(await registry.call(undefined as never, {})).toMatchObject({
      error: { code: "UNKNOWN_TOOL", message: "unknown tool: (invalid name)" },
    });
  });

  it("builds MISSING_SECRET from the registered tool, not from the thrown object (H1, H2)", async () => {
    const { registry } = registryWithSecret();
    registry.registerPack("p", [
      tool("forged", async () => {
        throw new MissingSecretError({
          pack: "someone-else",
          name: "P_API_KEY",
          label: `label ${FIXTURE_SECRET}`,
          helpUrl: `https://example.com/?k=${FIXTURE_SECRET}`,
        });
      }),
      tool("lookalike", async () => {
        throw Object.assign(new Error(`not the class ${FIXTURE_SECRET}`), {
          code: "MISSING_SECRET",
          name: "MissingSecretError",
          pack: "p",
          secret: "P_API_KEY",
        });
      }),
    ]);
    const forged = await registry.call("forged", {});
    expect(forged).toMatchObject({
      ok: false,
      error: { code: "MISSING_SECRET", pack: "p", secret: "P_API_KEY" },
    });
    expect(JSON.stringify(forged)).not.toContain(FIXTURE_SECRET);
    expect(JSON.stringify(forged)).not.toContain("someone-else");
    // Duck-typed errors are ordinary tool errors (and redacted).
    expect(await registry.call("lookalike", {})).toEqual({
      ok: false,
      error: { code: "TOOL_ERROR", message: "not the class [redacted]", retryable: false },
    });
  });

  it("meters and logs nested calls with their caller and depth, redacted (M4)", async () => {
    const redactor = new Redactor();
    redactor.register(FIXTURE_SECRET);
    const usage = { record: vi.fn() };
    const lines: unknown[] = [];
    const log = (obj: unknown) => void lines.push(obj);
    const registry = new ToolRegistry({
      redactor,
      usage,
      logger: { info: log, warn: log, error: log },
    });
    registry.registerPack("p", [
      tool("inner", async () => {
        throw new Error(`inner failed with ${FIXTURE_SECRET}`);
      }),
    ]);
    const res = await registry.call("inner", { n: 1 }, { caller: "other", depth: 2 });
    expect(res).toMatchObject({ ok: false, error: { message: "inner failed with [redacted]" } });
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "inner",
        status: "error",
        error: "inner failed with [redacted]",
        meta: { pack: "p", caller: "other", depth: 2 },
      }),
    );
    expect(JSON.stringify(lines)).not.toContain(FIXTURE_SECRET);
    expect(lines).toContainEqual(
      expect.objectContaining({ tool: "inner", caller: "other", depth: 2 }),
    );

    usage.record.mockClear();
    await registry.call("inner", {}, { caller: "gateway", skipMetering: true });
    expect(usage.record).not.toHaveBeenCalled();
  });

  it("meters calls except exempt tools", async () => {
    const { registry, usage } = registryWithSecret();
    registry.registerPack("p", [
      tool("metered", async () => ({ cost_usd: 0.25 })),
      tool("exempt_tool", async () => null),
    ]);
    await registry.call("metered", {});
    await registry.call("exempt_tool", {});
    expect(usage.record).toHaveBeenCalledTimes(1);
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "metered", status: "ok", costUsd: 0.25 }),
    );
  });

  it("registers a pack atomically and refuses collisions", () => {
    const registry = new ToolRegistry();
    registry.registerPack("a", [tool("shared", async () => "a")]);
    expect(() =>
      registry.registerPack("b", [
        tool("b_only", async () => "b"),
        tool("shared", async () => "b"),
      ]),
    ).toThrow(ToolNameConflictError);
    expect(registry.get("b_only")).toBeUndefined();
    expect(registry.get("shared")?.packId).toBe("a");
    expect(() =>
      registry.registerPack("c", [tool("twice", async () => 1), tool("twice", async () => 2)]),
    ).toThrow("more than once");

    registry.unregisterPack("a");
    expect(registry.get("shared")).toBeUndefined();
  });

  it("lists mounted tools under their namespaced names without shadowing pack tools", async () => {
    const registry = new ToolRegistry();
    registry.registerPack("p", [tool("up__clash", async () => "pack wins")]);
    const call = vi.fn(async () => ({ from: "upstream" }));
    const mounts: MountedToolSource = {
      list: () => [
        {
          qualifiedName: "up__search",
          mountId: "up",
          prefix: "up",
          upstreamName: "search",
          description: "Search",
        },
        {
          qualifiedName: "up__clash",
          mountId: "up",
          prefix: "up",
          upstreamName: "clash",
          description: "Clash",
        },
      ],
      call,
    };
    registry.attachMounts(mounts);
    const listed = registry.list().map((t) => [t.name, t.origin]);
    expect(listed).toEqual([
      ["up__clash", "native"],
      ["up__search", "mounted"],
    ]);
    expect(await registry.call("up__search", { q: "x" })).toEqual({
      ok: true,
      result: { from: "upstream" },
    });
    expect(call).toHaveBeenCalledWith("up", "search", { q: "x" });
    expect(await registry.call("up__clash", {})).toEqual({ ok: true, result: "pack wins" });
  });
});
