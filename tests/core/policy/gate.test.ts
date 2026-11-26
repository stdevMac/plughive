// tests/core/policy/gate.test.ts
//
// The spend gate with the real router, registry, approvals store and usage
// ledger. Every provider is a fake: no paid call leaves the process.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { PaidCallCache } from "../../../src/core/capabilities/paid-cache.js";
import { CapabilityRouter, type ProviderBinding } from "../../../src/core/capabilities/router.js";
import { requestScope } from "../../../src/core/mcp/scope.js";
import { ApprovalStore, callFingerprint } from "../../../src/core/policy/approvals.js";
import { PolicyError } from "../../../src/core/policy/errors.js";
import { PolicyGate } from "../../../src/core/policy/gate.js";
import {
  PolicyFileError,
  policyPath,
  readPolicy,
  writePolicy,
} from "../../../src/core/policy/policy.js";
import {
  currentPolicyRun,
  runInPolicyJob,
  runPreApproved,
} from "../../../src/core/policy/run-context.js";
import { type RegisteredTool, ToolRegistry } from "../../../src/core/tools/registry.js";
import { UsageLedger } from "../../../src/lib/usage.js";
import { expectMode } from "../../support/platform.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const TTL = 30 * 60_000;

function provider(
  id: string,
  o: {
    priority?: number;
    usd?: number | null;
    calls?: string[];
    cost?: "local" | "account" | "paid";
  } = {},
): ProviderBinding {
  return {
    def: {
      capability: "image.generate",
      id,
      ...(o.cost ? { cost: o.cost } : {}),
      priority: o.priority ?? 0,
      isConfigured: () => true,
      ...(o.usd !== undefined
        ? { estimate: () => (o.usd === null ? null : { usd: o.usd, basis: "static table" }) }
        : {}),
      run: async () => {
        o.calls?.push(id);
        return { artifacts: [{ id: `${id}-1`, url: "/x", mime: "image/png" }], model: "m" };
      },
    },
    context: () => ({ pack: id }) as never,
  } as unknown as ProviderBinding;
}

describe("spend policy gate", () => {
  let home: string;
  let db: Database.Database;
  let ledger: UsageLedger;
  let approvals: ApprovalStore;
  let gate: PolicyGate;
  let router: CapabilityRouter;
  let calls: string[];
  let now: number;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "plughive-policy-"));
    db = new Database(":memory:");
    ledger = new UsageLedger({ root: home });
    now = Date.now();
    approvals = new ApprovalStore({ db, now: () => now });
    gate = new PolicyGate({
      home,
      approvals,
      spend: ledger,
      baseUrl: "http://127.0.0.1:7777",
      now: () => now,
    });
    router = new CapabilityRouter({ home, logger: silent, gate });
    calls = [];
  });
  afterEach(() => {
    ledger.close();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const spend = (vendor: string, usd: number) =>
    ledger.record({ tool: "t", vendor, costUsd: usd, latencyMs: 1, status: "ok" });
  const run = (input: object = { prompt: "a cat" }, opts: object = {}) =>
    router.run("image.generate", input, opts, {
      pack: "media",
      depth: 0,
      signal: new AbortController().signal,
      tool: "generate_image",
    }) as Promise<{ provider: string }>;
  const policy = (p: object) => writePolicy(home, { version: 1, ...p });
  const rejection = async (p: Promise<unknown>): Promise<PolicyError> => {
    try {
      await p;
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyError);
      return e as PolicyError;
    }
    throw new Error("expected a PolicyError");
  };

  describe("caps", () => {
    it("a block cap refuses the call", async () => {
      router.registerPack("paid", "builtin", [provider("paid", { usd: 0.5, calls })]);
      policy({ caps: [{ scope: "global", period: "daily", limit_usd: 1, mode: "block" }] });
      spend("paid", 0.8);
      const err = await rejection(run());
      expect(err.code).toBe("SPEND_BLOCKED");
      expect(err.message).toMatch(/daily global cap/);
      expect(calls).toEqual([]);
    });

    it("a provider cap falls back to the next provider", async () => {
      router.registerPack("a", "builtin", [provider("a", { priority: 9, usd: 0.5, calls })]);
      router.registerPack("b", "builtin", [provider("b", { priority: 1, usd: 0.5, calls })]);
      policy({
        caps: [{ scope: "provider", id: "a", period: "monthly", limit_usd: 1, mode: "block" }],
      });
      spend("a", 0.9);
      expect((await run()).provider).toBe("b");
      expect(calls).toEqual(["b"]);
    });

    it("an ask cap asks for approval when no provider is left", async () => {
      router.registerPack("paid", "builtin", [provider("paid", { usd: 0.5, calls })]);
      policy({ caps: [{ scope: "global", period: "daily", limit_usd: 1, mode: "ask" }] });
      spend("paid", 0.8);
      const err = await rejection(run());
      expect(err.code).toBe("APPROVAL_REQUIRED");
      expect(err.approval?.url).toMatch(/^http:\/\/127\.0\.0\.1:7777\/approvals\?id=apr_/);
      expect(calls).toEqual([]);
      expect(approvals.pendingCount()).toBe(1);
    });

    it("an unknown cost never runs unchecked under a cap", async () => {
      // A priced provider is preferred over one with no estimate.
      router.registerPack("x", "builtin", [provider("x", { priority: 9, usd: null, calls })]);
      router.registerPack("y", "builtin", [provider("y", { priority: 1, usd: 0.1, calls })]);
      policy({ caps: [{ scope: "global", period: "daily", limit_usd: 5, mode: "block" }] });
      expect((await run()).provider).toBe("y");
      expect(calls).toEqual(["y"]);
    });

    it("an unknown cost asks under an ask cap and is refused under a block cap", async () => {
      router.registerPack("x", "builtin", [provider("x", { usd: null, calls })]);
      policy({ caps: [{ scope: "global", period: "daily", limit_usd: 5, mode: "ask" }] });
      const asked = await rejection(run());
      expect(asked.code).toBe("APPROVAL_REQUIRED");
      expect(asked.approval?.reason).toMatch(/cost unknown/);
      policy({ caps: [{ scope: "global", period: "daily", limit_usd: 5, mode: "block" }] });
      const blocked = await rejection(run());
      expect(blocked.code).toBe("SPEND_BLOCKED");
      expect(blocked.message).toMatch(/cost unknown \(no estimate\) under the daily global cap/);
      expect(calls).toEqual([]);
    });

    it("free (local) calls are not held by caps", async () => {
      router.registerPack("local", "builtin", [provider("local", { usd: 0, calls })]);
      policy({ caps: [{ scope: "global", period: "daily", limit_usd: 0, mode: "block" }] });
      expect((await run()).provider).toBe("local");
    });

    it("a profile cap counts only that profile's spend", async () => {
      router.registerPack("paid", "builtin", [provider("paid", { usd: 0.5, calls })]);
      policy({
        caps: [{ scope: "profile", id: "kids", period: "daily", limit_usd: 1, mode: "block" }],
      });
      ledger.record({
        tool: "t",
        vendor: "paid",
        costUsd: 0.9,
        latencyMs: 1,
        status: "ok",
        profile: "kids",
      });
      await expect(requestScope.run({ profileId: "work" }, () => run())).resolves.toBeTruthy();
      const err = await rejection(requestScope.run({ profileId: "kids" }, () => run()));
      expect(err.code).toBe("SPEND_BLOCKED");
    });

    it("H-3: reserves in-flight spend across concurrent calls under a block cap", async () => {
      let releaseFirst!: () => void;
      let started = 0;
      router.registerPack("paid", "builtin", [
        {
          def: {
            capability: "image.generate",
            id: "paid",
            priority: 0,
            isConfigured: () => true,
            estimate: () => ({ usd: 0.6, basis: "static table" }),
            run: async () => {
              started++;
              calls.push("paid");
              if (started === 1) {
                await new Promise<void>((r) => {
                  releaseFirst = r;
                });
              }
              return { artifacts: [{ id: "paid-1", url: "/x", mime: "image/png" }], model: "m" };
            },
          },
          context: () => ({ pack: "paid" }) as never,
        } as unknown as ProviderBinding,
      ]);
      policy({ caps: [{ scope: "global", period: "daily", limit_usd: 1, mode: "block" }] });

      const first = run();
      // Wait until the first call is inside provider.run (awaiting releaseFirst).
      while (started === 0) await new Promise((r) => setTimeout(r, 5));
      const second = rejection(run());
      const secondErr = await second;
      expect(secondErr.code).toBe("SPEND_BLOCKED");
      expect(calls).toEqual(["paid"]);

      releaseFirst();
      expect((await first).provider).toBe("paid");
    });

    it("H-3: releases the reservation in finally when a call fails", async () => {
      let shouldFail = true;
      router.registerPack("paid", "builtin", [
        {
          def: {
            capability: "image.generate",
            id: "paid",
            isConfigured: () => true,
            estimate: () => ({ usd: 0.6, basis: "static table" }),
            run: async () => {
              calls.push("paid");
              if (shouldFail) throw new Error("provider boom");
              return { artifacts: [{ id: "paid-1", url: "/x", mime: "image/png" }], model: "m" };
            },
          },
          context: () => ({ pack: "paid" }) as never,
        } as unknown as ProviderBinding,
      ]);
      policy({ caps: [{ scope: "global", period: "daily", limit_usd: 1, mode: "block" }] });

      await expect(run()).rejects.toThrow(/provider boom/);
      shouldFail = false;
      expect((await run()).provider).toBe("paid");
      expect(calls).toEqual(["paid", "paid"]);
    });

    it("H-3: two concurrent workflow runs under a block cap: one is refused", async () => {
      policy({ caps: [{ scope: "global", period: "daily", limit_usd: 1, mode: "block" }] });
      let release!: () => void;
      const slowRun = () =>
        new Promise<string>((resolve) => {
          release = () => resolve("done");
        });
      // The reservation is taken synchronously when the first run passes the
      // cap check, so the second run already sees it.
      const first = gate.runWorkflow({ name: "wf_a", args: {}, maxUsd: 0.6 }, undefined, slowRun);
      const err = await rejection(
        gate.runWorkflow({ name: "wf_b", args: {}, maxUsd: 0.6 }, undefined, async () => "x"),
      );
      expect(err.code).toBe("SPEND_BLOCKED");
      release();
      expect(await first).toBe("done");
      // Released once the run finished: the cap room is free again.
      expect(
        await gate.runWorkflow({ name: "wf_c", args: {}, maxUsd: 0.6 }, undefined, async () => "y"),
      ).toBe("y");
    });

    it("D-H1: a workflow nested in an approved run is checked on its own", async () => {
      policy({ rules: { auto_approve_under_usd: 0.5 } });
      const child = () =>
        gate.runWorkflow({ name: "wf_child", args: {}, maxUsd: 5 }, undefined, async () => "ran");
      // Inside an approved parent run the child still needs its own approval.
      const err = await rejection(runPreApproved(child));
      expect(err.code).toBe("APPROVAL_REQUIRED");
      expect(err.message).toMatch(/up to \$5\.00/);
      // A nested child that fits under the rules runs, and its body is not pre-approved.
      let inner: boolean | undefined;
      const small = await runPreApproved(() =>
        gate.runWorkflow({ name: "wf_small", args: {}, maxUsd: 0.1 }, undefined, async () => {
          inner = currentPolicyRun().preApproved;
          return "ok";
        }),
      );
      expect(small).toBe("ok");
      expect(inner).toBe(false);
    });
  });

  describe("max_cost_usd", () => {
    it("skips providers over the maximum and those with no estimate", async () => {
      router.registerPack("dear", "builtin", [provider("dear", { priority: 9, usd: 2, calls })]);
      router.registerPack("unk", "builtin", [provider("unk", { priority: 5, calls })]);
      router.registerPack("ok", "builtin", [provider("ok", { priority: 1, usd: 0.1, calls })]);
      expect((await run({ prompt: "a cat", max_cost_usd: 0.5 })).provider).toBe("ok");
      expect(calls).toEqual(["ok"]);
    });

    it("counts local and account providers without an estimate as free", async () => {
      router.registerPack("acct", "builtin", [
        provider("acct", { priority: 9, cost: "account", calls }),
      ]);
      router.registerPack("loc", "builtin", [
        provider("loc", { priority: 5, cost: "local", calls }),
      ]);
      expect((await run({ prompt: "a cat", max_cost_usd: 0.01 })).provider).toBe("acct");
      router.unregisterPack("acct");
      expect((await run({ prompt: "a dog" }, { maxCostUsd: 0 })).provider).toBe("loc");
      expect(calls).toEqual(["acct", "loc"]);
    });

    it("refuses with the reasons when nothing fits", async () => {
      router.registerPack("unk", "builtin", [provider("unk", { calls })]);
      const err = await rejection(run({ prompt: "a cat" }, { maxCostUsd: 1 }));
      expect(err.code).toBe("SPEND_BLOCKED");
      expect(err.message).toMatch(/cost unknown/);
    });

    it("M-3: rejects invalid max_cost_usd explicitly instead of dropping it", async () => {
      router.registerPack("paid", "builtin", [provider("paid", { usd: 0.5, calls })]);
      for (const bad of [-1, "0.05", Number.NaN, 10_001, null]) {
        await expect(run({ prompt: "a cat", max_cost_usd: bad })).rejects.toMatchObject({
          code: "INVALID_ARGUMENTS",
        });
      }
      await expect(run({ prompt: "a cat" }, { maxCostUsd: -0.5 })).rejects.toMatchObject({
        code: "INVALID_ARGUMENTS",
      });
      expect(calls).toEqual([]);
    });
  });

  describe("approvals", () => {
    beforeEach(() => {
      router.registerPack("paid", "builtin", [provider("paid", { usd: 0.5, calls })]);
      policy({ rules: { always_ask_providers: ["paid"] } });
    });

    it("an approval is consumed once", async () => {
      const first = await rejection(run());
      const id = first.approval?.id as string;
      expect(approvals.decide(id, "approved", "test", TTL)).toBe(true);
      expect((await run()).provider).toBe("paid");
      expect(calls).toEqual(["paid"]);
      expect(approvals.get(id)?.status).toBe("consumed");
      // The same call again needs a new approval.
      const again = await rejection(run());
      expect(again.code).toBe("APPROVAL_REQUIRED");
      expect(again.approval?.id).not.toBe(id);
      expect(calls).toEqual(["paid"]);
    });

    it("does not cover different arguments", async () => {
      const first = await rejection(run({ prompt: "a cat" }));
      approvals.decide(first.approval?.id as string, "approved", "test", TTL);
      const other = await rejection(run({ prompt: "a dog" }));
      expect(other.code).toBe("APPROVAL_REQUIRED");
      expect(other.approval?.id).not.toBe(first.approval?.id);
      expect(calls).toEqual([]);
      // max_cost_usd is not part of the call: the approved call still matches.
      expect((await run({ prompt: "a cat", max_cost_usd: 5 })).provider).toBe("paid");
    });

    it("a pending request is reused, not duplicated", async () => {
      const a = await rejection(run());
      const b = await rejection(run());
      expect(b.approval?.id).toBe(a.approval?.id);
      expect(approvals.pendingCount()).toBe(1);
    });

    it("an expired approval fails", async () => {
      const first = await rejection(run());
      now += TTL + 1;
      const err = await rejection(run());
      expect(err.code).toBe("APPROVAL_EXPIRED");
      expect(approvals.get(first.approval?.id as string)?.status).toBe("expired");
      // Reported once: the next call asks again.
      expect((await rejection(run())).code).toBe("APPROVAL_REQUIRED");
    });

    it("an approval not used in time expires", async () => {
      const first = await rejection(run());
      approvals.decide(first.approval?.id as string, "approved", "test", TTL);
      now += TTL + 1;
      expect((await rejection(run())).code).toBe("APPROVAL_EXPIRED");
      expect(calls).toEqual([]);
    });

    it("a denial fails", async () => {
      const first = await rejection(run());
      approvals.decide(first.approval?.id as string, "denied", "test", TTL);
      expect(approvals.decide(first.approval?.id as string, "approved", "test", TTL)).toBe(false);
      const err = await rejection(run());
      expect(err.code).toBe("APPROVAL_DENIED");
      expect(calls).toEqual([]);
    });

    it("keeps only a short redacted summary of the arguments", async () => {
      const err = await rejection(
        run({ prompt: `${"x".repeat(2000)} https://user:hunter2@example.com/` }),
      );
      const row = approvals.get(err.approval?.id as string);
      expect(row?.args_summary.length).toBeLessThanOrEqual(400);
      expect(row?.args_summary).not.toContain("hunter2");
    });

    it("a job waits and resumes on approval", async () => {
      const phases: string[] = [];
      const job = {
        id: "job_1",
        awaiting: (waiting: boolean, message: string | null) =>
          phases.push(waiting ? `awaiting ${message}` : "running"),
      };
      const done = runInPolicyJob(job, () => run());
      await new Promise((r) => setTimeout(r, 20));
      expect(phases[0]).toMatch(/^awaiting awaiting approval: http:\/\/.*approvals\?id=apr_/);
      const [pending] = approvals.list({ status: "pending" });
      expect(pending?.job_id).toBe("job_1");
      expect(calls).toEqual([]);
      approvals.decide(pending?.id as string, "approved", "test", TTL);
      expect((await done).provider).toBe("paid");
      expect(phases.at(-1)).toBe("running");
      expect(approvals.get(pending?.id as string)?.status).toBe("consumed");
    });

    it("a job fails when the request is denied", async () => {
      const job = { id: "job_2", awaiting: () => undefined };
      const done = runInPolicyJob(job, () => run());
      await new Promise((r) => setTimeout(r, 20));
      const [pending] = approvals.list({ status: "pending" });
      approvals.decide(pending?.id as string, "denied", "test", TTL);
      expect((await rejection(done)).code).toBe("APPROVAL_DENIED");
      expect(calls).toEqual([]);
    });
  });

  describe("registry gate", () => {
    let registry: ToolRegistry;
    let ran: string[];
    const tool = (name: string, extra: Partial<RegisteredTool>): RegisteredTool =>
      ({
        name,
        packId: "p",
        origin: "native",
        description: "",
        inputSchema: {},
        input: z.object({ n: z.number().optional() }),
        run: async () => {
          ran.push(name);
          return { ok: true };
        },
        ...extra,
      }) as RegisteredTool;

    beforeEach(() => {
      ran = [];
      registry = new ToolRegistry({ gate });
      registry.registerPack("p", [
        tool("fal_run", { tags: ["paid"] }),
        tool("wipe", { annotations: { destructiveHint: true } }),
        tool("send_email", { tags: ["sends"], annotations: { destructiveHint: true } }),
        tool("read", {}),
      ]);
    });

    it("runs everything but sending tools under the default policy", async () => {
      for (const name of ["fal_run", "wipe", "read"]) {
        expect((await registry.call(name, {})).ok).toBe(true);
      }
    });

    it("asks before destructive tools only when the rule is on", async () => {
      policy({ rules: { ask_before_destructive: true } });
      const out = await registry.call("wipe", { n: 1 });
      expect(out.ok).toBe(false);
      if (out.ok) return;
      expect(out.error.code).toBe("APPROVAL_REQUIRED");
      expect(out.error.retryable).toBe(true);
      expect(out.error.approval?.url).toContain("/approvals?id=");
      approvals.decide(out.error.approval?.id as string, "approved", "t", TTL);
      expect((await registry.call("wipe", { n: 2 })).ok).toBe(false);
      expect((await registry.call("wipe", { n: 1 })).ok).toBe(true);
      expect(ran).toEqual(["wipe"]);
    });

    it("asks before mounted tools unless the upstream marks them read-only", async () => {
      const upstream: string[] = [];
      const entry = (name: string, hints?: Record<string, boolean>) => ({
        qualifiedName: `up__${name}`,
        mountId: "up",
        prefix: "up",
        upstreamName: name,
        description: name,
        ...(hints ? { hints } : {}),
      });
      registry.attachMounts({
        list: () => [
          entry("delete_repo"),
          entry("create_issue", { destructiveHint: false }),
          entry("search", { readOnlyHint: true }),
        ],
        call: async (_m, name) => {
          upstream.push(name);
          return {};
        },
      });
      expect((await registry.call("up__delete_repo", {})).ok).toBe(true);
      policy({ rules: { ask_before_destructive: true } });
      const out = await registry.call("up__delete_repo", {});
      expect(out.ok ? null : out.error.code).toBe("APPROVAL_REQUIRED");
      expect((await registry.call("up__create_issue", {})).ok).toBe(true);
      expect((await registry.call("up__search", {})).ok).toBe(true);
      expect(upstream).toEqual(["delete_repo", "create_issue", "search"]);
    });

    it("asks before a tool that sends, by default", async () => {
      const out = await registry.call("send_email", { to: "a@example.com" });
      expect(out.ok ? null : out.error.code).toBe("APPROVAL_REQUIRED");
      if (out.ok) return;
      const id = out.error.approval?.id as string;
      expect(approvals.get(id)?.reason).toMatch(/reaches other people/);
      approvals.decide(id, "approved", "t", TTL);
      expect((await registry.call("send_email", { to: "a@example.com" })).ok).toBe(true);
      expect(ran).toEqual(["send_email"]);
    });

    it("H-4: sending, destructive, and always-ask rules still ask inside an approved run", async () => {
      const inRun = (name: string) => runPreApproved(() => registry.call(name, {}));
      expect((await inRun("send_email")).ok).toBe(false);
      policy({ rules: { ask_before_destructive: true } });
      const wipeOut = await inRun("wipe");
      expect(wipeOut.ok ? null : wipeOut.error.code).toBe("APPROVAL_REQUIRED");
      policy({ rules: { always_ask_tools: ["read"] } });
      const readOut = await inRun("read");
      expect(readOut.ok ? null : readOut.error.code).toBe("APPROVAL_REQUIRED");
      policy({ rules: { ask_before_sending: false } });
      expect((await inRun("send_email")).ok).toBe(true);
    });

    it("H-4: always_ask_providers still asks inside an approved run", async () => {
      router.registerPack("paid", "builtin", [provider("paid", { usd: 0.5, calls })]);
      policy({ rules: { always_ask_providers: ["paid"] } });
      const err = await rejection(runPreApproved(() => run()));
      expect(err.code).toBe("APPROVAL_REQUIRED");
      expect(calls).toEqual([]);
    });

    it("H-4: an approved paid tool's nested capability calls do not re-ask for cost, while a non-paid tool's do", async () => {
      router.registerPack("paid", "builtin", [provider("paid", { usd: 0.5, calls })]);
      policy({ rules: { auto_approve_under_usd: 0.01, ask_before_sending: true } });
      registry.registerPack("nested", [
        tool("paid_caller", {
          tags: ["paid"],
          run: async () => run(),
        }),
        tool("send_caller", {
          tags: ["sends"],
          run: async () => run(),
        }),
      ]);

      // Paid tool approved once -> nested capability call passes cost check without re-asking.
      const firstPaid = await registry.call("paid_caller", {});
      expect(firstPaid.ok ? null : firstPaid.error.code).toBe("APPROVAL_REQUIRED");
      if (!firstPaid.ok) {
        approvals.decide(firstPaid.error.approval?.id as string, "approved", "t", TTL);
      }
      expect((await registry.call("paid_caller", {})).ok).toBe(true);
      expect(calls).toEqual(["paid"]);

      // Non-paid sending tool approved -> nested capability call STILL asks for cost!
      const firstSend = await registry.call("send_caller", {});
      expect(firstSend.ok ? null : firstSend.error.code).toBe("APPROVAL_REQUIRED");
      if (!firstSend.ok) {
        approvals.decide(firstSend.error.approval?.id as string, "approved", "t", TTL);
      }
      const afterSend = await registry.call("send_caller", {});
      expect(afterSend.ok ? null : afterSend.error.code).toBe("APPROVAL_REQUIRED");
      expect(calls).toEqual(["paid"]);
    });

    it("H-5: tool approvals cannot be replayed with a higher max_cost_usd or higher estimate", async () => {
      // A loose input schema (as pack tools use) keeps max_cost_usd in the args the gate sees.
      registry.registerPack("loose", [
        tool("loose_run", { tags: ["paid"], input: z.looseObject({}) }),
      ]);
      policy({ rules: { always_ask_tools: ["loose_run"] } });
      const low = await registry.call("loose_run", { max_cost_usd: 0.01 });
      expect(low.ok ? null : low.error.code).toBe("APPROVAL_REQUIRED");
      if (!low.ok) {
        approvals.decide(low.error.approval?.id as string, "approved", "t", TTL);
      }
      // Replaying with max_cost_usd: 10000 does not match the 0.01 approval.
      const high = await registry.call("loose_run", { max_cost_usd: 10_000 });
      expect(high.ok ? null : high.error.code).toBe("APPROVAL_REQUIRED");
      expect(ran).toEqual([]);

      // Fingerprints keep max_cost_usd for tool/workflow, and only strip for provider.
      expect(
        callFingerprint({
          kind: "tool",
          tool: "fal_run",
          profile: "default",
          args: { prompt: "x", max_cost_usd: 0.01 },
        }),
      ).not.toBe(
        callFingerprint({
          kind: "tool",
          tool: "fal_run",
          profile: "default",
          args: { prompt: "x", max_cost_usd: 10_000 },
        }),
      );
      expect(
        callFingerprint({
          kind: "workflow",
          tool: "wf_x",
          profile: "default",
          args: { max_cost_usd: 0.01 },
        }),
      ).not.toBe(
        callFingerprint({
          kind: "workflow",
          tool: "wf_x",
          profile: "default",
          args: { max_cost_usd: 10_000 },
        }),
      );
      expect(
        callFingerprint({
          kind: "provider",
          tool: "image.generate",
          provider: "paid",
          profile: "default",
          args: { prompt: "x", max_cost_usd: 0.01 },
        }),
      ).toBe(
        callFingerprint({
          kind: "provider",
          tool: "image.generate",
          provider: "paid",
          profile: "default",
          args: { prompt: "x", max_cost_usd: 10_000 },
        }),
      );

      // Even for providers, a higher estimate on retry cannot consume a lower approved estimate.
      let est = 0.01;
      router.registerPack("dyn", "builtin", [
        {
          def: {
            capability: "image.generate",
            id: "dyn",
            isConfigured: () => true,
            estimate: () => ({ usd: est, basis: "dynamic" }),
            run: async () => {
              calls.push("dyn");
              return { artifacts: [{ id: "dyn-1", url: "/x", mime: "image/png" }], model: "m" };
            },
          },
          context: () => ({ pack: "dyn" }) as never,
        } as unknown as ProviderBinding,
      ]);
      policy({ rules: { always_ask_providers: ["dyn"] } });
      const firstDyn = await rejection(run());
      approvals.decide(firstDyn.approval?.id as string, "approved", "t", TTL);
      est = 5.0;
      const retryHigh = await rejection(run());
      expect(retryHigh.code).toBe("APPROVAL_REQUIRED");
      expect(retryHigh.approval?.id).not.toBe(firstDyn.approval?.id);
      expect(calls).toEqual([]);
    });

    it("ask_before_sending off lets sending tools run, globally or for one profile", async () => {
      policy({ rules: { ask_before_sending: false } });
      expect((await registry.call("send_email", {})).ok).toBe(true);
      policy({ profiles: { bot: { ask_before_sending: false } } });
      expect((await registry.call("send_email", {})).ok).toBe(false);
      const asBot = await requestScope.run({ profileId: "bot" }, () =>
        registry.call("send_email", {}),
      );
      expect(asBot.ok).toBe(true);
    });

    it("decideInChat: only when approve_in_chat is on, only for the caller's own profile", async () => {
      const opened = await registry.call("send_email", {});
      const id = opened.ok ? "" : (opened.error.approval?.id ?? "");
      expect(id).toMatch(/^apr_/);
      const token = gate.chatFormShown(id);
      // Off by default.
      expect(gate.chatApprovalsAllowed("default")).toBe(false);
      expect(gate.decideInChat(id, true, "default", token)).toBe(false);
      policy({ rules: { approve_in_chat: true } });
      // Another profile cannot decide this profile's request.
      expect(gate.decideInChat(id, true, "bot", token)).toBe(false);
      // A profile can opt out on its own.
      policy({
        rules: { approve_in_chat: true },
        profiles: { default: { approve_in_chat: false } },
      });
      expect(gate.decideInChat(id, true, "default", token)).toBe(false);
      policy({ rules: { approve_in_chat: true } });
      expect(gate.decideInChat(id, true, "default", token)).toBe(true);
      expect(approvals.get(id)).toMatchObject({ status: "approved", decided_by: "mcp-chat" });
      // Decided once.
      expect(gate.decideInChat(id, false, "default", token)).toBe(false);
      expect((await registry.call("send_email", {})).ok).toBe(true);
    });

    it("R2-M2: decideInChat needs the token of a form that was shown", async () => {
      policy({ rules: { approve_in_chat: true } });
      const opened = await registry.call("send_email", {});
      const id = opened.ok ? "" : (opened.error.approval?.id ?? "");
      // No form shown yet: nothing to answer.
      expect(gate.decideInChat(id, true, "default", undefined)).toBe(false);
      expect(gate.decideInChat(id, true, "default", "made-up")).toBe(false);
      const token = gate.chatFormShown(id);
      expect(gate.decideInChat(id, true, "default", `${token.slice(0, -1)}x`)).toBe(false);
      // A form shown for another request does not answer this one.
      const other = gate.chatFormShown("apr_other");
      expect(gate.decideInChat(id, true, "default", other)).toBe(false);
      expect(approvals.get(id)?.status).toBe("pending");
      expect(gate.decideInChat(id, true, "default", token)).toBe(true);
    });

    it("always-ask tools ask", async () => {
      policy({ rules: { always_ask_tools: ["read"] } });
      const out = await registry.call("read", {});
      expect(out.ok ? null : out.error.code).toBe("APPROVAL_REQUIRED");
    });

    it("a paid tool is refused by a used-up block cap", async () => {
      policy({ caps: [{ scope: "global", period: "monthly", limit_usd: 1, mode: "block" }] });
      spend("fal", 1);
      const out = await registry.call("fal_run", {});
      expect(out.ok ? null : out.error.code).toBe("SPEND_BLOCKED");
      expect(ran).toEqual([]);
    });
  });

  describe("the paid-call cache and the gate", () => {
    it("Vibe-L: a cache hit costs $0 so caps skip it, but always-ask providers still ask, and the cache is per profile", async () => {
      const existing = new Set<string>();
      const paidCache = new PaidCallCache({ home, artifactExists: (id) => existing.has(id) });
      const cachedRouter = new CapabilityRouter({ home, logger: silent, gate, paidCache });
      cachedRouter.registerPack("paid", "builtin", [provider("paid", { usd: 0.5, calls })]);
      const runCached = (input: object = { prompt: "a cat" }) =>
        cachedRouter.run(
          "image.generate",
          input,
          {},
          {
            pack: "media",
            depth: 0,
            signal: new AbortController().signal,
            tool: "generate_image",
          },
        ) as Promise<{ provider: string; cached?: boolean }>;

      // First call runs the provider and saves the paid result.
      expect((await runCached()).provider).toBe("paid");
      existing.add("paid-1");
      expect(calls).toEqual(["paid"]);

      // A hit is $0: a block cap that would refuse a fresh call does not touch it.
      policy({ caps: [{ scope: "global", period: "daily", limit_usd: 0.1, mode: "block" }] });
      expect(await runCached()).toMatchObject({ provider: "paid", cached: true });
      expect(calls).toEqual(["paid"]);

      // always_ask_providers still asks on a cache hit.
      policy({
        caps: [{ scope: "global", period: "daily", limit_usd: 0.1, mode: "block" }],
        rules: { always_ask_providers: ["paid"] },
      });
      const err = await rejection(runCached());
      expect(err.code).toBe("APPROVAL_REQUIRED");
      expect(calls).toEqual(["paid"]);

      // The cache is per profile: another profile does not get this one's saved result.
      policy({});
      const asKids = await requestScope.run({ profileId: "kids" }, () => runCached());
      expect(asKids.provider).toBe("paid");
      expect(asKids.cached).toBeUndefined();
      expect(calls).toEqual(["paid", "paid"]);
    });
  });

  describe("requestApproval (non-blocking, for installs)", () => {
    const req = { tool: "system/install_software", args: { id: "ollama" }, reason: "install" };

    it("opens one pending request, reuses it, and is used up once approved", () => {
      const first = gate.requestApproval(req);
      expect(first.status).toBe("pending");
      if (first.status === "approved") return;
      expect(first.approval.url).toBe(
        `http://127.0.0.1:7777/approvals?id=${encodeURIComponent(first.approval.id)}`,
      );
      const again = gate.requestApproval(req);
      expect(again.status === "approved" ? null : again.approval.id).toBe(first.approval.id);
      expect(approvals.pendingCount()).toBe(1);
      // Other arguments are another request.
      expect(gate.requestApproval({ ...req, args: { id: "ffmpeg" } }).status).toBe("pending");
      approvals.decide(first.approval.id, "approved", "t", TTL);
      expect(gate.requestApproval(req).status).toBe("approved");
      // Used up: the next identical call asks again.
      expect(gate.requestApproval(req).status).toBe("pending");
    });

    it("reports a denial once, then asks again", () => {
      const first = gate.requestApproval(req);
      if (first.status === "approved") throw new Error("unexpected");
      approvals.decide(first.approval.id, "denied", "t", TTL);
      expect(gate.requestApproval(req).status).toBe("denied");
      expect(gate.requestApproval(req).status).toBe("pending");
    });
  });

  describe("an invalid policy file", () => {
    beforeEach(() => {
      writeFileSync(policyPath(home), '{"version": 1, "caps": [{"scope": "galaxy"}]}');
    });

    it("is reported, and never overwritten", () => {
      const state = readPolicy(home);
      expect(state.ok).toBe(false);
      expect(() => writePolicy(home, { version: 1 })).toThrow(PolicyFileError);
      expect(readFileSync(policyPath(home), "utf8")).toContain("galaxy");
    });

    it("fails closed: paid calls are refused, free ones run", async () => {
      router.registerPack("paid", "builtin", [provider("paid", { usd: 0.5, calls })]);
      expect((await rejection(run())).code).toBe("SPEND_BLOCKED");
      router.registerPack("local", "builtin", [provider("local", { usd: 0, calls })]);
      expect((await run()).provider).toBe("local");
      const registry = new ToolRegistry({ gate });
      registry.registerPack("fal", [
        {
          name: "fal_run",
          packId: "fal",
          origin: "native",
          description: "",
          inputSchema: {},
          tags: ["paid"],
          input: z.object({}),
          run: async () => ({}),
        } as unknown as RegisteredTool,
      ]);
      const out = await registry.call("fal_run", {});
      expect(out.ok ? null : out.error.code).toBe("SPEND_BLOCKED");
    });

    it("M-4: a workflow that may cost money is refused too; a free one still runs", async () => {
      const ran: string[] = [];
      const run = async (name: string) => {
        ran.push(name);
        return name;
      };
      const err = await rejection(
        gate.runWorkflow({ name: "wf_paid", args: {}, maxUsd: 1 }, undefined, () => run("wf_paid")),
      );
      expect(err.code).toBe("SPEND_BLOCKED");
      expect(err.message).toMatch(/wf_paid not run/);
      expect(ran).toEqual([]);
      expect(
        await gate.runWorkflow({ name: "wf_free", args: {}, maxUsd: 0 }, undefined, () =>
          run("wf_free"),
        ),
      ).toBe("wf_free");
      expect(ran).toEqual(["wf_free"]);
    });
  });

  it("writes policy.json readable by the owner only", () => {
    policy({ caps: [] });
    expectMode(policyPath(home), 0o600);
    expect(() => writePolicy(home, { version: 2 })).toThrow(PolicyFileError);
  });
});
