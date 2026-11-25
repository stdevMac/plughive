// src/lib/jobs.ts
//
// SQLite-backed job queue. Bounded (queue length, argument size), pruned
// (finished jobs expire), private (0600 database file, secret-looking argument
// values are never written to disk) and restart-safe (a job is only claimed
// once its handler is registered; work interrupted by a restart is failed
// unless its handler declares itself resumable).
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import type Database from "better-sqlite3";
import { ulid } from "ulid";
import type { Job, JobStatus } from "../types.js";

export interface JobExecution {
  id: string;
  getCheckpoint(): Record<string, unknown>;
  mergeCheckpoint(patch: Record<string, unknown>): Record<string, unknown>;
  setPhase(status: JobStatus): void;
  setProgress(progress: number | null): void;
  /** Aborted when the job is cancelled with JobQueue.cancel(). */
  signal?: AbortSignal;
}

export type JobHandler = (
  input: Record<string, unknown>,
  execution: JobExecution,
) => Promise<unknown>;

export class JobTerminalError extends Error {
  constructor(
    readonly status: Extract<JobStatus, "submission_unknown" | "cancelled" | "expired" | "failed">,
    message: string,
  ) {
    super(message);
    this.name = "JobTerminalError";
  }
}

/** Thrown by enqueue() when a limit is hit. The message is safe to show. */
export class JobLimitError extends Error {
  constructor(
    readonly code: "JOB_QUEUE_FULL" | "JOB_INPUT_TOO_LARGE",
    message: string,
  ) {
    super(message);
    this.name = "JobLimitError";
  }
}

/**
 * Thrown by enqueue() for an idempotency key that cannot be used: malformed,
 * or already used by this profile for a different call. The message is safe
 * to show.
 */
export class JobIdempotencyError extends Error {
  constructor(
    readonly code: "IDEMPOTENCY_KEY_INVALID" | "IDEMPOTENCY_KEY_REUSED",
    message: string,
  ) {
    super(message);
    this.name = "JobIdempotencyError";
  }
}

export const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
/** 1 to 128 printable ASCII characters, no spaces. */
export function isIdempotencyKey(value: unknown): value is string {
  return typeof value === "string" && /^[\x21-\x7e]{1,128}$/.test(value);
}

export const DEFAULT_MAX_QUEUED_JOBS = 200;
export const MAX_JOB_INPUT_BYTES = 1024 * 1024;
/** Largest serialized result kept per job in jobs.db (default 8 MB). */
export const MAX_JOB_RESULT_BYTES = 8 * 1024 * 1024;
export const JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_FINISHED_JOBS = 1000;
export const DEFAULT_HANDLER_GRACE_MS = 60_000;
export const INTERRUPTED_MESSAGE = "interrupted by restart; not retried automatically";
/** Stored instead of the value of an argument whose key looks secret. */
export const SECRET_ARG_PLACEHOLDER = "[not stored]";
// Whole-name match, the same names the tool-call log masks (redactArgs in
// core/tools/registry.ts): `api_key`, `token`, `client_secret` are secrets,
// `keywords`, `max_tokens` and `monkey` are not.
const SECRET_ARG_KEY =
  /^(authorization|cookie|set-cookie|passwd|password|passphrase|secret|.*credentials?|.*signature|sig|bearer|.*api[_-]?key|.*access[_-]?key|.*private[_-]?key|.*[_-]?token|token.*|.*[_-]?secret|.*password|x-.*-key|key)$/i;
const PRUNE_EVERY_MS = 10 * 60 * 1000;
const TERMINAL = "('succeeded','failed','cancelled','expired')";

export interface JobQueueOpts {
  db: Database.Database;
  concurrency: number;
  /** Jobs allowed to wait at once (default 200). */
  maxQueued?: number;
  /** Serialized argument size limit per job (default 1 MB). */
  maxInputBytes?: number;
  /** Serialized result size limit per job (default 8 MB). */
  maxResultBytes?: number;
  /** Finished jobs older than this are deleted (default 7 days). */
  retentionMs?: number;
  /** At most this many finished jobs are kept (default 1000). */
  maxFinished?: number;
  /** How long a queued job waits for its handler to be registered (default 60 s). */
  handlerGraceMs?: number;
}

export interface RegisterOptions {
  /**
   * The handler can pick up a job that a previous process left unfinished
   * (it checkpoints its own progress). Without it such a job fails.
   */
  resumable?: boolean;
}

export interface EnqueueOptions {
  /** Exposure profile the job was started from. */
  profile?: string;
  /**
   * A caller-chosen key (see isIdempotencyKey) that makes the call safe to
   * send twice. While a job of the same profile with this key is kept (it is
   * unfinished, or finished within the retention period), enqueue() returns
   * that job's id instead of queueing a second one, whatever its status: a
   * caller that wants a failed call run again uses a new key. The same key
   * with another tool or other arguments throws JobIdempotencyError.
   */
  idempotencyKey?: string;
}

/** A job row, with the profile that started it. */
export type StoredJob = Job & { profile: string | null };

interface Row {
  id: string;
  tool: string;
  status: string;
  input_json: string;
  result_json: string | null;
  error: string | null;
  progress: number | null;
  checkpoint_json: string;
  created_at: string;
  updated_at: string;
  profile: string | null;
  input_redacted: number;
  interrupted: number;
}

export class JobQueue {
  private db: Database.Database;
  private concurrency: number;
  private handlers = new Map<string, { run: JobHandler; resumable: boolean }>();
  private running = 0;
  private timer: NodeJS.Timeout | null = null;
  private aborts = new Map<string, AbortController>();
  /** Real arguments of jobs whose stored copy had secret-looking values removed. */
  private volatileInputs = new Map<string, Record<string, unknown>>();
  private readonly maxQueued: number;
  private readonly maxInputBytes: number;
  private readonly maxResultBytes: number;
  private readonly maxFinished: number;
  private readonly handlerGraceMs: number;
  private readonly openedAt = Date.now();
  private lastPrune = 0;
  /** Finished jobs are kept this long; also the `ttlMs` of a task. */
  readonly retentionMs: number;

  constructor(opts: JobQueueOpts) {
    this.db = opts.db;
    this.concurrency = opts.concurrency;
    this.maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED_JOBS;
    this.maxInputBytes = opts.maxInputBytes ?? MAX_JOB_INPUT_BYTES;
    this.maxResultBytes = opts.maxResultBytes ?? MAX_JOB_RESULT_BYTES;
    this.retentionMs = opts.retentionMs ?? JOB_RETENTION_MS;
    this.maxFinished = opts.maxFinished ?? MAX_FINISHED_JOBS;
    this.handlerGraceMs = opts.handlerGraceMs ?? DEFAULT_HANDLER_GRACE_MS;
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS jobs (
          id TEXT PRIMARY KEY, tool TEXT NOT NULL, status TEXT NOT NULL,
          input_json TEXT NOT NULL, result_json TEXT, error TEXT, progress REAL,
          checkpoint_json TEXT NOT NULL DEFAULT '{}',
          created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          profile TEXT, input_redacted INTEGER NOT NULL DEFAULT 0,
          interrupted INTEGER NOT NULL DEFAULT 0
        )`,
      )
      .run();
    this.db.prepare("CREATE INDEX IF NOT EXISTS jobs_status ON jobs(status)").run();
    this.migrateColumns();
    this.db
      .prepare(
        `CREATE UNIQUE INDEX IF NOT EXISTS jobs_idem ON jobs(COALESCE(profile,''), idem_key)
         WHERE idem_key IS NOT NULL`,
      )
      .run();
    this.protectFiles();
    this.recoverStaleJobs();
    this.prune();
    this.protectFiles();
  }

  register(tool: string, handler: JobHandler, opts: RegisterOptions = {}): void {
    this.handlers.set(tool, { run: handler, resumable: opts.resumable === true });
  }

  /**
   * Queue a job. Throws JobLimitError when the queue is full or the arguments
   * are too large. Values of arguments whose key looks secret stay in memory
   * only; the database holds a placeholder. With `opts.idempotencyKey` a
   * repeated call returns the job it already queued (JobIdempotencyError when
   * the key was used for a different call).
   */
  enqueue(tool: string, input: Record<string, unknown>, opts: EnqueueOptions = {}): string {
    const key = opts.idempotencyKey;
    if (key === undefined) return this.insertJob(tool, input, opts.profile, null);
    if (!isIdempotencyKey(key)) {
      throw new JobIdempotencyError(
        "IDEMPOTENCY_KEY_INVALID",
        `an idempotency key is 1 to ${MAX_IDEMPOTENCY_KEY_LENGTH} printable ASCII characters without spaces`,
      );
    }
    // One transaction: two identical calls cannot both miss the lookup.
    return this.db.transaction((): string => {
      const prior = this.db
        .prepare(
          `SELECT id, tool, idem_hash, status, updated_at FROM jobs
           WHERE idem_key = ? AND COALESCE(profile,'') = ?`,
        )
        .get(key, opts.profile ?? "") as
        | { id: string; tool: string; idem_hash: string | null; status: string; updated_at: string }
        | undefined;
      if (prior) {
        const finished = ["succeeded", "failed", "cancelled", "expired"].includes(prior.status);
        const cutoff = new Date(Date.now() - this.retentionMs).toISOString();
        if (finished && prior.updated_at < cutoff) {
          // Past retention and about to be pruned: the key is free again.
          this.db
            .prepare("UPDATE jobs SET idem_key = NULL, idem_hash = NULL WHERE id = ?")
            .run(prior.id);
        } else {
          const salt = (prior.idem_hash ?? "").split(":")[0] ?? "";
          if (prior.tool === tool && prior.idem_hash === callDigest(salt, tool, input))
            return prior.id;
          throw new JobIdempotencyError(
            "IDEMPOTENCY_KEY_REUSED",
            `this idempotency key was already used for a different call (job ${prior.id}); use a new key for a new call`,
          );
        }
      }
      return this.insertJob(tool, input, opts.profile, {
        key,
        hash: callDigest(randomBytes(16).toString("hex"), tool, input),
      });
    })();
  }

  private insertJob(
    tool: string,
    input: Record<string, unknown>,
    profile: string | undefined,
    idem: { key: string; hash: string } | null,
  ): string {
    const stored = scrubSecretArgs(input);
    const json = JSON.stringify(stored.value);
    if (json === undefined || Buffer.byteLength(json, "utf8") > this.maxInputBytes) {
      throw new JobLimitError(
        "JOB_INPUT_TOO_LARGE",
        `job arguments are larger than ${Math.floor(this.maxInputBytes / 1024)} kB; pass large inputs as artifacts or files`,
      );
    }
    const waiting = this.db
      .prepare("SELECT COUNT(*) AS n FROM jobs WHERE status = 'queued'")
      .get() as { n: number };
    if (waiting.n >= this.maxQueued) {
      throw new JobLimitError(
        "JOB_QUEUE_FULL",
        `too many jobs are waiting (${this.maxQueued}); wait for some to finish or cancel them`,
      );
    }
    const id = `job_${ulid()}`;
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO jobs(id,tool,status,input_json,checkpoint_json,created_at,updated_at,profile,input_redacted,idem_key,idem_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        tool,
        "queued",
        json,
        "{}",
        now,
        now,
        profile ?? null,
        stored.changed ? 1 : 0,
        idem?.key ?? null,
        idem?.hash ?? null,
      );
    if (stored.changed) this.volatileInputs.set(id, input);
    return id;
  }

  /** Newest first. `status` filters on the exact status. */
  list(opts: { status?: JobStatus; limit?: number; offset?: number } = {}): StoredJob[] {
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 50)), 200);
    const offset = Math.max(0, Math.floor(opts.offset ?? 0));
    const where = opts.status ? "WHERE status = ?" : "";
    const params: unknown[] = opts.status ? [opts.status] : [];
    const rows = this.db
      .prepare(`SELECT * FROM jobs ${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as Row[];
    return rows.map((r) => this.toJob(r));
  }

  /** How many jobs are in each status. */
  counts(): Record<string, number> {
    const rows = this.db
      .prepare("SELECT status, COUNT(*) AS n FROM jobs GROUP BY status")
      .all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.status, r.n]));
  }

  get(id: string): StoredJob | null {
    const r = this.db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as Row | undefined;
    if (!r) return null;
    return this.toJob(r);
  }

  private toJob(r: Row): StoredJob {
    return {
      id: r.id,
      tool: r.tool,
      status: r.status as JobStatus,
      input: parseObject(r.input_json),
      checkpoint: parseObject(r.checkpoint_json),
      result: r.result_json ? safeParse(r.result_json) : null,
      error: r.error,
      progress: r.progress,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      profile: r.profile ?? null,
    } as StoredJob;
  }

  startWorker(opts: { intervalMs?: number } = {}): void {
    if (this.timer) return;
    const interval = opts.intervalMs ?? 250;
    this.timer = setInterval(() => this.tick().catch(() => {}), interval);
  }

  stopWorker(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get isWorkerRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Cancel a job that has not reached a terminal status. A queued job never
   * starts; a running one has its `execution.signal` aborted and ends as
   * `cancelled` whatever its handler does. Returns false for unknown or
   * already finished jobs.
   */
  cancel(id: string): boolean {
    const result = this.db
      .prepare(
        `UPDATE jobs SET status = 'cancelled', error = 'cancelled', updated_at = ?
         WHERE id = ? AND status NOT IN ('succeeded','failed','cancelled','expired','submission_unknown')`,
      )
      .run(new Date().toISOString(), id);
    if (result.changes === 0) return false;
    this.aborts.get(id)?.abort();
    if (!this.aborts.has(id)) this.volatileInputs.delete(id);
    return true;
  }

  setPhase(id: string, status: JobStatus): void {
    this.updateExisting(id, "status = ?, updated_at = ?", [status, new Date().toISOString()]);
  }

  setProgress(id: string, progress: number | null): void {
    this.updateExisting(id, "progress = ?, updated_at = ?", [progress, new Date().toISOString()]);
  }

  mergeCheckpoint(id: string, patch: Record<string, unknown>): Record<string, unknown> {
    // Read and write together, so two merges cannot drop each other's keys.
    return this.db.transaction(() => {
      const checkpoint = { ...this.requireJob(id).checkpoint, ...patch };
      this.replaceCheckpoint(id, checkpoint);
      return checkpoint;
    })();
  }

  /**
   * Attach an upstream job that was discovered after an ambiguous paid submission.
   * The conditional update prevents a stale caller from mutating a job that has left
   * the manual-reconciliation state.
   */
  attachUpstream(id: string, upstreamJobId: string, pollingUrl: string): Job {
    return this.reconcileSubmissionUnknown(id, (job, at) => ({
      status: "queued",
      error: null,
      checkpoint: {
        ...job.checkpoint,
        upstream_job_id: upstreamJobId,
        generation_id: upstreamJobId,
        polling_url: pollingUrl,
        audit: appendAudit(job.checkpoint, {
          action: "attach_upstream",
          at,
          upstream_job_id: upstreamJobId,
          polling_url: pollingUrl,
        }),
      },
    }));
  }

  /** Explicitly authorize a second paid submission after a human has reviewed it. */
  authorizeRetry(id: string): Job {
    return this.reconcileSubmissionUnknown(id, (job, at) => ({
      status: "queued",
      error: null,
      checkpoint: {
        ...clearSubmissionCheckpoint(job.checkpoint),
        audit: appendAudit(job.checkpoint, { action: "authorize_retry", at }),
      },
    }));
  }

  /** End an ambiguous job when no trustworthy upstream state can be attached. */
  abandon(id: string, reason: string): Job {
    return this.reconcileSubmissionUnknown(id, (job, at) => ({
      status: "failed",
      error: reason,
      checkpoint: {
        ...job.checkpoint,
        audit: appendAudit(job.checkpoint, { action: "abandon", at, reason }),
      },
    }));
  }

  /** Replaces a persisted checkpoint, and throws rather than silently accepting an unknown job. */
  replaceCheckpoint(id: string, checkpoint: Record<string, unknown>): void {
    this.updateExisting(id, "checkpoint_json = ?, updated_at = ?", [
      JSON.stringify(checkpoint),
      new Date().toISOString(),
    ]);
  }

  /**
   * Delete finished jobs older than the retention period and all but the
   * newest `maxFinished` finished jobs. Returns how many rows were removed.
   */
  prune(now: number = Date.now()): number {
    this.lastPrune = now;
    const cutoff = new Date(now - this.retentionMs).toISOString();
    const aged = this.db
      .prepare(`DELETE FROM jobs WHERE status IN ${TERMINAL} AND updated_at < ?`)
      .run(cutoff).changes;
    const excess = this.db
      .prepare(
        `DELETE FROM jobs WHERE id IN (
           SELECT id FROM jobs WHERE status IN ${TERMINAL}
           ORDER BY updated_at DESC, id DESC LIMIT -1 OFFSET ?
         )`,
      )
      .run(this.maxFinished).changes;
    return aged + excess;
  }

  private async tick(): Promise<void> {
    if (Date.now() - this.lastPrune > PRUNE_EVERY_MS) this.prune();
    this.failOrphans();
    while (this.running < this.concurrency) {
      const next = this.claimNext();
      if (!next) return;
      this.running++;
      this.runJob(next).finally(() => {
        this.running--;
      });
    }
  }

  /** Only jobs whose handler is registered are claimed; the others keep waiting. */
  private claimNext(): Row | null {
    const tools = [...this.handlers.keys()];
    if (tools.length === 0) return null;
    const marks = tools.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `UPDATE jobs SET status = 'running', updated_at = ?
         WHERE id = (SELECT id FROM jobs WHERE status = 'queued' AND tool IN (${marks})
                     ORDER BY created_at LIMIT 1)
         RETURNING *`,
      )
      .get(new Date().toISOString(), ...tools) as Row | undefined;
    return row ?? null;
  }

  /** Queued jobs whose handler never showed up fail once the grace period is over. */
  private failOrphans(): void {
    const now = Date.now();
    if (now - this.openedAt < this.handlerGraceMs) return;
    const tools = [...this.handlers.keys()];
    const marks = tools.map(() => "?").join(",");
    const rows = this.db
      .prepare(
        `SELECT id, tool FROM jobs WHERE status = 'queued' AND updated_at < ?
         ${tools.length > 0 ? `AND tool NOT IN (${marks})` : ""} LIMIT 100`,
      )
      .all(new Date(now - this.handlerGraceMs).toISOString(), ...tools) as Array<{
      id: string;
      tool: string;
    }>;
    for (const row of rows) {
      this.finish(
        row.id,
        "failed",
        `no handler is registered for ${row.tool}; the pack or feature that runs it is not loaded`,
        "queued",
      );
    }
  }

  private finish(id: string, status: JobStatus, error: string, from: string): void {
    this.db
      .prepare("UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ? AND status = ?")
      .run(status, error, new Date().toISOString(), id, from);
    this.volatileInputs.delete(id);
  }

  private async runJob(job: Row): Promise<void> {
    const handler = this.handlers.get(job.tool);
    const now = () => new Date().toISOString();
    if (!handler)
      return this.finish(job.id, "failed", `no handler is registered for ${job.tool}`, "running");
    if (job.interrupted && !handler.resumable) {
      return this.finish(job.id, "failed", INTERRUPTED_MESSAGE, "running");
    }
    let input = this.volatileInputs.get(job.id);
    if (!input) {
      if (job.input_redacted) {
        return this.finish(
          job.id,
          "failed",
          "the daemon restarted before this job ran and its arguments held a secret-looking value that is never stored; call the tool again",
          "running",
        );
      }
      input = parseObject(job.input_json);
    }
    const abort = new AbortController();
    this.aborts.set(job.id, abort);
    const markCancelled = () =>
      this.db
        .prepare(
          // Never over a status that is already final.
          `UPDATE jobs SET status='cancelled', error='cancelled', updated_at=?
           WHERE id=? AND status NOT IN ('succeeded','failed','expired','submission_unknown')`,
        )
        .run(now(), job.id);
    try {
      const execution: JobExecution = {
        id: job.id,
        signal: abort.signal,
        getCheckpoint: () => this.requireJob(job.id).checkpoint,
        mergeCheckpoint: (patch) => this.mergeCheckpoint(job.id, patch),
        setPhase: (status) => this.setPhase(job.id, status),
        setProgress: (progress) => this.setProgress(job.id, progress),
      };
      const result = await handler.run(input, execution);
      if (abort.signal.aborted) return void markCancelled();
      this.db
        .prepare("UPDATE jobs SET status='succeeded', result_json=?, updated_at=? WHERE id=?")
        .run(storedResultJson(result, this.maxResultBytes), now(), job.id);
    } catch (e) {
      if (abort.signal.aborted) return void markCancelled();
      const msg = e instanceof Error ? e.message : String(e);
      try {
        this.db
          .prepare("UPDATE jobs SET status=?, error=?, updated_at=? WHERE id=?")
          .run(e instanceof JobTerminalError ? e.status : "failed", msg, now(), job.id);
      } catch {
        // The database closed under a job that outlived shutdown.
      }
    } finally {
      this.aborts.delete(job.id);
      this.volatileInputs.delete(job.id);
    }
  }

  private migrateColumns(): void {
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(jobs)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    const add = (name: string, ddl: string) => {
      if (!columns.has(name)) this.db.prepare(`ALTER TABLE jobs ADD COLUMN ${name} ${ddl}`).run();
    };
    add("checkpoint_json", "TEXT NOT NULL DEFAULT '{}'");
    add("profile", "TEXT");
    add("input_redacted", "INTEGER NOT NULL DEFAULT 0");
    add("interrupted", "INTEGER NOT NULL DEFAULT 0");
    add("idem_key", "TEXT");
    add("idem_hash", "TEXT");
  }

  /** The database and its sidecar files are readable by the owner only. */
  private protectFiles(): void {
    const file = this.db.name;
    if (!file || file === ":memory:") return;
    for (const path of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
      try {
        if (existsSync(path)) chmodSync(path, 0o600);
      } catch {
        // Best effort: a read-only or foreign-owned file keeps its mode.
      }
    }
  }

  /**
   * Work a previous process left unfinished goes back to the queue flagged as
   * interrupted: a resumable handler continues it, any other fails it instead
   * of running a side effect twice.
   */
  private recoverStaleJobs(): void {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare(
        "SELECT id, status, checkpoint_json FROM jobs WHERE status IN ('running', 'staging', 'submitting', 'submitted', 'polling', 'downloading', 'awaiting_approval')",
      )
      .all() as Array<{ id: string; status: JobStatus; checkpoint_json: string }>;
    const update = this.db.prepare(
      "UPDATE jobs SET status = ?, error = ?, interrupted = ?, updated_at = ? WHERE id = ?",
    );
    for (const row of rows) {
      if (row.status === "submitting" && !hasUpstreamJobId(parseObject(row.checkpoint_json))) {
        update.run(
          "submission_unknown",
          "submission outcome is unknown after worker restart",
          0,
          now,
          row.id,
        );
      } else {
        update.run("queued", null, 1, now, row.id);
      }
    }
  }

  private requireJob(id: string): Job {
    const job = this.get(id);
    if (!job) throw new Error(`job not found: ${id}`);
    return job;
  }

  private updateExisting(id: string, fields: string, values: unknown[]): void {
    const result = this.db.prepare(`UPDATE jobs SET ${fields} WHERE id = ?`).run(...values, id);
    if (result.changes === 0) throw new Error(`job not found: ${id}`);
  }

  private reconcileSubmissionUnknown(
    id: string,
    mutate: (
      job: Job,
      at: string,
    ) => { status: JobStatus; error: string | null; checkpoint: Record<string, unknown> },
  ): Job {
    return this.db.transaction(() => {
      const job = this.requireJob(id);
      if (job.status !== "submission_unknown") {
        throw new Error(`job ${id} must have status submission_unknown to reconcile`);
      }
      const at = new Date().toISOString();
      const next = mutate(job, at);
      const result = this.db
        .prepare(
          `UPDATE jobs
           SET status = ?, error = ?, checkpoint_json = ?, updated_at = ?
           WHERE id = ? AND status = 'submission_unknown'`,
        )
        .run(next.status, next.error, JSON.stringify(next.checkpoint), at, id);
      if (result.changes === 0) {
        throw new Error(`job ${id} must have status submission_unknown to reconcile`);
      }
      return this.requireJob(id);
    })();
  }
}

/**
 * What jobs.db keeps for a finished job's result: the JSON itself, or — past
 * `maxBytes` — a small marker naming the real size, so one huge result cannot
 * bloat the database. Large outputs belong in the library (artifacts), which
 * results reference by id and url.
 */
function storedResultJson(result: unknown, maxBytes: number): string {
  const json = JSON.stringify(result ?? null) ?? "null";
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= maxBytes) return json;
  return JSON.stringify({
    truncated: true,
    bytes,
    note: `the result was ${bytes} bytes, over the ${Math.floor(maxBytes / 1024)} kB kept per job in jobs.db; large outputs are kept as artifacts and referenced by url`,
  });
}

/**
 * A copy of `input` in which every string (or nested value) under a key that
 * looks secret is replaced by a placeholder. Numbers, booleans and null stay
 * (max_tokens is not a secret).
 */
export function scrubSecretArgs(input: unknown): { value: unknown; changed: boolean } {
  let changed = false;
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 32 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => walk(item, depth + 1));
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const scalar = item === null || typeof item === "number" || typeof item === "boolean";
      if (SECRET_ARG_KEY.test(key) && !scalar && item !== undefined && item !== "") {
        out[key] = SECRET_ARG_PLACEHOLDER;
        changed = true;
      } else {
        out[key] = walk(item, depth + 1);
      }
    }
    return out;
  };
  const value = walk(input, 0);
  return { value, changed };
}

/**
 * What an idempotency key is bound to: the handler and the real arguments
 * (before secret-looking values are removed), as "<salt>:<sha256>". Salted
 * per job so equal calls of different profiles do not share a digest.
 */
function callDigest(salt: string, tool: string, input: unknown): string {
  const canonical = (value: unknown, depth: number): unknown => {
    if (depth > 64 || value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
    // Null prototype: an input key "__proto__" must become an own key, not
    // change the prototype of the object being built.
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(value as Record<string, unknown>).sort()) {
      out[k] = canonical((value as Record<string, unknown>)[k], depth + 1);
    }
    return out;
  };
  const text = JSON.stringify(canonical(input, 0)) ?? "";
  return `${salt}:${createHash("sha256").update(`${salt}\0${tool}\0${text}`).digest("hex")}`;
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string") return {};
  const parsed = safeParse(value);
  return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function hasUpstreamJobId(checkpoint: Record<string, unknown>): boolean {
  return typeof checkpoint.upstream_job_id === "string" && checkpoint.upstream_job_id.length > 0;
}

function appendAudit(
  checkpoint: Record<string, unknown>,
  entry: Record<string, unknown>,
): Record<string, unknown>[] {
  const existing = Array.isArray(checkpoint.audit)
    ? checkpoint.audit.filter(
        (item): item is Record<string, unknown> =>
          item !== null && typeof item === "object" && !Array.isArray(item),
      )
    : [];
  return [...existing, entry];
}

function clearSubmissionCheckpoint(checkpoint: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(checkpoint).filter(([key]) => {
      return !(
        key === "staged" ||
        key === "polling_url" ||
        key === "generation_id" ||
        key === "actual_cost_usd" ||
        key.startsWith("upstream_") ||
        key.startsWith("submission_")
      );
    }),
  );
}
