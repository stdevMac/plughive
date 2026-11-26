// batch_run: bounded concurrency, per-item results, one failing item, scope,
// capability lookup, refusals and the optional contact sheet.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { requestScope } from "../../../src/core/mcp/scope.js";
import {
  BatchInput,
  CONTACT_SHEET_TOOL,
  MAX_BATCH_RESULT_BYTES,
  batchTools,
  imageArtifactIds,
  pool,
  toolForCapability,
} from "../../../src/core/tools/builtin/batch.js";
import { type CallContext, ToolRegistry } from "../../../src/core/tools/registry.js";
import { mockTool } from "../../http/harness.js";

const ItemInput = z.object({ n: z.number() });

interface BatchOut {
  tool: string;
  total: number;
  succeeded: number;
  failed: number;
  items: Array<{
    index: number;
    ok: boolean;
    result?: unknown;
    error?: { code: string; message: string };
  }>;
  contact_sheet?: { skipped?: string } & Record<string, unknown>;
}
const res = (out: unknown) => (out as { result: BatchOut }).result;

function setup(extra: Parameters<ToolRegistry["registerPack"]>[1] = []) {
  const registry = new ToolRegistry();
  let inFlight = 0;
  let peak = 0;
  const seen: number[] = [];
  registry.registerPack("demo", [
    mockTool(
      "slow_double",
      async (input) => {
        const n = input.n as number;
        inFlight++;
        peak = Math.max(peak, inFlight);
        seen.push(n);
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        if (n === 3) throw new Error("three is bad");
        return { value: n * 2 };
      },
      { input: ItemInput, capability: "math.double" },
    ),
    ...extra,
  ]);
  const deps = {
    call: (name: string, args: unknown, ctx?: CallContext) => registry.call(name, args, ctx),
    tools: () => registry.list(),
  };
  registry.registerPack("core", batchTools(deps));
  return { registry, stats: () => ({ peak, seen }) };
}

describe("batch_run", () => {
  // R2-L2: the items together stay under one reply's limit; later ones keep a notice.
  it("leaves out results once the batch passes its size limit, keeping ok and the order", async () => {
    const big = "y".repeat(Math.ceil(MAX_BATCH_RESULT_BYTES / 3));
    const env = setup([
      mockTool("big_tool", async (input) => ({ n: input.n, text: big }), { input: ItemInput }),
    ]);
    const inputs = [1, 2, 3, 4, 5].map((n) => ({ n }));
    const out = await env.registry.call("batch_run", {
      tool: "big_tool",
      inputs,
      concurrency: 1,
      max_items: 5,
    });
    expect(out.ok).toBe(true);
    const r = res(out);
    expect(r).toMatchObject({ total: 5, succeeded: 5, failed: 0 });
    expect(r.items[0]?.result).toMatchObject({ n: 1, text: big });
    expect(r.items[1]?.result).toMatchObject({ n: 2 });
    expect(r.items[4]).toMatchObject({ index: 4, ok: true });
    expect((r.items[4]?.result as { truncated?: string }).truncated).toContain("byte limit");
    expect(Buffer.byteLength(JSON.stringify(r))).toBeLessThan(MAX_BATCH_RESULT_BYTES + 4096);
  });

  it("runs every item with bounded concurrency and reports a failing item without stopping", async () => {
    const env = setup();
    const inputs = [1, 2, 3, 4, 5, 6].map((n) => ({ n }));
    const progress: number[] = [];
    const out = await env.registry.call(
      "batch_run",
      { tool: "slow_double", inputs, concurrency: 2, max_items: 6 },
      { progress: (f) => progress.push(f) },
    );
    expect(out.ok).toBe(true);
    const r = res(out);
    expect(r).toMatchObject({ tool: "slow_double", total: 6, succeeded: 5, failed: 1 });
    expect(r.items.map((i: { index: number }) => i.index)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(r.items[0]).toEqual({ index: 0, ok: true, result: { value: 2 } });
    expect(r.items[2]).toMatchObject({ index: 2, ok: false, error: { code: "TOOL_ERROR" } });
    expect(r.items[2]?.error?.message).toContain("three is bad");
    expect(r.items[5]).toEqual({ index: 5, ok: true, result: { value: 12 } });
    expect(env.stats().peak).toBe(2);
    expect(env.stats().seen.sort()).toEqual([1, 2, 3, 4, 5, 6]);
    expect(progress.at(-1)).toBe(1);
  });

  it("reports invalid item arguments per item", async () => {
    const env = setup();
    const out = await env.registry.call("batch_run", {
      tool: "slow_double",
      inputs: [{ n: 1 }, { n: "x" }],
      max_items: 2,
    });
    const r = res(out);
    expect(r.succeeded).toBe(1);
    expect(r.items[1]).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
  });

  it("resolves a capability to its tool", async () => {
    const env = setup();
    const out = await env.registry.call("batch_run", {
      capability: "math.double",
      inputs: [{ n: 5 }],
      max_items: 1,
    });
    expect(res(out)).toMatchObject({
      tool: "slow_double",
      succeeded: 1,
    });
    expect(toolForCapability(env.registry.list(), "nope")).toBeUndefined();
  });

  it("refuses bad batches: over max_items, both or neither target, recursion, unknown tool", async () => {
    const env = setup();
    const call = (args: unknown) => env.registry.call("batch_run", args);
    const inputs = [{ n: 1 }, { n: 2 }];
    expect(await call({ tool: "slow_double", inputs, max_items: 1 })).toMatchObject({
      ok: false,
      error: { code: "INVALID_ARGUMENTS" },
    });
    expect(
      await call({ tool: "slow_double", capability: "math.double", inputs, max_items: 2 }),
    ).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    expect(await call({ inputs, max_items: 2 })).toMatchObject({ ok: false });
    expect(await call({ tool: "batch_run", inputs, max_items: 2 })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("cannot run inside a batch") },
    });
    expect(await call({ tool: "missing", inputs, max_items: 2 })).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("unknown tool") },
    });
    expect(BatchInput.safeParse({ tool: "x", inputs: [], max_items: 1 }).success).toBe(false);
  });

  it("stays inside the caller's profile", async () => {
    const env = setup();
    const scope = { profileId: "narrow", allows: (t: string) => t === "batch_run" };
    const out = await requestScope.run(scope as never, () =>
      env.registry.call("batch_run", { tool: "slow_double", inputs: [{ n: 1 }], max_items: 1 }),
    );
    expect(out).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("unknown") },
    });
    const byCap = await requestScope.run(scope as never, () =>
      env.registry.call("batch_run", {
        capability: "math.double",
        inputs: [{ n: 1 }],
        max_items: 1,
      }),
    );
    expect(byCap).toMatchObject({ ok: false });
  });

  it("makes a contact sheet from image outputs when the tool exists, and says why when not", async () => {
    const sheetCalls: unknown[] = [];
    const image = mockTool(
      "make_image",
      async (input) => ({
        artifact: { id: `img${input.n}`, mime: "image/png", url: "http://x" },
      }),
      { input: ItemInput },
    );
    const without = setup([image]);
    const r1 = await without.registry.call("batch_run", {
      tool: "make_image",
      inputs: [{ n: 1 }],
      max_items: 1,
      contact_sheet: true,
    });
    expect(res(r1).contact_sheet?.skipped).toContain("not installed");
    const sheet = mockTool(
      CONTACT_SHEET_TOOL,
      async (input) => {
        sheetCalls.push(input);
        return { artifact: { id: "sheet1", mime: "image/png" } };
      },
      { input: z.object({ artifact_ids: z.array(z.string()) }) },
    );
    const withSheet = setup([image, sheet]);
    const r2 = await withSheet.registry.call("batch_run", {
      tool: "make_image",
      inputs: [{ n: 1 }, { n: 2 }],
      max_items: 2,
      contact_sheet: true,
    });
    expect(res(r2).contact_sheet).toEqual({
      artifact: { id: "sheet1", mime: "image/png" },
    });
    expect(sheetCalls).toEqual([{ artifact_ids: ["img1", "img2"] }]);
  });

  it("helpers: image ids and the pool", async () => {
    expect(
      imageArtifactIds({
        artifacts: [
          { id: "a", mime: "image/png" },
          { id: "b", mime: "video/mp4" },
        ],
        nested: { artifact: { id: "c", mime: "image/jpeg" } },
      }),
    ).toEqual(["a", "c"]);
    const order: number[] = [];
    await pool(5, 3, async (i) => void order.push(i));
    expect(order.sort()).toEqual([0, 1, 2, 3, 4]);
    const ac = new AbortController();
    ac.abort();
    const none: number[] = [];
    await pool(5, 2, async (i) => void none.push(i), ac.signal);
    expect(none).toEqual([]);
  });
});
