// tests/core/workflows/spend.test.ts
//
// Workflows and the spend gate: dry_run reports an estimated cost range, and
// a run that may go over a cap needs one approval for the whole run. The
// tools are mocks; nothing reaches a provider.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ApprovalStore } from "../../../src/core/policy/approvals.js";
import { PolicyGate } from "../../../src/core/policy/gate.js";
import { writePolicy } from "../../../src/core/policy/policy.js";
import { runInPolicyJob } from "../../../src/core/policy/run-context.js";
import { UsageLedger } from "../../../src/lib/usage.js";
import {
  type LoaderHarness,
  MockTools,
  bootLoader,
  recipe,
  runOk,
  writeWorkflowPack,
} from "./support.js";

type Obj = Record<string, unknown>;
const TTL = 30 * 60_000;
const items = {
  type: "object",
  properties: { items: { type: "array", items: { type: "string" } } },
  required: ["items"],
};

const FLOWS = [
  recipe(
    "capped",
    [
      {
        id: "img",
        title: "One image each",
        tool: "generate_image",
        forEach: "${input.items}",
        as: "it",
        maxItems: 5,
        args: { prompt: "${it}", max_cost_usd: 0.1 },
      },
    ],
    { input: items, output: "${steps.img}" },
  ),
  recipe(
    "open_ended",
    [{ id: "img", title: "An image", tool: "generate_image", args: { prompt: "a cat" } }],
    { output: "${steps.img}" },
  ),
  recipe("free", [{ id: "a", set: 1 }], { output: "${steps.a}" }),
  recipe(
    "fallback_each",
    [
      {
        id: "img",
        title: "One image each, with a dearer fallback",
        tool: "generate_image",
        forEach: "${input.items}",
        as: "it",
        maxItems: 5,
        args: { prompt: "${it}", max_cost_usd: 0.1 },
        onError: {
          fallback: {
            id: "img_again",
            tool: "generate_image",
            args: { prompt: "${it}", max_cost_usd: 0.2 },
          },
          afterUnknownOutcome: true,
        },
      },
    ],
    { input: items, output: "${steps.img}" },
  ),
];

let h: LoaderHarness;
let mock: MockTools;
let db: Database.Database;
let ledger: UsageLedger;
let approvals: ApprovalStore;
let ledgerDir: string;

beforeAll(async () => {
  h = await bootLoader({
    packs: ["media"],
    bundled: false,
    seed(b) {
      writeWorkflowPack(b, FLOWS, { id: "flows", tools: ["generate_image"] });
    },
    policy: {
      // Built lazily so each test gets a fresh store and ledger.
      runWorkflow: (wf, signal, run) => gate().runWorkflow(wf, signal, run),
    },
  });
});
afterAll(async () => h?.close());

let current: PolicyGate | null = null;
const gate = () => current as PolicyGate;

beforeEach(() => {
  mock = new MockTools().install();
  db = new Database(":memory:");
  ledgerDir = mkdtempSync(join(tmpdir(), "plughive-wf-spend-"));
  ledger = new UsageLedger({ root: ledgerDir });
  approvals = new ApprovalStore({ db });
  current = new PolicyGate({
    home: h.dir,
    approvals,
    spend: ledger,
    baseUrl: "http://127.0.0.1:7777",
  });
});
afterEach(() => {
  ledger.close();
  rmSync(ledgerDir, { recursive: true, force: true });
  db.close();
  writePolicy(h.dir, { version: 1 });
  gate().cache.invalidate();
});

const policy = (p: object) => {
  writePolicy(h.dir, { version: 1, ...p });
  gate().cache.invalidate();
};
const spend = (usd: number) =>
  ledger.record({ tool: "t", vendor: "gemini", costUsd: usd, latencyMs: 1, status: "ok" });

describe("dry_run cost estimate", () => {
  it("adds up max_cost_usd over the paid calls", async () => {
    const plan = await runOk(h, "wf_capped", { items: ["a", "b", "c"], dry_run: true });
    expect(plan.paid_calls_max).toBe(3);
    expect(plan.estimated_cost_usd).toEqual({
      min: 0,
      max: 0.3,
      basis: "sum of max_cost_usd over the most paid calls",
    });
    expect((plan.steps as Obj[])[0]).toMatchObject({ id: "img", max_cost_usd_per_call: 0.1 });
    expect(mock.calls).toEqual([]);
  });

  it("is unbounded when a paid step sets no max_cost_usd", async () => {
    const plan = await runOk(h, "wf_open_ended", { dry_run: true });
    expect(plan.estimated_cost_usd).toMatchObject({ min: 0, max: null });
    expect((plan.steps as Obj[])[0]).toMatchObject({ max_cost_usd_per_call: null });
  });

  it("D-H2: counts a forEach step's fallback once per item", async () => {
    const plan = await runOk(h, "wf_fallback_each", { items: ["a", "b", "c"], dry_run: true });
    // 3 items x $0.10, and the fallback may run for each of them: 3 x $0.20.
    expect(plan.paid_calls_max).toBe(6);
    expect(plan.estimated_cost_usd).toMatchObject({ max: 0.9 });
    expect((plan.steps as Obj[])[0]).toMatchObject({ calls: 3, fallback: { calls: 3 } });
  });

  it("is zero without paid steps", async () => {
    const plan = await runOk(h, "wf_free", { dry_run: true });
    expect(plan.estimated_cost_usd).toEqual({ min: 0, max: 0, basis: "no paid steps" });
  });
});

describe("a run over a cap", () => {
  it("runs without asking while it fits under the cap", async () => {
    policy({ caps: [{ scope: "global", period: "daily", limit_usd: 1, mode: "ask" }] });
    const r = await runOk(h, "wf_capped", { items: ["a", "b"] });
    expect(mock.calls).toHaveLength(2);
    expect(r.estimated_cost_usd).toMatchObject({ max: 0.2 });
    expect(approvals.pendingCount()).toBe(0);
  });

  it("needs one approval for the whole run, used once", async () => {
    policy({ caps: [{ scope: "global", period: "daily", limit_usd: 1, mode: "ask" }] });
    spend(0.8);
    const args = { items: ["a", "b", "c"] };
    const first = await h.call("wf_capped", args);
    expect(first.ok).toBe(false);
    expect(first.error?.code).toBe("APPROVAL_REQUIRED");
    expect(first.error?.message).toMatch(/up to \$0\.30/);
    expect(mock.calls).toEqual([]);
    const id = (first.error as { approval?: { id: string } }).approval?.id as string;
    expect(approvals.get(id)).toMatchObject({ kind: "workflow", tool: "wf_capped" });

    // Other args are not covered by it.
    const other = await h.call("wf_capped", { items: ["x", "y", "z"] });
    expect(other.error?.code).toBe("APPROVAL_REQUIRED");
    expect((other.error as { approval?: { id: string } }).approval?.id).not.toBe(id);

    expect(approvals.decide(id, "approved", "test", TTL)).toBe(true);
    await runOk(h, "wf_capped", args);
    expect(mock.calls).toHaveLength(3);
    expect(approvals.get(id)?.status).toBe("consumed");

    const again = await h.call("wf_capped", args);
    expect(again.error?.code).toBe("APPROVAL_REQUIRED");
    expect(mock.calls).toHaveLength(3);
  });

  it("a block cap refuses the run before any step", async () => {
    policy({ caps: [{ scope: "global", period: "daily", limit_usd: 1, mode: "block" }] });
    spend(0.8);
    const env = await h.call("wf_capped", { items: ["a", "b", "c"] });
    expect(env.error?.code).toBe("SPEND_BLOCKED");
    expect(mock.calls).toEqual([]);
  });

  it("a denied run fails", async () => {
    policy({ caps: [{ scope: "global", period: "daily", limit_usd: 1, mode: "ask" }] });
    spend(0.8);
    const args = { items: ["a", "b", "c"] };
    const first = await h.call("wf_capped", args);
    const id = (first.error as { approval?: { id: string } }).approval?.id as string;
    approvals.decide(id, "denied", "test", TTL);
    const env = await h.call("wf_capped", args);
    expect(env.error?.code).toBe("APPROVAL_DENIED");
    expect(mock.calls).toEqual([]);
  });

  it("inside a job, waits for the approval and then runs", async () => {
    policy({ caps: [{ scope: "global", period: "daily", limit_usd: 1, mode: "ask" }] });
    spend(0.8);
    const states: boolean[] = [];
    const job = { id: "job_1", awaiting: (w: boolean) => void states.push(w) };
    const pending = runInPolicyJob(job, () => h.call("wf_capped", { items: ["a", "b", "c"] }));
    while (approvals.pendingCount() === 0) await new Promise((r) => setTimeout(r, 5));
    expect(mock.calls).toEqual([]);
    const [waiting] = approvals.list({ status: "pending" });
    approvals.decide((waiting as { id: string }).id, "approved", "test", TTL);
    const env = await pending;
    expect(env.ok).toBe(true);
    expect(mock.calls).toHaveLength(3);
    expect(states).toEqual([true, false]);
  });
});
