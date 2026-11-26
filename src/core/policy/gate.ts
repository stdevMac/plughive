// src/core/policy/gate.ts
//
// The spend gate. Two checks, one per layer:
//
// - beforeProvider: the capability router asks it before each provider run.
//   It compares the provider's estimate with the call's `max_cost_usd` and
//   with what is left under each cap, and answers run, skip (the router tries
//   the next provider) or throws (blocked, or a person must approve).
// - runTool: the tool registry runs every tool through it. Tools tagged
//   "paid", destructive tools (when asked for) and tools on the always-ask
//   list need a person's approval first.
//
// Asking: inline (an MCP call) the gate throws APPROVAL_REQUIRED with a link;
// the caller retries the SAME call after a person approved and that retry
// consumes the approval (once). Inside a background job the gate waits for
// the decision instead, showing the job as awaiting approval.
//
// FAIL CLOSED: while policy.json is invalid, every call that may cost money
// (a non-zero or unknown estimate, a "paid" tool) and every destructive tool
// is refused. Free calls go on.
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { CapabilityName } from "../capabilities/schemas.js";
import { DEFAULT_PROFILE_ID, currentScope } from "../mcp/scope.js";
import {
  type Approval,
  type ApprovalKind,
  type ApprovalStore,
  callFingerprint,
} from "./approvals.js";
import { type ApprovalRef, PolicyError } from "./errors.js";
import { type Cap, PolicyCache, type PolicyState, rulesFor } from "./policy.js";
import {
  type SpendReservation,
  currentPolicyRun,
  runNotPreApproved,
  runPreApproved,
  runWithReservation,
} from "./run-context.js";
import {
  type CapStatus,
  type SpendSource,
  capStatus,
  capsFor,
  describeCap,
  overCap,
} from "./spend.js";

export interface CostEstimate {
  usd: number;
  /** Where the number comes from: "static table" or "provider price API". */
  basis: string;
}

export interface ProviderGateCheck {
  capability: CapabilityName;
  provider: string;
  /** The validated capability input (what the provider runs with). */
  input: unknown;
  /** The provider's estimate function, when it has one. */
  estimate?: () => CostEstimate | null | Promise<CostEstimate | null>;
  maxCostUsd?: number;
  /** Another provider may run if this one is skipped. */
  more: boolean;
  signal?: AbortSignal;
}

export interface GatedTool {
  name: string;
  packId: string;
  tags?: readonly string[];
  annotations?: { destructiveHint?: boolean };
}

export interface PolicyGateOptions {
  home: string;
  approvals: ApprovalStore;
  spend: SpendSource;
  /** The daemon origin, used when the request has none. */
  baseUrl: string;
  /** The provider a tool's cost is recorded under (usage ledger vendor). */
  vendorOf?: (tool: string) => string | null;
  now?: () => number;
  logger?: { info(o: object, msg: string): void; warn(o: object, msg: string): void };
}

export const PAID_TAG = "paid";
/** Tools tagged with this always ask before they run (model training, for example). */
export const APPROVAL_TAG = "approval";
/** Tools tagged with this reach other people (email, SMS, calls, posts, bookings); they ask unless rules.ask_before_sending is off. */
export const SENDS_TAG = "sends";
const ESTIMATE_TIMEOUT_MS = 5000;
/** Approve/deny forms remembered at once; the oldest is forgotten first. */
const MAX_CHAT_FORMS = 1000;
/** The window of the max_sends_per_hour ceiling. */
const SEND_WINDOW_MS = 60 * 60_000;

function money(usd: number | null): string {
  if (usd === null) return "an unknown amount";
  return `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

function roundUsd(usd: number): number {
  return Number.isFinite(usd) ? Math.round(usd * 1e6) / 1e6 : usd;
}

function capScopeKey(cap: Cap): string {
  return cap.scope === "global" ? "global" : `${cap.scope}:${cap.id}`;
}

function estimateFitsApproval(requested: number | null, approved: number | null): boolean {
  if (approved === null) return true;
  return requested !== null && requested <= approved;
}

class Reservation implements SpendReservation {
  private readonly amounts = new Map<string, number>();

  constructor(private readonly pool: Set<Reservation>) {
    pool.add(this);
  }

  add(scopeKey: string, amount: number): void {
    if (amount <= 0) return;
    this.amounts.set(scopeKey, roundUsd((this.amounts.get(scopeKey) ?? 0) + amount));
  }

  remaining(scopeKey: string): number {
    return this.amounts.get(scopeKey) ?? 0;
  }

  carve(scopeKey: string, amount: number): number {
    const have = this.amounts.get(scopeKey) ?? 0;
    if (have <= 0 || amount <= 0) return 0;
    const taken = Math.min(have, amount);
    const left = roundUsd(have - taken);
    if (left <= 0) this.amounts.delete(scopeKey);
    else this.amounts.set(scopeKey, left);
    return taken;
  }

  release(): void {
    this.pool.delete(this);
    this.amounts.clear();
  }
}

export class PolicyGate {
  readonly cache: PolicyCache;
  private readonly now: () => number;
  private readonly reservations = new Set<Reservation>();
  /** Approval id -> token of the in-chat form shown for it. */
  private readonly chatForms = new Map<string, string>();
  /** Profile -> start times of its recent sending calls (max_sends_per_hour). */
  private readonly sendTimes = new Map<string, number[]>();

  constructor(private readonly opts: PolicyGateOptions) {
    this.cache = new PolicyCache(opts.home);
    this.now = opts.now ?? Date.now;
  }

  get approvals(): ApprovalStore {
    return this.opts.approvals;
  }

  /** Where spend so far is read from (the usage ledger). */
  get spend(): SpendSource {
    return this.opts.spend;
  }

  policy(): PolicyState {
    return this.cache.get();
  }

  private profile(): string {
    return currentScope()?.profileId ?? DEFAULT_PROFILE_ID;
  }

  private ttlMs(state: PolicyState): number {
    return state.policy.approval_ttl_minutes * 60_000;
  }

  /** True when this profile's rules let an MCP client's form answer an approval (`approve_in_chat`). */
  chatApprovalsAllowed(profile: string): boolean {
    return rulesFor(this.policy().policy, profile).approve_in_chat;
  }

  /**
   * Remember that the approve/deny form for request `id` was shown, and return
   * the token the answer must carry back. An answer without it was not given
   * to that form (a client can send an answer with its very first call).
   */
  chatFormShown(id: string): string {
    const token = randomBytes(24).toString("base64url");
    this.chatForms.delete(id);
    this.chatForms.set(id, token);
    while (this.chatForms.size > MAX_CHAT_FORMS) {
      const oldest = this.chatForms.keys().next().value as string;
      this.chatForms.delete(oldest);
    }
    return token;
  }

  /**
   * Decide a pending approval from the caller's own chat form. Only when the
   * caller's profile allows it, only for a request that profile opened, and
   * only as the answer to a form this gate showed (`token` from chatFormShown).
   */
  decideInChat(id: string, approve: boolean, profile: string, token: unknown): boolean {
    if (!this.chatApprovalsAllowed(profile)) return false;
    const shown = this.chatForms.get(id);
    if (shown === undefined || typeof token !== "string") return false;
    const a = Buffer.from(shown);
    const b = Buffer.from(token);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    const store = this.opts.approvals;
    const open = store.get(id);
    if (!open || open.status !== "pending" || open.profile !== profile) return false;
    this.chatForms.delete(id);
    const decided = store.decide(
      id,
      approve ? "approved" : "denied",
      "mcp-chat",
      this.ttlMs(this.policy()),
    );
    if (decided) {
      this.opts.logger?.info({ approval: id, approve }, "approval decided in chat");
    }
    return decided;
  }

  approvalUrl(id: string): string {
    const base = (currentScope()?.baseUrl ?? this.opts.baseUrl).replace(/\/+$/, "");
    return `${base}/approvals?id=${encodeURIComponent(id)}`;
  }

  private ref(a: Approval): ApprovalRef {
    return {
      id: a.id,
      url: this.approvalUrl(a.id),
      expires_at: a.expires_at,
      estimate_usd: a.estimate_usd,
      reason: a.reason,
    };
  }

  private reservedTotal(scopeKey: string): number {
    let total = 0;
    for (const r of this.reservations) total += r.remaining(scopeKey);
    return roundUsd(total);
  }

  private capStatusWithReserved(
    cap: Cap,
    estimateUsd: number | null,
    parent?: SpendReservation,
  ): CapStatus {
    const status = capStatus(cap, this.opts.spend, this.now());
    const key = capScopeKey(cap);
    const totalReserved = this.reservedTotal(key);
    const covered =
      estimateUsd !== null && estimateUsd > 0 && parent
        ? Math.min(estimateUsd, parent.remaining(key))
        : 0;
    const effectiveSpent = roundUsd(status.spent_usd + Math.max(0, totalReserved - covered));
    return {
      ...status,
      spent_usd: effectiveSpent,
      remaining_usd: Number.isFinite(effectiveSpent)
        ? Math.max(0, roundUsd(cap.limit_usd - effectiveSpent))
        : 0,
    };
  }

  private reserve(
    scopeKeys: readonly string[],
    amount: number | null,
    parent?: SpendReservation,
  ): Reservation | null {
    if (amount === null || amount <= 0) return null;
    const r = new Reservation(this.reservations);
    for (const key of scopeKeys) {
      parent?.carve(key, amount);
      r.add(key, amount);
    }
    return r;
  }

  // -------------------------------------------------------------------------
  // Provider runs (capability router)

  /**
   * Check one provider run. True: run it. False: skip it (only when `more`).
   * Throws PolicyError when it must not run and no other provider may.
   * `skipped` collects why earlier providers were skipped, for that error.
   */
  async beforeProvider(check: ProviderGateCheck, skipped: string[]): Promise<boolean> {
    return (await this.authorizeProvider(check, skipped, false)).allowed;
  }

  /**
   * Check one provider run, reserve its estimated cost across concurrent
   * calls while it runs, and release the reservation in `finally`.
   */
  async runProvider<T>(
    check: ProviderGateCheck,
    skipped: string[],
    run: () => Promise<T>,
  ): Promise<{ ran: true; value: T } | { ran: false }> {
    const auth = await this.authorizeProvider(check, skipped, true);
    if (!auth.allowed) return { ran: false };
    try {
      return { ran: true, value: await run() };
    } finally {
      auth.reservation?.release();
    }
  }

  /**
   * Cached capability hits cost $0, so caps and auto-approve thresholds do not
   * apply, but `always_ask_providers` still requires human approval.
   */
  async beforeCachedProvider(check: {
    capability: CapabilityName;
    provider: string;
    input: unknown;
    signal?: AbortSignal;
  }): Promise<void> {
    const state = this.policy();
    const profile = this.profile();
    const rules = rulesFor(state.policy, profile);
    if (!rules.always_ask_providers.includes(check.provider)) return;
    await this.ask(state, {
      kind: "provider",
      tool: check.capability,
      provider: check.provider,
      args: check.input,
      estimateUsd: 0,
      estimateBasis: "cached result (no charge)",
      reason: `provider ${check.provider} always needs approval`,
      profile,
      ...(check.signal ? { signal: check.signal } : {}),
    });
  }

  private async authorizeProvider(
    check: ProviderGateCheck,
    skipped: string[],
    withReservation: boolean,
  ): Promise<{ allowed: boolean; reservation: Reservation | null }> {
    const state = this.policy();
    const profile = this.profile();
    const rules = rulesFor(state.policy, profile);
    const estimate = await this.estimate(check);
    const usd = estimate?.usd ?? null;
    const skip = (reason: string): { allowed: false; reservation: null } => {
      skipped.push(`${check.provider}: ${reason}`);
      if (check.more) return { allowed: false, reservation: null };
      throw new PolicyError(
        `${check.capability} not run: ${skipped.join("; ")}`.slice(0, 1000),
        "SPEND_BLOCKED",
      );
    };

    if (check.maxCostUsd !== undefined) {
      if (usd === null) return skip("cost unknown (no estimate) and max_cost_usd is set");
      if (usd > check.maxCostUsd) {
        return skip(`estimated ${money(usd)} is over max_cost_usd ${money(check.maxCostUsd)}`);
      }
    }
    if (!state.ok && usd !== 0) {
      return skip(
        "policy.json is invalid, so calls that may cost money are refused until it is fixed",
      );
    }
    const runCtx = currentPolicyRun();
    const preApproved = runCtx.preApproved === true;
    const alwaysAsk = rules.always_ask_providers.includes(check.provider);
    if (usd === 0 && !alwaysAsk) return { allowed: true, reservation: null };

    const parent = runCtx.reservation;
    const scopeKeys = ["global", `provider:${check.provider}`, `profile:${profile}`];

    const checkCaps = (blockOnly: boolean): { skipReason?: string; askReason?: string } => {
      let askReason: string | undefined;
      for (const cap of capsFor(state.policy, { provider: check.provider, profile })) {
        if (blockOnly && cap.mode !== "block") continue;
        const status = this.capStatusWithReserved(cap, usd, parent);
        // An unknown cost may go over any cap, so it never runs unchecked
        // under one: a priced provider is preferred, an "ask" cap asks and a
        // "block" cap refuses (it is a hard ceiling that cannot be kept).
        const unknown = usd === null && !overCap(status, null);
        if (!unknown && !overCap(status, usd)) continue;
        const spent = `spent ${money(status.spent_usd)}`;
        const why = unknown
          ? `cost unknown (no estimate) under ${describeCap(cap)} (${spent})`
          : `would go over ${describeCap(cap)} (${spent}, this call ${money(usd)})`;
        if (cap.mode === "block") return { skipReason: why };
        if (!preApproved) {
          // Another provider may fit; ask only when none is left.
          if (check.more) return { skipReason: why };
          askReason ??= why;
        }
      }
      return askReason ? { askReason } : {};
    };

    const first = checkCaps(false);
    if (first.skipReason !== undefined) return skip(first.skipReason);
    let askReason: string | null = first.askReason ?? null;

    if (alwaysAsk) askReason ??= `provider ${check.provider} always needs approval`;
    if (!preApproved) {
      const threshold = rules.auto_approve_under_usd;
      if (threshold !== null && (usd === null || usd >= threshold)) {
        askReason ??= `estimated ${money(usd)} is not under the auto-approve amount ${money(threshold)}`;
      }
    }
    if (askReason === null) {
      // Synchronous check-to-reserve: no await between checkCaps and reserve.
      const reservation = withReservation ? this.reserve(scopeKeys, usd, parent) : null;
      return { allowed: true, reservation };
    }
    await this.ask(state, {
      kind: "provider",
      tool: check.capability,
      provider: check.provider,
      args: check.input,
      estimateUsd: usd,
      estimateBasis: estimate?.basis ?? null,
      reason: askReason,
      profile,
      ...(check.signal ? { signal: check.signal } : {}),
    });
    const recheck = checkCaps(true);
    if (recheck.skipReason !== undefined) return skip(recheck.skipReason);
    const reservation = withReservation ? this.reserve(scopeKeys, usd, parent) : null;
    return { allowed: true, reservation };
  }

  private async estimate(check: ProviderGateCheck): Promise<CostEstimate | null> {
    if (!check.estimate) return null;
    let timer: NodeJS.Timeout | undefined;
    try {
      const out = await Promise.race([
        Promise.resolve().then(() => check.estimate?.()),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ESTIMATE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
      if (!out || typeof out.usd !== "number" || !Number.isFinite(out.usd) || out.usd < 0) {
        return null;
      }
      return { usd: out.usd, basis: typeof out.basis === "string" ? out.basis.slice(0, 80) : "" };
    } catch {
      // An estimate that fails is an unknown cost.
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Tool calls (registry)

  /** Run a tool through the policy: maybe refuse, maybe ask first. */
  /** Refuse a sending call over the profile's max_sends_per_hour; `count` records this one. */
  private checkSendCeiling(tool: string, profile: string, limit: number, count: boolean): void {
    const now = this.now();
    const recent = (this.sendTimes.get(profile) ?? []).filter((t) => now - t < SEND_WINDOW_MS);
    if (recent.length >= limit) {
      this.sendTimes.set(profile, recent);
      throw new PolicyError(
        `${tool} not run: this profile already made ${recent.length} sending calls in the last hour (max_sends_per_hour is ${limit})`,
        "SPEND_BLOCKED",
      );
    }
    if (count) recent.push(now);
    this.sendTimes.set(profile, recent);
  }

  async runTool<T>(
    tool: GatedTool,
    args: unknown,
    signal: AbortSignal | undefined,
    body: () => Promise<T>,
  ): Promise<T> {
    let run = body;
    const paid = tool.tags?.includes(PAID_TAG) === true;
    const sends = tool.tags?.includes(SENDS_TAG) === true;
    const destructive = sends || tool.annotations?.destructiveHint === true;
    const state = this.policy();
    const profile = this.profile();
    const rules = rulesFor(state.policy, profile);
    const tagged = tool.tags?.includes(APPROVAL_TAG) === true;
    const alwaysAsk = tagged || rules.always_ask_tools.includes(tool.name);
    if (!paid && !destructive && !alwaysAsk) return run();
    if (!state.ok && (paid || destructive)) {
      throw new PolicyError(
        `${tool.name} not run: policy.json is invalid, so paid and destructive tools are refused until it is fixed or deleted`,
        "SPEND_BLOCKED",
      );
    }
    if (sends && rules.max_sends_per_hour !== null) {
      // Checked before asking (no request for a call that cannot run) and
      // again, with the call counted, right before it runs.
      const limit = rules.max_sends_per_hour;
      this.checkSendCeiling(tool.name, profile, limit, false);
      run = () => {
        this.checkSendCeiling(tool.name, profile, limit, true);
        return body();
      };
    }
    const runCtx = currentPolicyRun();
    const preApproved = runCtx.preApproved === true;
    // Explicit always-ask tools, sending tools and destructive tools still ask
    // inside an approved run: a prior approval covered cost, not those actions.
    const asksToSend = sends && rules.ask_before_sending;
    const asksDestructive = destructive && rules.ask_before_destructive;
    if (preApproved && !paid && !alwaysAsk && !asksToSend && !asksDestructive) return run();

    const provider = this.opts.vendorOf?.(tool.name) ?? tool.packId;
    const checkBlockCaps = () => {
      for (const cap of capsFor(state.policy, { provider, profile })) {
        if (cap.mode !== "block") continue;
        const status = this.capStatusWithReserved(cap, null, runCtx.reservation);
        if (!overCap(status, null)) continue;
        const what = `${describeCap(cap)} is used up (spent ${money(status.spent_usd)})`;
        throw new PolicyError(`${tool.name} not run: ${what}`, "SPEND_BLOCKED");
      }
    };

    let askReason: string | null = null;
    if (paid) {
      checkBlockCaps();
      if (!preApproved) {
        for (const cap of capsFor(state.policy, { provider, profile })) {
          if (cap.mode === "block") continue;
          const status = this.capStatusWithReserved(cap, null, runCtx.reservation);
          if (!overCap(status, null)) continue;
          askReason ??= `${describeCap(cap)} is used up (spent ${money(status.spent_usd)})`;
        }
        if (rules.auto_approve_under_usd !== null) {
          askReason ??= `${tool.name} costs an unknown amount and auto-approve is set to under ${money(rules.auto_approve_under_usd)}`;
        }
      }
    }
    if (tagged) askReason ??= `${tool.name} always needs approval before it runs`;
    else if (alwaysAsk) askReason ??= `${tool.name} always needs approval`;
    else if (asksToSend) {
      askReason ??= `${tool.name} reaches other people (sends, posts or books) and the policy asks before sending`;
    } else if (asksDestructive) {
      askReason ??= `${tool.name} is destructive and the policy asks before destructive tools`;
    }
    if (askReason === null) return run();
    await this.ask(state, {
      kind: "tool",
      tool: tool.name,
      provider: null,
      args,
      estimateUsd: null,
      estimateBasis: null,
      reason: askReason,
      profile,
      ...(signal ? { signal } : {}),
    });
    if (paid) checkBlockCaps();
    return paid ? runPreApproved(run) : run();
  }

  // -------------------------------------------------------------------------
  // Workflow runs

  /**
   * A workflow run whose estimated cost does not fit what is left under an
   * "ask" cap (or the auto-approve amount) needs one approval for the whole
   * run; inside it, nested cost calls do not ask again. Blocking caps refuse it.
   */
  async runWorkflow<T>(
    workflow: { name: string; args: unknown; maxUsd: number | null },
    signal: AbortSignal | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    // A workflow called from inside an approved run is checked on its own:
    // that approval covered the outer run's plan, which counts a nested
    // workflow as free, so it never covers the nested run's cost.
    if (currentPolicyRun().preApproved === true) {
      return runNotPreApproved(() => this.runWorkflow(workflow, signal, run));
    }
    if (workflow.maxUsd === 0) return run();
    const state = this.policy();
    if (!state.ok) {
      throw new PolicyError(
        `${workflow.name} not run: policy.json is invalid, so workflows that may cost money are refused until it is fixed or deleted`,
        "SPEND_BLOCKED",
      );
    }
    const profile = this.profile();
    const rules = rulesFor(state.policy, profile);
    const runCtx = currentPolicyRun();
    const preApproved = runCtx.preApproved === true;
    const parent = runCtx.reservation;
    const scopeKeys = ["global", `profile:${profile}`];

    const checkCaps = (blockOnly: boolean): string | null => {
      let askReason: string | null = null;
      for (const cap of capsFor(state.policy, { profile })) {
        if (blockOnly && cap.mode !== "block") continue;
        const status = this.capStatusWithReserved(cap, workflow.maxUsd, parent);
        if (!overCap(status, workflow.maxUsd)) continue;
        const what = `the run (up to ${money(workflow.maxUsd)}) would go over ${describeCap(cap)} (spent ${money(status.spent_usd)})`;
        if (cap.mode === "block") {
          throw new PolicyError(`${workflow.name} not run: ${what}`, "SPEND_BLOCKED");
        }
        if (!preApproved) askReason ??= what;
      }
      return askReason;
    };

    let askReason = checkCaps(false);
    if (!preApproved) {
      const threshold = rules.auto_approve_under_usd;
      if (threshold !== null && (workflow.maxUsd === null || workflow.maxUsd >= threshold)) {
        askReason ??= `the run may cost up to ${money(workflow.maxUsd)}, not under the auto-approve amount ${money(threshold)}`;
      }
    }
    if (askReason === null) {
      const reservation = this.reserve(scopeKeys, workflow.maxUsd, parent);
      try {
        return reservation ? await runWithReservation(reservation, run) : await run();
      } finally {
        reservation?.release();
      }
    }
    await this.ask(state, {
      kind: "workflow",
      tool: workflow.name,
      provider: null,
      args: workflow.args,
      estimateUsd: workflow.maxUsd,
      estimateBasis: "workflow plan",
      reason: askReason,
      profile,
      ...(signal ? { signal } : {}),
    });
    checkCaps(true);
    const reservation = this.reserve(scopeKeys, workflow.maxUsd, parent);
    try {
      return reservation
        ? await runWithReservation(reservation, () => runPreApproved(run))
        : await runPreApproved(run);
    } finally {
      reservation?.release();
    }
  }

  /**
   * A non-blocking ask for a tool that answers "approval required" itself
   * (software installs). An approved request for exactly this call is used
   * up and gives "approved"; a denied or expired one is reported once;
   * otherwise a pending request is opened (or the open one reused) in the
   * approvals queue, where the dashboard and Telegram can decide it.
   */
  requestApproval(req: {
    tool: string;
    args: unknown;
    reason: string;
    estimateUsd?: number | null;
  }): { status: "approved" } | { status: "pending" | "denied" | "expired"; approval: ApprovalRef } {
    const store = this.opts.approvals;
    const state = this.policy();
    const profile = this.profile();
    const base = {
      kind: "tool" as const,
      tool: req.tool,
      provider: null,
      args: req.args,
      estimateUsd: req.estimateUsd ?? null,
      estimateBasis: null,
      reason: req.reason,
      profile,
    };
    const fingerprint = callFingerprint(base);
    let open = store.lookup(fingerprint);
    if (open?.status === "approved") {
      if (estimateFitsApproval(base.estimateUsd, open.estimate_usd) && store.consume(open.id)) {
        this.opts.logger?.info({ approval: open.id, tool: req.tool }, "approval used");
        return { status: "approved" };
      }
      open = store.lookup(fingerprint);
    }
    if (open && (open.status === "denied" || open.status === "expired")) {
      store.markReported(open.id);
      return { status: open.status, approval: this.ref(open) };
    }
    const pending =
      open?.status === "pending"
        ? open
        : store.request({ ...base, fingerprint, jobId: null }, this.ttlMs(state));
    return { status: "pending", approval: this.ref(pending) };
  }

  // -------------------------------------------------------------------------
  // Asking

  /** Resolves once an approval for exactly this call is consumed; throws otherwise. */
  private async ask(
    state: PolicyState,
    req: {
      kind: ApprovalKind;
      tool: string;
      provider: string | null;
      args: unknown;
      estimateUsd: number | null;
      estimateBasis: string | null;
      reason: string;
      profile: string;
      signal?: AbortSignal;
    },
  ): Promise<void> {
    const store = this.opts.approvals;
    const fingerprint = callFingerprint(req);
    const job = currentPolicyRun().job;
    let open = store.lookup(fingerprint);
    if (open?.status === "approved") {
      if (estimateFitsApproval(req.estimateUsd, open.estimate_usd) && store.consume(open.id)) {
        this.opts.logger?.info({ approval: open.id, tool: req.tool }, "approval used");
        return;
      }
      open = store.lookup(fingerprint);
    }
    if (open && (open.status === "denied" || open.status === "expired")) {
      store.markReported(open.id);
      throw this.decided(open);
    }
    const pending =
      open?.status === "pending"
        ? open
        : store.request(
            {
              kind: req.kind,
              tool: req.tool,
              provider: req.provider,
              args: req.args,
              estimateUsd: req.estimateUsd,
              estimateBasis: req.estimateBasis,
              reason: req.reason,
              profile: req.profile,
              fingerprint,
              jobId: job?.id ?? null,
            },
            this.ttlMs(state),
          );
    const ref = this.ref(pending);
    if (!job) {
      throw new PolicyError(
        `Approval required: ${req.reason}. A person can approve or deny it at ${ref.url} (until ${pending.expires_at}); then call again with the same arguments.`,
        "APPROVAL_REQUIRED",
        ref,
      );
    }
    this.opts.logger?.info({ approval: pending.id, job: job.id }, "job awaiting approval");
    let decided: Approval;
    job.awaiting(true, `awaiting approval: ${ref.url}`);
    try {
      decided = await store.waitForDecision(pending.id, req.signal);
    } finally {
      job.awaiting(false, null);
    }
    if (decided.status === "approved" && store.consume(decided.id)) return;
    const final = store.get(decided.id) ?? decided;
    store.markReported(final.id);
    throw this.decided(final);
  }

  private decided(a: Approval): PolicyError {
    if (a.status === "denied") {
      return new PolicyError(
        `Not run: the approval request ${a.id} was denied.`,
        "APPROVAL_DENIED",
        this.ref(a),
      );
    }
    return new PolicyError(
      `Not run: the approval request ${a.id} expired before it was ${a.status === "expired" && a.decided_at ? "used" : "decided"}.`,
      "APPROVAL_EXPIRED",
      this.ref(a),
    );
  }
}
