// src/core/triggers/store.ts
//
// Triggers, their runs and the webhook replay cache, in SQLite (the daemon's
// jobs.db, which is private to the user: 0600). A trigger's secret is kept
// here because verifying a webhook signature needs the secret itself; it is
// returned by the API only once, when it is created or rotated.
import { randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import type { CronZone } from "./cron.js";

export type TriggerKind = "cron" | "webhook";

export type TriggerCallback =
  | { type: "webhook"; url: string }
  | { type: "telegram"; chat_id?: string };

export interface Trigger {
  id: string;
  name: string;
  kind: TriggerKind;
  /** The workflow tool to run (wf_<name>). */
  workflow: string;
  args: Record<string, unknown>;
  /** Cron triggers only. */
  schedule: string | null;
  timezone: CronZone;
  /** Cron: after missed runs, run once (the last one) instead of skipping them all. */
  catchUp: boolean;
  /** Webhook: merge a JSON object body over `args`. */
  useBody: boolean;
  enabled: boolean;
  /** The exposure profile the run is restricted to (null: the default scope). */
  profile: string | null;
  callback: TriggerCallback | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastJobId: string | null;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
}

export type CallbackState = "none" | "pending" | "sending" | "sent" | "failed";

export interface TriggerRun {
  id: number;
  triggerId: string;
  jobId: string | null;
  source: "cron" | "webhook" | "manual";
  firedAt: number;
  /** "started", or "error" when the job could not be started. */
  status: string;
  error: string | null;
  callbackState: CallbackState;
  callbackError: string | null;
}

interface TriggerRow {
  id: string;
  name: string;
  kind: string;
  workflow: string;
  args_json: string;
  schedule: string | null;
  timezone: string;
  catch_up: number;
  use_body: number;
  enabled: number;
  profile: string | null;
  callback_json: string | null;
  secret: string;
  next_run_at: number | null;
  last_run_at: number | null;
  last_job_id: string | null;
  last_status: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
}

interface RunRow {
  id: number;
  trigger_id: string;
  job_id: string | null;
  source: string;
  fired_at: number;
  status: string;
  error: string | null;
  callback_state: string;
  callback_error: string | null;
}

export const MAX_TRIGGERS = 200;
export const RUNS_KEPT_PER_TRIGGER = 50;

const parseJson = <T>(text: string | null, fallback: T): T => {
  if (text === null) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

function toTrigger(r: TriggerRow): Trigger {
  return {
    id: r.id,
    name: r.name,
    kind: r.kind === "webhook" ? "webhook" : "cron",
    workflow: r.workflow,
    args: parseJson<Record<string, unknown>>(r.args_json, {}),
    schedule: r.schedule,
    timezone: r.timezone === "local" ? "local" : "UTC",
    catchUp: r.catch_up === 1,
    useBody: r.use_body === 1,
    enabled: r.enabled === 1,
    profile: r.profile,
    callback: parseJson<TriggerCallback | null>(r.callback_json, null),
    nextRunAt: r.next_run_at,
    lastRunAt: r.last_run_at,
    lastJobId: r.last_job_id,
    lastStatus: r.last_status,
    lastError: r.last_error,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function toRun(r: RunRow): TriggerRun {
  return {
    id: r.id,
    triggerId: r.trigger_id,
    jobId: r.job_id,
    source: r.source === "webhook" ? "webhook" : r.source === "manual" ? "manual" : "cron",
    firedAt: r.fired_at,
    status: r.status,
    error: r.error,
    callbackState: r.callback_state as CallbackState,
    callbackError: r.callback_error,
  };
}

export const newSecret = () => `whsec_${randomBytes(32).toString("base64url")}`;
const newId = () => `trg_${randomBytes(9).toString("base64url")}`;

export interface NewTrigger {
  name: string;
  kind: TriggerKind;
  workflow: string;
  args: Record<string, unknown>;
  schedule: string | null;
  timezone: CronZone;
  catchUp: boolean;
  useBody: boolean;
  enabled: boolean;
  profile: string | null;
  callback: TriggerCallback | null;
  nextRunAt: number | null;
}

export type TriggerPatch = Partial<
  Pick<
    Trigger,
    | "name"
    | "args"
    | "schedule"
    | "timezone"
    | "catchUp"
    | "useBody"
    | "enabled"
    | "callback"
    | "nextRunAt"
  >
>;

export class TriggerStore {
  constructor(private readonly db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS triggers (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
        workflow TEXT NOT NULL, args_json TEXT NOT NULL DEFAULT '{}',
        schedule TEXT, timezone TEXT NOT NULL DEFAULT 'UTC',
        catch_up INTEGER NOT NULL DEFAULT 0, use_body INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1, profile TEXT, callback_json TEXT,
        secret TEXT NOT NULL, next_run_at INTEGER, last_run_at INTEGER,
        last_job_id TEXT, last_status TEXT, last_error TEXT,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS trigger_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, trigger_id TEXT NOT NULL,
        job_id TEXT, source TEXT NOT NULL, fired_at INTEGER NOT NULL,
        status TEXT NOT NULL, error TEXT,
        callback_state TEXT NOT NULL DEFAULT 'none', callback_error TEXT
      );
      CREATE INDEX IF NOT EXISTS trigger_runs_trigger ON trigger_runs(trigger_id, id);
      CREATE INDEX IF NOT EXISTS trigger_runs_callback ON trigger_runs(callback_state);
      CREATE TABLE IF NOT EXISTS trigger_replay (
        trigger_id TEXT NOT NULL, signature TEXT NOT NULL, seen_at INTEGER NOT NULL,
        PRIMARY KEY (trigger_id, signature)
      );
    `);
  }

  count(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM triggers").get() as { n: number }).n;
  }

  list(): Trigger[] {
    return (
      this.db.prepare("SELECT * FROM triggers ORDER BY created_at, id").all() as TriggerRow[]
    ).map(toTrigger);
  }

  get(id: string): Trigger | null {
    const row = this.db.prepare("SELECT * FROM triggers WHERE id = ?").get(id) as
      | TriggerRow
      | undefined;
    return row ? toTrigger(row) : null;
  }

  secret(id: string): string | null {
    const row = this.db.prepare("SELECT secret FROM triggers WHERE id = ?").get(id) as
      | { secret: string }
      | undefined;
    return row?.secret ?? null;
  }

  create(t: NewTrigger, now = Date.now()): { trigger: Trigger; secret: string } {
    const id = newId();
    const secret = newSecret();
    this.db
      .prepare(
        `INSERT INTO triggers (id, name, kind, workflow, args_json, schedule, timezone, catch_up,
           use_body, enabled, profile, callback_json, secret, next_run_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        t.name,
        t.kind,
        t.workflow,
        JSON.stringify(t.args),
        t.schedule,
        t.timezone,
        t.catchUp ? 1 : 0,
        t.useBody ? 1 : 0,
        t.enabled ? 1 : 0,
        t.profile,
        t.callback ? JSON.stringify(t.callback) : null,
        secret,
        t.nextRunAt,
        now,
        now,
      );
    return { trigger: this.get(id) as Trigger, secret };
  }

  update(id: string, patch: TriggerPatch, now = Date.now()): Trigger | null {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const set = (col: string, v: unknown) => {
      sets.push(`${col} = ?`);
      vals.push(v);
    };
    if (patch.name !== undefined) set("name", patch.name);
    if (patch.args !== undefined) set("args_json", JSON.stringify(patch.args));
    if (patch.schedule !== undefined) set("schedule", patch.schedule);
    if (patch.timezone !== undefined) set("timezone", patch.timezone);
    if (patch.catchUp !== undefined) set("catch_up", patch.catchUp ? 1 : 0);
    if (patch.useBody !== undefined) set("use_body", patch.useBody ? 1 : 0);
    if (patch.enabled !== undefined) set("enabled", patch.enabled ? 1 : 0);
    if (patch.callback !== undefined) {
      set("callback_json", patch.callback ? JSON.stringify(patch.callback) : null);
    }
    if (patch.nextRunAt !== undefined) set("next_run_at", patch.nextRunAt);
    set("updated_at", now);
    const res = this.db
      .prepare(`UPDATE triggers SET ${sets.join(", ")} WHERE id = ?`)
      .run(...vals, id);
    return res.changes === 1 ? this.get(id) : null;
  }

  rotateSecret(id: string): string | null {
    const secret = newSecret();
    const res = this.db
      .prepare("UPDATE triggers SET secret = ?, updated_at = ? WHERE id = ?")
      .run(secret, Date.now(), id);
    if (res.changes !== 1) return null;
    this.db.prepare("DELETE FROM trigger_replay WHERE trigger_id = ?").run(id);
    return secret;
  }

  delete(id: string): boolean {
    const del = this.db.transaction(() => {
      this.db.prepare("DELETE FROM trigger_runs WHERE trigger_id = ?").run(id);
      this.db.prepare("DELETE FROM trigger_replay WHERE trigger_id = ?").run(id);
      return this.db.prepare("DELETE FROM triggers WHERE id = ?").run(id).changes === 1;
    });
    return del();
  }

  /** Enabled cron triggers whose next run is due (next_run_at <= now) or not yet computed. */
  dueCron(now: number): Trigger[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM triggers WHERE kind = 'cron' AND enabled = 1
             AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at`,
        )
        .all(now) as TriggerRow[]
    ).map(toTrigger);
  }

  /**
   * Move a cron trigger from the slot it was read at to the next one. Only one
   * caller can win: the UPDATE matches the slot value it read, so a slot is
   * claimed (and fired) at most once, also across restarts and concurrent ticks.
   */
  claimSlot(id: string, expected: number | null, next: number | null): boolean {
    const res = this.db
      .prepare(
        `UPDATE triggers SET next_run_at = ? WHERE id = ? AND enabled = 1
           AND next_run_at IS ?`,
      )
      .run(next, id, expected);
    return res.changes === 1;
  }

  recordRun(
    triggerId: string,
    run: {
      jobId: string | null;
      source: TriggerRun["source"];
      status: string;
      error: string | null;
      callback: boolean;
    },
    now = Date.now(),
  ): TriggerRun {
    const tx = this.db.transaction(() => {
      const info = this.db
        .prepare(
          `INSERT INTO trigger_runs (trigger_id, job_id, source, fired_at, status, error, callback_state)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          triggerId,
          run.jobId,
          run.source,
          now,
          run.status,
          run.error,
          run.callback && run.jobId ? "pending" : "none",
        );
      this.db
        .prepare(
          `UPDATE triggers SET last_run_at = ?, last_job_id = ?, last_status = ?, last_error = ?
             WHERE id = ?`,
        )
        .run(now, run.jobId, run.status, run.error, triggerId);
      // Keep the newest runs only.
      this.db
        .prepare(
          `DELETE FROM trigger_runs WHERE trigger_id = ? AND id NOT IN (
             SELECT id FROM trigger_runs WHERE trigger_id = ? ORDER BY id DESC LIMIT ?)
             AND callback_state NOT IN ('pending', 'sending')`,
        )
        .run(triggerId, triggerId, RUNS_KEPT_PER_TRIGGER);
      return Number(info.lastInsertRowid);
    });
    const id = tx();
    return toRun(this.db.prepare("SELECT * FROM trigger_runs WHERE id = ?").get(id) as RunRow);
  }

  runs(triggerId: string, limit = 20): TriggerRun[] {
    return (
      this.db
        .prepare("SELECT * FROM trigger_runs WHERE trigger_id = ? ORDER BY id DESC LIMIT ?")
        .all(triggerId, limit) as RunRow[]
    ).map(toRun);
  }

  pendingCallbacks(limit = 50): TriggerRun[] {
    return (
      this.db
        .prepare("SELECT * FROM trigger_runs WHERE callback_state = 'pending' ORDER BY id LIMIT ?")
        .all(limit) as RunRow[]
    ).map(toRun);
  }

  /** pending -> sending, by one caller only: a callback is sent at most once. */
  claimCallback(runId: number): boolean {
    return (
      this.db
        .prepare(
          "UPDATE trigger_runs SET callback_state = 'sending' WHERE id = ? AND callback_state = 'pending'",
        )
        .run(runId).changes === 1
    );
  }

  finishCallback(runId: number, ok: boolean, error: string | null): void {
    this.db
      .prepare("UPDATE trigger_runs SET callback_state = ?, callback_error = ? WHERE id = ?")
      .run(ok ? "sent" : "failed", error, runId);
  }

  /**
   * Callbacks left in "sending" by a daemon that stopped mid-send are marked
   * failed, never sent again: a receiver may already have it.
   */
  failInterruptedCallbacks(): number {
    return this.db
      .prepare(
        "UPDATE trigger_runs SET callback_state = 'failed', callback_error = 'interrupted by restart' WHERE callback_state = 'sending'",
      )
      .run().changes;
  }

  /** Record a signature. False when it was seen before (a replay). */
  remember(triggerId: string, signature: string, now = Date.now()): boolean {
    const res = this.db
      .prepare(
        "INSERT OR IGNORE INTO trigger_replay (trigger_id, signature, seen_at) VALUES (?, ?, ?)",
      )
      .run(triggerId, signature, now);
    return res.changes === 1;
  }

  pruneReplay(olderThan: number): void {
    this.db.prepare("DELETE FROM trigger_replay WHERE seen_at < ?").run(olderThan);
  }
}
