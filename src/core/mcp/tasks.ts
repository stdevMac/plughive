// src/core/mcp/tasks.ts
//
// Long-running tools as background jobs. The installed MCP SDK (2.4.0) ships
// no task engine, so this is a small one over the daemon's JobQueue. The same
// job is visible four ways:
//   - MCP Tasks (io.modelcontextprotocol/tasks): taskId === job id
//   - wait_for_job / cancel_job (core tools)
//   - get_job_status (existing tool)
// Everything a client is told about a job is read from its database row, so
// the answer is the same before and after a daemon restart.
import type { Job, JobStatus } from "../../types.js";
import { runInPolicyJob } from "../policy/run-context.js";
import type { ToolRegistry } from "../tools/registry.js";
import { type RequestScope, requestScope } from "./scope.js";

export const TASKS_EXTENSION = "io.modelcontextprotocol/tasks";
/** JobQueue handler name for a generic tool call. */
export const TOOL_CALL_JOB = "core.tool_call";
/**
 * `_meta` key of a `tools/call` request that makes a long-running call safe
 * to send twice (a client that timed out and re-sends does not start, and pay
 * for, a second job). The tasks extension (ext-tasks schema 2026-07-28)
 * defines no idempotency field, so this is the daemon's own key, under its
 * own prefix as the `_meta` naming rules ask. The value is a string of 1 to
 * 128 printable ASCII characters without spaces.
 *
 * Same key, same tool, same arguments, same profile: the existing task is
 * returned for as long as its job is kept (unfinished, or finished within the
 * retention period, `ttlMs`), whatever its status. Same key with another tool
 * or other arguments: the error IDEMPOTENCY_KEY_REUSED and nothing runs. Keys
 * of different profiles never meet. Calls that run inline ignore the key.
 */
export const IDEMPOTENCY_META_KEY = "plughive/idempotency-key";
export const TASK_POLL_INTERVAL_MS = 1000;
/** `ttlMs` reported when the queue does not say how long it keeps jobs (7 days). */
export const DEFAULT_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const TERMINAL: ReadonlySet<JobStatus> = new Set([
  "succeeded",
  "failed",
  "cancelled",
  "expired",
  "submission_unknown",
]);

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL.has(status);
}

interface JobExecutionLike {
  id: string;
  getCheckpoint(): Record<string, unknown>;
  mergeCheckpoint(patch: Record<string, unknown>): Record<string, unknown>;
  setProgress(progress: number | null): void;
  /** Shows a phase such as "awaiting_approval" (queues that have phases). */
  setPhase?(status: JobStatus): void;
  signal?: AbortSignal;
}

/** A job with the profile that started it (null: unknown or pre-profile job). */
export type TaskJob = Job & { profile?: string | null };

/** The part of JobQueue the engine needs. */
export interface JobsLike {
  register(
    tool: string,
    handler: (input: Record<string, unknown>, execution: JobExecutionLike) => Promise<unknown>,
  ): void;
  /**
   * May throw JobLimitError (queue full, arguments too large) or
   * JobIdempotencyError (key malformed, or used before for a different call).
   */
  enqueue(
    tool: string,
    input: Record<string, unknown>,
    opts?: { profile?: string; idempotencyKey?: string },
  ): string;
  get(id: string): TaskJob | null;
  cancel(id: string): boolean;
  /** How long finished jobs are kept. */
  readonly retentionMs?: number;
}

export interface TaskEngineOptions {
  /**
   * The scope a background tool call runs in, for the profile that started
   * it: the same restrictions as the request that enqueued it.
   */
  scopeFor?: (profileId: string | undefined) => RequestScope;
}

export interface TaskEngine {
  /**
   * Start `tool` with already validated arguments. Returns the job id: with
   * `idempotencyKey`, the id of the job the same call already started, if
   * any. Throws JobLimitError or JobIdempotencyError.
   */
  start(
    tool: string,
    args: Record<string, unknown>,
    opts?: { profile?: string; idempotencyKey?: string },
  ): string;
  get(id: string): TaskJob | null;
  /** False when the job is unknown or already finished. */
  cancel(id: string): boolean;
  /** Resolve when the job is terminal, the timeout passes or `signal` aborts. Null: unknown job. */
  wait(
    id: string,
    timeoutMs: number,
    signal?: AbortSignal,
    onTick?: (job: Job) => void,
  ): Promise<TaskJob | null>;
  /** How long a finished task stays readable. */
  readonly ttlMs: number;
}

const clamp01 = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);

export function createTaskEngine(
  jobs: JobsLike,
  registry: ToolRegistry,
  opts: TaskEngineOptions = {},
): TaskEngine {
  jobs.register(TOOL_CALL_JOB, async (input, execution) => {
    // A tool call may have side effects (or cost money), so it is never run
    // twice. The queue already fails interrupted jobs; this is the same rule
    // for queues that do not.
    if (execution.getCheckpoint().started === true) {
      throw new Error("interrupted by restart; not retried automatically");
    }
    execution.mergeCheckpoint({ started: true });
    const tool = String(input.tool);
    const profile = typeof input.profile === "string" ? input.profile : undefined;
    const scope: RequestScope = opts.scopeFor
      ? opts.scopeFor(profile)
      : { ...(profile !== undefined ? { profileId: profile } : {}) };
    // The spend policy waits for a person's approval inside a job (instead of
    // failing the call) and shows the job as awaiting approval meanwhile.
    const policyJob = {
      id: execution.id,
      awaiting: (waiting: boolean, message: string | null) => {
        try {
          if (execution.signal?.aborted) return;
          execution.setPhase?.(waiting ? "awaiting_approval" : "running");
          execution.mergeCheckpoint({ progress_message: message });
        } catch {
          // best effort, like progress
        }
      },
    };
    const envelope = await requestScope.run(scope, () => {
      // Re-checked when the job runs, not when it was enqueued: a profile
      // edited meanwhile no longer reaches the tool. A tool that is gone
      // entirely falls through to the UNKNOWN_TOOL answer below.
      if (scope.allows && !scope.allows(tool) && registry.get(tool)) {
        const message = `the tool ${tool} is not available in this profile`;
        try {
          execution.mergeCheckpoint({ tool_error: { code: "TOOL_ERROR", message } });
        } catch {
          // the job row is the source of truth; its error column still gets the message
        }
        throw new Error(message);
      }
      return runInPolicyJob(policyJob, () =>
        registry.call(tool, input.args ?? {}, {
          ...(execution.signal ? { signal: execution.signal } : {}),
          progress: (fraction, message) => {
            try {
              execution.setProgress(clamp01(fraction));
              if (message !== undefined) {
                execution.mergeCheckpoint({ progress_message: String(message).slice(0, 200) });
              }
            } catch {
              // progress is best effort
            }
          },
        }),
      );
    });
    if (envelope.ok) return envelope.result ?? null;
    // The pack can be disabled or reloaded between enqueue and run.
    const message =
      envelope.error.code === "UNKNOWN_TOOL"
        ? "the tool is no longer available (its pack was disabled or unloaded before the job ran)"
        : envelope.error.message;
    // Kept in the job row (already redacted by the registry), so the failure
    // reads the same after a restart.
    try {
      execution.mergeCheckpoint({ tool_error: { code: envelope.error.code, message } });
    } catch {
      // the job row is the source of truth; its error column still gets the message
    }
    throw new Error(message);
  });

  return {
    ttlMs: jobs.retentionMs ?? DEFAULT_TASK_TTL_MS,
    start: (tool, args, startOpts = {}) =>
      jobs.enqueue(
        TOOL_CALL_JOB,
        { tool, args, ...(startOpts.profile !== undefined ? { profile: startOpts.profile } : {}) },
        {
          ...(startOpts.profile !== undefined ? { profile: startOpts.profile } : {}),
          ...(startOpts.idempotencyKey !== undefined
            ? { idempotencyKey: startOpts.idempotencyKey }
            : {}),
        },
      ),
    get: (id) => jobs.get(id),
    cancel: (id) => jobs.cancel(id),
    async wait(id, timeoutMs, signal, onTick) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const job = jobs.get(id);
        if (!job) return null;
        onTick?.(job);
        if (isTerminal(job.status) || signal?.aborted || Date.now() >= deadline) return job;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(1, Math.min(200, deadline - Date.now()))),
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Job -> wire shapes
// ---------------------------------------------------------------------------

export type TaskStatus = "working" | "input_required" | "completed" | "cancelled" | "failed";

/** The Task object of the 2026-07-28 tasks extension (flat fields, no result). */
export interface TaskState {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number;
  pollIntervalMs: number;
}

/** The tool's own error code of a failed tool-call job, when it left one. */
export function jobErrorCode(job: Job): string {
  const stored = job.checkpoint.tool_error;
  if (stored !== null && typeof stored === "object") {
    const code = (stored as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z_]{1,40}$/.test(code)) return code;
  }
  return "JOB_FAILED";
}

/**
 * Task state of a job, from the job row alone. `completed` only for a tool
 * that returned a result; a tool that threw, a tool that is gone, an
 * interrupted or expired job are all `failed` with a statusMessage.
 */
export function taskState(job: Job, ttlMs: number = DEFAULT_TASK_TTL_MS): TaskState {
  let status: TaskStatus = "working";
  if (job.status === "succeeded") status = "completed";
  else if (job.status === "cancelled") status = "cancelled";
  else if (isTerminal(job.status)) status = "failed";
  const message = job.checkpoint.progress_message;
  const statusMessage =
    status === "working"
      ? [
          job.progress != null ? `${Math.round(job.progress * 100)}%` : null,
          typeof message === "string" ? message : null,
        ]
          .filter((part) => part !== null)
          .join(" ")
      : status === "failed"
        ? (job.error ?? job.status)
        : "";
  return {
    taskId: job.id,
    status,
    ...(statusMessage ? { statusMessage } : {}),
    createdAt: job.createdAt,
    lastUpdatedAt: job.updatedAt,
    ttlMs,
    pollIntervalMs: TASK_POLL_INTERVAL_MS,
  };
}
