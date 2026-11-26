// src/core/triggers/service.ts
//
// Runs triggers: the cron scheduler, firing a workflow as a background job,
// and the job-done callbacks.
//
// Cron semantics (see docs/triggers.md):
//   - Each cron trigger stores the time of its next slot (next_run_at). A tick
//     claims a due slot with a conditional UPDATE that moves next_run_at to the
//     following slot; only the claimer fires. The claim is written before the
//     job is started, so a restart never fires the same slot twice (a crash
//     between the claim and the start loses that one run: at most once).
//   - A slot more than MISSED_AFTER_MS late (the daemon was stopped or asleep)
//     is a missed run. Missed runs are skipped; with catch_up on, the trigger
//     runs once for the most recent missed slot, never once per missed slot.
//
// Callbacks: a run whose trigger has a callback is tracked until its job ends,
// then the callback is claimed (pending -> sending) and sent once. A callback
// interrupted by a restart is marked failed, not resent.
import { createHmac } from "node:crypto";
import { type RequestScope, requestScope } from "../mcp/scope.js";
import type { TaskEngine, TaskJob } from "../mcp/tasks.js";
import { isTerminal } from "../mcp/tasks.js";
import type { ToolEnvelope, ToolRegistry } from "../tools/registry.js";
import { WORKFLOW_TOOL_PREFIX } from "../workflows/index.js";
import { type CronZone, nextRun, parseCron } from "./cron.js";
import type { Trigger, TriggerRun, TriggerStore } from "./store.js";

/** A slot later than this is a missed run, not a late tick. */
export const MISSED_AFTER_MS = 2 * 60_000;
export const DEFAULT_TICK_MS = 15_000;
export const CALLBACK_TIMEOUT_MS = 15_000;
/** Jobs one trigger may have queued or running at once; a further fire is refused. */
export const MAX_ACTIVE_RUNS_PER_TRIGGER = 5;
/** Callbacks sent at once, so one slow receiver does not hold back the others. */
export const MAX_CALLBACKS_AT_ONCE = 4;
/** Most bytes of a job result put into a webhook callback body. */
export const MAX_CALLBACK_RESULT_BYTES = 64 * 1024;
export const TELEGRAM_TOOL = "send_telegram";
export const SIGNATURE_HEADER = "x-plughive-signature";
export const TIMESTAMP_HEADER = "x-plughive-timestamp";

export interface TriggerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}

export interface TriggerServiceDeps {
  store: TriggerStore;
  registry: ToolRegistry;
  tasks: TaskEngine;
  logger: TriggerLogger;
  /** The scope a callback tool call (Telegram) runs in. */
  scopeFor?: (profileId: string | undefined) => RequestScope;
  /** fetch for webhook callbacks: the SSRF-guarded one in the daemon. */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  now?: () => number;
  tickMs?: number;
}

export type FireSource = TriggerRun["source"];

export class TriggerFireError extends Error {
  constructor(
    readonly code: "UNKNOWN_WORKFLOW" | "INVALID_INPUT" | "START_FAILED" | "BUSY",
    message: string,
  ) {
    super(message);
    this.name = "TriggerFireError";
  }
}

/** sha256=<hex> of `${timestamp}.${body}`: the signature on webhooks in both directions. */
export function sign(secret: string, timestamp: string, body: Buffer | string): string {
  const mac = createHmac("sha256", secret);
  mac.update(`${timestamp}.`);
  mac.update(body);
  return `sha256=${mac.digest("hex")}`;
}

export function isWorkflowTool(name: string): boolean {
  return name.startsWith(WORKFLOW_TOOL_PREFIX);
}

/** The next slot of a cron trigger after `after`, as epoch ms (null: never). */
export function nextSlot(schedule: string, zone: CronZone, after: number): number | null {
  const next = nextRun(parseCron(schedule), new Date(after), zone);
  return next ? next.getTime() : null;
}

const short = (text: string, max = 500) => (text.length > max ? `${text.slice(0, max)}…` : text);

export class TriggerService {
  private timer: NodeJS.Timeout | null = null;
  private callbacking = false;
  private readonly now: () => number;
  private readonly sending = new Set<Promise<void>>();
  /** Jobs each trigger started that may not have finished yet. */
  private readonly active = new Map<string, Set<string>>();

  constructor(private readonly deps: TriggerServiceDeps) {
    this.now = deps.now ?? Date.now;
  }

  get store(): TriggerStore {
    return this.deps.store;
  }

  get registry(): ToolRegistry {
    return this.deps.registry;
  }

  start(): void {
    if (this.timer) return;
    this.deps.store.failInterruptedCallbacks();
    const every = this.deps.tickMs ?? DEFAULT_TICK_MS;
    this.timer = setInterval(() => void this.tick(), every);
    this.timer.unref();
    void this.tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.allSettled([...this.sending]);
  }

  /**
   * One scheduler pass: due cron slots, then finished jobs' callbacks. The
   * cron pass is synchronous and runs on every tick; only the callback pass is
   * single-flight, so a slow callback endpoint never holds back cron slots
   * long enough for them to be skipped as missed.
   */
  async tick(): Promise<void> {
    try {
      this.runDue();
      this.deps.store.pruneReplay(this.now() - 24 * 60 * 60_000);
    } catch (e) {
      this.warnTick(e);
    }
    if (this.callbacking) return;
    this.callbacking = true;
    try {
      await this.sendCallbacks();
    } catch (e) {
      this.warnTick(e);
    } finally {
      this.callbacking = false;
    }
  }

  private warnTick(e: unknown): void {
    this.deps.logger.warn({ err: e instanceof Error ? e.name : typeof e }, "trigger tick failed");
  }

  /** Fire every due cron slot. Returns the ids of the triggers that fired. */
  runDue(): string[] {
    const now = this.now();
    const fired: string[] = [];
    for (const t of this.deps.store.dueCron(now)) {
      if (!t.schedule) continue;
      let next: number | null;
      try {
        next = nextSlot(t.schedule, t.timezone, now);
      } catch {
        next = null;
      }
      if (t.nextRunAt === null) {
        // First sight (new, re-enabled or migrated): schedule only, fire nothing.
        this.deps.store.claimSlot(t.id, null, next);
        continue;
      }
      if (!this.deps.store.claimSlot(t.id, t.nextRunAt, next)) continue; // someone else has it
      const missed = now - t.nextRunAt > MISSED_AFTER_MS;
      if (missed && !t.catchUp) {
        this.deps.logger.info({ trigger: t.id }, "trigger skipped missed runs");
        this.deps.store.recordRun(t.id, {
          jobId: null,
          source: "cron",
          status: "skipped",
          error: "missed while the daemon was not running",
          callback: false,
        });
        continue;
      }
      // On time, or catching up: once, for the most recent missed slot.
      try {
        this.fire(t, "cron");
        fired.push(t.id);
      } catch {
        // recorded on the trigger by fire()
      }
    }
    return fired;
  }

  /**
   * Start the trigger's workflow as a background job. Records the run (and
   * the error, if the job could not be started). Throws TriggerFireError.
   */
  fire(t: Trigger, source: FireSource, extraArgs?: Record<string, unknown>): TriggerRun {
    try {
      const jobId = this.startJob(t, extraArgs);
      this.deps.logger.info({ trigger: t.id, job: jobId, source }, "trigger fired");
      return this.deps.store.recordRun(t.id, {
        jobId,
        source,
        status: "started",
        error: null,
        callback: t.callback !== null,
      });
    } catch (e) {
      const err =
        e instanceof TriggerFireError
          ? e
          : new TriggerFireError("START_FAILED", e instanceof Error ? e.message : String(e));
      this.deps.logger.warn(
        { trigger: t.id, code: err.code },
        "trigger could not start its workflow",
      );
      this.deps.store.recordRun(t.id, {
        jobId: null,
        source,
        status: "error",
        error: short(err.message),
        callback: false,
      });
      throw err;
    }
  }

  private startJob(t: Trigger, extraArgs?: Record<string, unknown>): string {
    // Counted here, not from the stored runs: those are pruned, and refused
    // fires are recorded too.
    const started = this.active.get(t.id) ?? new Set<string>();
    for (const id of started) {
      const job = this.deps.tasks.get(id);
      if (!job || isTerminal(job.status)) started.delete(id);
    }
    if (started.size >= MAX_ACTIVE_RUNS_PER_TRIGGER) {
      throw new TriggerFireError(
        "BUSY",
        `this trigger already has ${started.size} runs that have not finished; wait for them or cancel them`,
      );
    }
    const tool = this.deps.registry.get(t.workflow);
    if (!tool || !isWorkflowTool(t.workflow)) {
      throw new TriggerFireError("UNKNOWN_WORKFLOW", `workflow ${t.workflow} is not loaded`);
    }
    // The saved args are what the owner pinned: a request body only fills in
    // the rest, and never asks for a dry run (which would answer 202 and run
    // nothing).
    const { dry_run: _dryRun, ...fromBody } = extraArgs ?? {};
    const parsed = tool.input.safeParse({ ...fromBody, ...t.args });
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new TriggerFireError(
        "INVALID_INPUT",
        `the workflow input is not valid${first ? `: ${first.path.join(".") || "(root)"} ${first.message}` : ""}`,
      );
    }
    const jobId = this.deps.tasks.start(t.workflow, parsed.data as Record<string, unknown>, {
      ...(t.profile ? { profile: t.profile } : {}),
    });
    started.add(jobId);
    this.active.set(t.id, started);
    return jobId;
  }

  /** Send the callbacks of runs whose job has finished. */
  async sendCallbacks(): Promise<void> {
    const inFlight = new Set<Promise<void>>();
    for (const run of this.deps.store.pendingCallbacks()) {
      const job = run.jobId ? this.deps.tasks.get(run.jobId) : null;
      if (job && !isTerminal(job.status)) continue;
      if (!this.deps.store.claimCallback(run.id)) continue;
      const trigger = this.deps.store.get(run.triggerId);
      const p = this.deliver(run, trigger, job).then(
        () => this.deps.store.finishCallback(run.id, true, null),
        (e: unknown) => {
          const message = short(e instanceof Error ? e.message : String(e), 300);
          this.deps.logger.warn({ trigger: run.triggerId, run: run.id }, "trigger callback failed");
          this.deps.store.finishCallback(run.id, false, message);
        },
      );
      this.sending.add(p);
      inFlight.add(p);
      void p.finally(() => {
        this.sending.delete(p);
        inFlight.delete(p);
      });
      if (inFlight.size >= MAX_CALLBACKS_AT_ONCE) await Promise.race(inFlight);
    }
    await Promise.all(inFlight);
  }

  private async deliver(run: TriggerRun, t: Trigger | null, job: TaskJob | null): Promise<void> {
    if (!t?.callback) throw new Error("the trigger or its callback was removed");
    if (!job) throw new Error("the job is no longer stored");
    const status = job.status;
    if (t.callback.type === "webhook") {
      const payload: Record<string, unknown> = {
        event: "job.finished",
        trigger_id: t.id,
        trigger_name: t.name,
        workflow: t.workflow,
        run_id: run.id,
        job_id: job.id,
        status,
        finished_at: job.updatedAt,
      };
      if (status === "succeeded") {
        const json = JSON.stringify(job.result ?? null);
        if (Buffer.byteLength(json) <= MAX_CALLBACK_RESULT_BYTES)
          payload.result = job.result ?? null;
        else payload.result_truncated = true;
      } else if (job.error) {
        payload.error = short(job.error);
      }
      const body = JSON.stringify(payload);
      const ts = String(Math.floor(this.now() / 1000));
      const secret = this.deps.store.secret(t.id) ?? "";
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), CALLBACK_TIMEOUT_MS);
      try {
        const res = await this.deps.fetch(t.callback.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "user-agent": "plughive-trigger",
            [TIMESTAMP_HEADER]: ts,
            [SIGNATURE_HEADER]: sign(secret, ts, body),
          },
          body,
          redirect: "manual",
          signal: ac.signal,
        });
        await res.body?.cancel().catch(() => undefined);
        if (res.status < 200 || res.status >= 300) {
          throw new Error(`the callback URL answered ${res.status}`);
        }
      } finally {
        clearTimeout(timer);
      }
      return;
    }
    // Telegram: through the telegram pack's tool, when it is loaded.
    if (!this.deps.registry.get(TELEGRAM_TOOL)) {
      throw new Error("the telegram pack is not loaded");
    }
    const text = [
      `${t.name}: ${t.workflow} ${status}`,
      `job ${job.id}`,
      ...(status !== "succeeded" && job.error ? [short(job.error, 300)] : []),
    ].join("\n");
    const args = { text, ...(t.callback.chat_id ? { chat_id: t.callback.chat_id } : {}) };
    const call = () => this.deps.registry.call(TELEGRAM_TOOL, args);
    const scope = this.deps.scopeFor?.(t.profile ?? undefined);
    const env: ToolEnvelope = scope ? await requestScope.run(scope, call) : await call();
    if (!env.ok) throw new Error(env.error.message);
  }
}
