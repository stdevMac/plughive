// tests/core/workflows/paid-steps.test.ts
//
// What counts as a paid step. A tool tagged "paid" and a capability step are
// always paid: a recipe cannot downgrade them with `paid: false`, so the
// plan's cost estimate and the no-double-charge fallback rule cover them.
// The tools are mocks; nothing reaches a provider.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { CompiledStep } from "../../../src/core/workflows/compile.js";
import { isPaid } from "../../../src/core/workflows/planner.js";
import {
  type LoaderHarness,
  MockTools,
  bootLoader,
  recipe,
  runOk,
  writeMockPack,
  writeWorkflowPack,
} from "./support.js";

type Obj = Record<string, unknown>;

const depsOf = (tools: Record<string, Obj>) => ({ tool: (name: string) => tools[name] });

describe("planner isPaid", () => {
  const d = depsOf({
    gen_paid: { packId: "gens", capability: "image.generate", tags: ["paid"], requiresSecrets: [] },
    gen: { packId: "gens", capability: "image.generate", requiresSecrets: [] },
    local_transcribe: { packId: "local", capability: "audio.transcribe", requiresSecrets: [] },
    note: { packId: "web", requiresSecrets: [] },
  });

  it("a capability step is paid even when the recipe says paid: false", () => {
    expect(
      isPaid(
        { kind: "capability", target: "image.generate", paid: false } as never as CompiledStep,
        d as never,
      ),
    ).toBe(true);
  });

  it("a tool tagged paid is paid even when the recipe says paid: false", () => {
    expect(
      isPaid(
        { kind: "tool", target: "gen_paid", paid: false } as never as CompiledStep,
        d as never,
      ),
    ).toBe(true);
  });

  it("a capability-backed tool is paid unless the recipe marks it free (local backends)", () => {
    expect(isPaid({ kind: "tool", target: "gen" } as never as CompiledStep, d as never)).toBe(true);
    expect(
      isPaid(
        { kind: "tool", target: "local_transcribe", paid: false } as never as CompiledStep,
        d as never,
      ),
    ).toBe(false);
  });

  it("a plain tool is paid only when the recipe says so", () => {
    expect(isPaid({ kind: "tool", target: "note" } as never as CompiledStep, d as never)).toBe(
      false,
    );
    expect(
      isPaid({ kind: "tool", target: "note", paid: true } as never as CompiledStep, d as never),
    ).toBe(true);
  });
});

describe("paid steps through the pack loader", () => {
  let h: LoaderHarness;
  let mock: MockTools;

  beforeAll(async () => {
    h = await bootLoader({
      packs: [],
      bundled: false,
      seed(b) {
        writeMockPack(b, "gens", {
          tools: [
            { name: "gen_paid", capability: "image.generate", tags: ["paid"] },
            { name: "gen_b", capability: "image.generate" },
          ],
        });
        writeWorkflowPack(
          b,
          [
            recipe(
              "downgrade_tagged",
              [
                {
                  id: "first",
                  title: "t",
                  tool: "gen_paid",
                  paid: false,
                  args: { max_cost_usd: 0.2 },
                },
              ],
              { output: "${steps.first}" },
            ),
            recipe(
              "downgrade_cap",
              [
                {
                  id: "first",
                  title: "t",
                  capability: "image.generate",
                  paid: false,
                  args: { max_cost_usd: 0.2 },
                },
              ],
              { output: "${steps.first}" },
            ),
            recipe(
              "fallback",
              [
                {
                  id: "first",
                  title: "t",
                  tool: "gen_paid",
                  paid: false,
                  args: {},
                  onError: { fallback: { id: "second", tool: "gen_b", args: {} } },
                },
              ],
              { output: "${steps.first}" },
            ),
          ],
          { id: "flows", tools: ["gen_paid", "gen_b", "cap:image.generate"] },
        );
      },
    });
  });
  afterAll(async () => h?.close());
  beforeEach(() => {
    mock = new MockTools().install();
  });

  it("dry run counts a paid-tagged tool as paid even with paid: false", async () => {
    const plan = await runOk(h, "wf_downgrade_tagged", { dry_run: true });
    expect(plan.paid_calls_max).toBe(1);
    expect((plan.steps as Obj[])[0]).toMatchObject({ paid: true });
    expect(mock.calls).toEqual([]);
  });

  it("dry run counts a capability step as paid even with paid: false", async () => {
    const plan = await runOk(h, "wf_downgrade_cap", { dry_run: true });
    expect(plan.paid_calls_max).toBe(1);
    expect((plan.steps as Obj[])[0]).toMatchObject({ paid: true });
    expect(mock.calls).toEqual([]);
  });

  it("a paid-tagged step with paid: false still blocks its paid fallback after an unknown outcome", async () => {
    mock.handlers.gen_paid = () => {
      throw new Error("gen_paid: timed out after the request was sent");
    };
    mock.handlers.gen_b = () => ({ from: "gen_b" });
    const plan = await runOk(h, "wf_fallback", { dry_run: true });
    expect((plan.steps as Obj[])[0]).toMatchObject({
      paid: true,
      fallback_after_unknown_outcome: "never",
    });
    const env = await h.call("wf_fallback", {});
    expect(env.ok).toBe(false);
    expect(env.error?.message).toMatch(
      /may have been charged, so its paid fallback "second" was not run/,
    );
    expect(mock.order()).toEqual(["gen_paid"]);
  });
});
