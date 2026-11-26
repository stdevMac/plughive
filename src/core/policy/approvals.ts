// src/core/policy/approvals.ts
//
// Human approvals of calls the spend policy will not run on its own. One row
// per request, in the daemon's jobs database:
//
//   pending  -> approved | denied | expired
//   approved -> consumed (the call ran, once) | expired (never retried in time)
//
// An approval covers exactly one call: the fingerprint is a hash of what runs
// (kind, tool, provider, profile and the arguments), so different arguments
// are never covered, and consuming is a single conditional UPDATE, so it is
// used at most once even by two concurrent retries.
//
// The row keeps a short, redacted summary of the arguments for the person
// deciding, never the arguments themselves.
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import { redactArgs } from "../tools/registry.js";

const ulid = monotonicFactory();

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "consumed";
export type ApprovalKind = "tool" | "provider" | "workflow";

export interface Approval {
  id: string;
  kind: ApprovalKind;
  tool: string;
  provider: string | null;
  args_summary: string;
  estimate_usd: number | null;
  estimate_basis: string | null;
  reason: string;
  profile: string;
  job_id: string | null;
  status: ApprovalStatus;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
}

export interface ApprovalRequest {
  kind: ApprovalKind;
  tool: string;
  provider?: string | null;
  args: unknown;
  estimateUsd: number | null;
  estimateBasis?: string | null;
  reason: string;
  profile: string;
  fingerprint: string;
  jobId?: string | null;
}

export const MAX_ARGS_SUMMARY = 400;

/** A stable JSON text: object keys sorted at every depth. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (seen.has(v as object)) return "[cycle]";
    seen.add(v as object);
    if (ArrayBuffer.isView(v))
      return `[binary ${createHash("sha256")
        .update(v as Uint8Array)
        .digest("hex")}]`;
    if (Array.isArray(v)) return v.map(walk);
    // Null prototype: an input key "__proto__" must become an own key, not
    // change the prototype of the object being built.
    const out: Record<string, unknown> = Object.create(null);
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const item = (v as Record<string, unknown>)[k];
      if (item !== undefined) out[k] = walk(item);
    }
    return out;
  };
  return JSON.stringify(walk(value)) ?? "null";
}

/** The fingerprint of one call: what runs, for whom, with which arguments. */
export function callFingerprint(parts: {
  kind: ApprovalKind;
  tool: string;
  provider?: string | null;
  profile: string;
  args: unknown;
}): string {
  // Provider calls strip max_cost_usd before routing so a retry with a tighter
  // or looser cap still matches; tool and workflow calls keep it in the hash
  // so a $0.01 approval cannot be replayed at $10,000.
  const args = parts.kind === "provider" ? stripMaxCost(parts.args) : parts.args;
  return createHash("sha256")
    .update(
      canonicalJson({
        kind: parts.kind,
        tool: parts.tool,
        provider: parts.provider ?? null,
        profile: parts.profile,
        args,
      }),
    )
    .digest("hex");
}

/** `max_cost_usd` is a guard, not part of a provider call: a retry may change it. */
export function stripMaxCost(args: unknown): unknown {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args;
  const { max_cost_usd: _ignored, ...rest } = args as Record<string, unknown>;
  return rest;
}

/**
 * Text a person reads in an approval (dashboard, CLI, Telegram) must look like
 * what it is: control characters, line breaks and bidirectional overrides
 * (which can make `evil.com/moc.elgoog` read as something else) become spaces.
 */
const UNSAFE_TEXT =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: these are the characters being removed
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/g;

export function cleanText(text: string): string {
  return text.replace(UNSAFE_TEXT, " ");
}

/** Room each value gets at least, however many keys there are. */
const MIN_VALUE_CHARS = 12;
/** Longest key name shown. */
const MAX_KEY_CHARS = 40;

function cut(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/**
 * A short summary of arguments a person can read: masked, cut, never the full
 * values. For an object every key is shown and each value gets its share of
 * the space, so one long value cannot push the others out of sight.
 */
export function summarizeArgs(
  args: unknown,
  redact?: (text: string) => string,
  kind?: ApprovalKind,
): string {
  const mask = (text: string) => cleanText(redact ? redact(text) : text);
  try {
    const shown = redactArgs(kind === "provider" ? stripMaxCost(args) : args);
    if (!shown || typeof shown !== "object" || Array.isArray(shown)) {
      return cut(mask(JSON.stringify(shown) ?? ""), MAX_ARGS_SUMMARY);
    }
    const entries = Object.entries(shown as Record<string, unknown>).map(
      ([k, v]) =>
        [cut(mask(JSON.stringify(k)), MAX_KEY_CHARS), mask(JSON.stringify(v) ?? "null")] as const,
    );
    if (entries.length === 0) return "{}";
    const keysLength = entries.reduce((n, [k]) => n + k.length + 2, 2);
    const share = Math.max(
      MIN_VALUE_CHARS,
      Math.floor((MAX_ARGS_SUMMARY - keysLength) / entries.length),
    );
    // Values shorter than their share leave room for the others.
    let spare = 0;
    for (const [, v] of entries) spare += Math.max(0, share - v.length);
    const parts = entries.map(([k, v]) => {
      if (v.length <= share) return `${k}:${v}`;
      const extra = Math.min(spare, v.length - share);
      spare -= extra;
      return `${k}:${cut(v, share + extra)}`;
    });
    return `{${parts.join(",")}}`;
  } catch {
    return "(arguments not shown)";
  }
}

interface Row {
  id: string;
  kind: string;
  tool: string;
  provider: string | null;
  args_summary: string;
  estimate_usd: number | null;
  estimate_basis: string | null;
  reason: string;
  profile: string;
  job_id: string | null;
  status: string;
  fingerprint: string;
  created_at: string;
  expires_at: string;
  decided_at: string | null;
  decided_by: string | null;
  reported: number;
}

function toApproval(r: Row): Approval {
  return {
    id: r.id,
    kind: r.kind as ApprovalKind,
    tool: r.tool,
    provider: r.provider,
    args_summary: r.args_summary,
    estimate_usd: r.estimate_usd,
    estimate_basis: r.estimate_basis,
    reason: r.reason,
    profile: r.profile,
    job_id: r.job_id,
    status: r.status as ApprovalStatus,
    created_at: r.created_at,
    expires_at: r.expires_at,
    decided_at: r.decided_at,
    decided_by: r.decided_by,
  };
}

export interface ApprovalStoreOptions {
  db: Database.Database;
  now?: () => number;
  redact?: (text: string) => string;
}

export const APPROVAL_ID_RE = /^apr_[0-9A-HJKMNP-TV-Z]{26}$/;

export class ApprovalStore {
  private readonly db: Database.Database;
  private readonly now: () => number;
  private readonly redact: ((text: string) => string) | undefined;
  /** "change" (approval: Approval) on every status change and new request. */
  readonly events = new EventEmitter();

  constructor(opts: ApprovalStoreOptions) {
    this.db = opts.db;
    this.now = opts.now ?? Date.now;
    this.redact = opts.redact;
    this.events.setMaxListeners(0);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        tool TEXT NOT NULL,
        provider TEXT,
        args_summary TEXT NOT NULL,
        estimate_usd REAL,
        estimate_basis TEXT,
        reason TEXT NOT NULL,
        profile TEXT NOT NULL,
        job_id TEXT,
        status TEXT NOT NULL,
        fingerprint TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        decided_at TEXT,
        decided_by TEXT,
        reported INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS approvals_fingerprint ON approvals(fingerprint, created_at);
      CREATE INDEX IF NOT EXISTS approvals_status ON approvals(status, created_at);
    `);
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  /** Pending or approved rows past their expiry become expired. Lazy: run before every read. */
  expireStale(): void {
    const now = this.iso(this.now());
    const rows = this.db
      .prepare("SELECT * FROM approvals WHERE status IN ('pending','approved') AND expires_at <= ?")
      .all(now) as Row[];
    if (rows.length === 0) return;
    const update = this.db.prepare(
      "UPDATE approvals SET status = 'expired' WHERE id = ? AND status IN ('pending','approved')",
    );
    for (const r of rows) {
      if (update.run(r.id).changes > 0) this.emit(r.id);
    }
  }

  private emit(id: string): void {
    const a = this.get(id, { skipExpiry: true });
    if (a) this.events.emit("change", a);
  }

  get(id: string, opts: { skipExpiry?: boolean } = {}): Approval | null {
    if (!opts.skipExpiry) this.expireStale();
    const row = this.db.prepare("SELECT * FROM approvals WHERE id = ?").get(id) as Row | undefined;
    return row ? toApproval(row) : null;
  }

  list(opts: { status?: ApprovalStatus; limit?: number } = {}): Approval[] {
    this.expireStale();
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 100)), 500);
    const rows = (
      opts.status
        ? this.db
            .prepare("SELECT * FROM approvals WHERE status = ? ORDER BY created_at DESC LIMIT ?")
            .all(opts.status, limit)
        : this.db.prepare("SELECT * FROM approvals ORDER BY created_at DESC LIMIT ?").all(limit)
    ) as Row[];
    return rows.map(toApproval);
  }

  pendingCount(): number {
    this.expireStale();
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM approvals WHERE status = 'pending'")
      .get() as { n: number };
    return row.n;
  }

  /**
   * The row that decides a call with this fingerprint: the newest one that is
   * pending or approved, or denied/expired and not yet reported to the caller.
   * Null: nothing open, a new request is needed.
   */
  lookup(fingerprint: string): Approval | null {
    this.expireStale();
    const row = this.db
      .prepare(
        `SELECT * FROM approvals WHERE fingerprint = ?
           AND (status IN ('pending','approved') OR (status IN ('denied','expired') AND reported = 0))
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(fingerprint) as Row | undefined;
    return row ? toApproval(row) : null;
  }

  /** A denial or expiry has been told to the caller: the next identical call may ask again. */
  markReported(id: string): void {
    this.db.prepare("UPDATE approvals SET reported = 1 WHERE id = ?").run(id);
  }

  /** A new pending request, or the open one with the same fingerprint. */
  request(req: ApprovalRequest, ttlMs: number): Approval {
    return this.db.transaction(() => {
      const open = this.db
        .prepare(
          "SELECT * FROM approvals WHERE fingerprint = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC LIMIT 1",
        )
        .get(req.fingerprint, this.iso(this.now())) as Row | undefined;
      if (open) return toApproval(open);
      const id = `apr_${ulid()}`;
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO approvals (id, kind, tool, provider, args_summary, estimate_usd, estimate_basis,
             reason, profile, job_id, status, fingerprint, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
        )
        .run(
          id,
          req.kind,
          cleanText(req.tool.slice(0, 200)),
          req.provider ?? null,
          summarizeArgs(req.args, this.redact, req.kind),
          req.estimateUsd,
          req.estimateBasis ?? null,
          cleanText(req.reason.slice(0, 500)),
          req.profile,
          req.jobId ?? null,
          req.fingerprint,
          this.iso(now),
          this.iso(now + ttlMs),
        );
      const created = this.get(id, { skipExpiry: true }) as Approval;
      queueMicrotask(() => this.events.emit("change", created));
      return created;
    })();
  }

  /**
   * Approve or deny a pending request. An approval may then be used once
   * within `ttlMs`. False when the request is not pending (decided, expired, unknown).
   */
  decide(id: string, decision: "approved" | "denied", by: string, ttlMs: number): boolean {
    this.expireStale();
    const now = this.now();
    const result = this.db
      .prepare(
        `UPDATE approvals SET status = ?, decided_at = ?, decided_by = ?,
           expires_at = CASE WHEN ? = 'approved' THEN ? ELSE expires_at END
         WHERE id = ? AND status = 'pending'`,
      )
      .run(decision, this.iso(now), by.slice(0, 64), decision, this.iso(now + ttlMs), id);
    if (result.changes === 0) return false;
    this.emit(id);
    return true;
  }

  /** Use an approval: true exactly once, for an approved, unexpired row. */
  consume(id: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE approvals SET status = 'consumed' WHERE id = ? AND status = 'approved' AND expires_at > ?",
      )
      .run(id, this.iso(this.now()));
    if (result.changes === 0) return false;
    this.emit(id);
    return true;
  }

  /**
   * Resolve when the request is no longer pending (approved, denied, expired)
   * or `signal` aborts. Checks at least every `pollMs`, so an expiry with no
   * other activity is still seen.
   */
  waitForDecision(id: string, signal?: AbortSignal, pollMs = 1000): Promise<Approval> {
    return new Promise((resolve, reject) => {
      let finished = false;
      const done = (fn: () => void) => {
        if (finished) return;
        finished = true;
        this.events.off("change", onChange);
        signal?.removeEventListener("abort", onAbort);
        clearInterval(timer);
        fn();
      };
      const check = () => {
        const a = this.get(id);
        if (!a) return done(() => reject(new Error(`approval ${id} not found`)));
        if (a.status !== "pending") done(() => resolve(a));
      };
      const onChange = (a: Approval) => {
        if (a.id === id) check();
      };
      const onAbort = () => done(() => reject(new Error("cancelled while awaiting approval")));
      const timer = setInterval(() => check(), pollMs);
      timer.unref?.();
      if (signal?.aborted) return onAbort();
      this.events.on("change", onChange);
      signal?.addEventListener("abort", onAbort, { once: true });
      check();
    });
  }
}
