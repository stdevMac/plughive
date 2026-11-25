import { join } from "node:path";
// src/lib/usage.ts
import type Database from "better-sqlite3";
import { monotonicFactory } from "ulid";
import { openPrivateDb } from "./private-db.js";

const ulid = monotonicFactory();

export type UsageStatus = "ok" | "error" | "fallback";

export interface UsageEvent {
  id: string;
  tool: string;
  capability: string | null;
  vendor: string | null;
  provider: string | null;
  costUsd: number | null;
  latencyMs: number;
  status: UsageStatus;
  error: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

export interface RecordUsageInput {
  tool: string;
  capability?: string | null;
  vendor?: string | null;
  provider?: string | null;
  costUsd?: number | null;
  latencyMs: number;
  status: UsageStatus;
  error?: string | null;
  meta?: Record<string, unknown> | null;
  /** Profile the call ran for. Default: `UsageLedgerOpts.profileOf()`. */
  profile?: string | null;
}

export interface VendorRateLimitState {
  vendor: string;
  last_429_at: string | null;
  consecutive_429s: number;
  cooldown_until: string | null;
  in_cooldown: boolean;
}

export interface UsageSummary {
  total_calls: number;
  ok_calls: number;
  error_calls: number;
  fallback_calls: number;
  /** Paid calls answered from the paid-call cache at no cost. */
  cached_calls: number;
  total_cost_usd: number;
  by_tool: Array<{ tool: string; calls: number; cost_usd: number }>;
  by_vendor: Array<{ vendor: string; calls: number; cost_usd: number }>;
  by_capability: Array<{ capability: string; calls: number; cost_usd: number }>;
  rate_limits: VendorRateLimitState[];
}

export interface UsageLedgerOpts {
  root: string;
  /** Default cooldown after a 429, in milliseconds */
  rateLimitCooldownMs?: number;
  /** The profile of the running request (recorded with each event for per-profile caps). */
  profileOf?: () => string | undefined;
}

/** Which events a spend query adds up. */
export interface SpendQuery {
  /** ISO time: events at or after it. */
  since: string;
  /** A provider id: events with that vendor, or (no vendor) of that pack. */
  provider?: string;
  profile?: string;
}

const RATE_LIMIT_RE = /\b429\b|rate.?limit|too many requests/i;

export class UsageLedger {
  private db: Database.Database;
  private rateLimitCooldownMs: number;
  private readonly profileOf: (() => string | undefined) | undefined;

  constructor(opts: UsageLedgerOpts) {
    this.rateLimitCooldownMs = opts.rateLimitCooldownMs ?? 60_000;
    this.profileOf = opts.profileOf;
    this.db = openPrivateDb(join(opts.root, "usage.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS usage_events (
        id TEXT PRIMARY KEY,
        tool TEXT NOT NULL,
        capability TEXT,
        vendor TEXT,
        provider TEXT,
        cost_usd REAL,
        latency_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        meta_json TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS usage_created ON usage_events(created_at DESC);
      CREATE INDEX IF NOT EXISTS usage_tool ON usage_events(tool);
      CREATE INDEX IF NOT EXISTS usage_vendor ON usage_events(vendor);
      CREATE INDEX IF NOT EXISTS usage_capability ON usage_events(capability);

      CREATE TABLE IF NOT EXISTS vendor_rate_limits (
        vendor TEXT PRIMARY KEY,
        last_429_at TEXT,
        consecutive_429s INTEGER NOT NULL DEFAULT 0,
        cooldown_until TEXT
      );
    `);
    // Columns added later: the pack and profile a call ran for, so spend can
    // be added up per provider and per profile with an index (spend caps).
    const columns = new Set(
      (this.db.prepare("PRAGMA table_info(usage_events)").all() as Array<{ name: string }>).map(
        (c) => c.name,
      ),
    );
    if (!columns.has("pack")) this.db.exec("ALTER TABLE usage_events ADD COLUMN pack TEXT");
    if (!columns.has("profile")) this.db.exec("ALTER TABLE usage_events ADD COLUMN profile TEXT");
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS usage_vendor_created ON usage_events(vendor, created_at);
      CREATE INDEX IF NOT EXISTS usage_pack_created ON usage_events(pack, created_at);
      CREATE INDEX IF NOT EXISTS usage_profile_created ON usage_events(profile, created_at);
    `);
  }

  /**
   * Dollars recorded since `q.since` (unknown costs count as 0), optionally
   * for one provider and/or one profile. Every filter hits an index.
   */
  spent(q: SpendQuery): number {
    const clauses = ["created_at >= ?"];
    const params: unknown[] = [q.since];
    if (q.provider !== undefined) {
      clauses.push("(vendor = ? OR (vendor IS NULL AND pack = ?))");
      params.push(q.provider, q.provider);
    }
    if (q.profile !== undefined) {
      clauses.push("profile = ?");
      params.push(q.profile);
    }
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM usage_events WHERE ${clauses.join(" AND ")}`,
      )
      .get(...params) as { total: number };
    return Number(row.total) || 0;
  }

  /**
   * Per vendor (a mount's prefix): when it was last called and how many calls
   * it had since `since`. Vendors with no calls are absent. Uses the
   * (vendor, created_at) index.
   */
  lastUseByVendor(vendors: readonly string[], since: string): Map<string, VendorUse> {
    const out = new Map<string, VendorUse>();
    if (vendors.length === 0) return out;
    const marks = vendors.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT vendor, MAX(created_at) AS last, SUM(CASE WHEN created_at >= ? THEN 1 ELSE 0 END) AS calls
         FROM usage_events WHERE vendor IN (${marks}) GROUP BY vendor`,
      )
      .all(since, ...vendors) as Array<{ vendor: string; last: string; calls: number }>;
    for (const r of rows) out.set(r.vendor, { lastUsedAt: r.last, calls: Number(r.calls) || 0 });
    return out;
  }

  /**
   * Calls per tool and profile since `since`: how many, how many failed, and
   * the latest. `profile` is null for calls made outside a profile.
   */
  useByTool(since: string): ToolUse[] {
    const rows = this.db
      .prepare(
        `SELECT tool, profile, COUNT(*) AS calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                MAX(created_at) AS last
         FROM usage_events WHERE created_at >= ? GROUP BY tool, profile`,
      )
      .all(since) as Array<{
      tool: string;
      profile: string | null;
      calls: number;
      errors: number;
      last: string;
    }>;
    return rows.map((r) => ({
      tool: r.tool,
      profile: r.profile ?? null,
      calls: Number(r.calls) || 0,
      errors: Number(r.errors) || 0,
      lastUsedAt: r.last,
    }));
  }

  record(input: RecordUsageInput): UsageEvent {
    if (input.vendor && input.error && isRateLimitError(input.error)) {
      this.recordRateLimit(input.vendor);
    }

    const id = `use_${ulid()}`;
    const createdAt = new Date().toISOString();
    const event: UsageEvent = {
      id,
      tool: input.tool,
      capability: input.capability ?? null,
      vendor: input.vendor ?? null,
      provider: input.provider ?? null,
      costUsd: input.costUsd ?? null,
      latencyMs: input.latencyMs,
      status: input.status,
      error: input.error ?? null,
      meta: input.meta ?? null,
      createdAt,
    };
    this.db
      .prepare(
        `INSERT INTO usage_events
         (id, tool, capability, vendor, provider, cost_usd, latency_ms, status, error, meta_json, created_at, pack, profile)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.tool,
        event.capability,
        event.vendor,
        event.provider,
        event.costUsd,
        event.latencyMs,
        event.status,
        event.error,
        event.meta ? JSON.stringify(event.meta) : null,
        event.createdAt,
        typeof event.meta?.pack === "string" ? event.meta.pack.slice(0, 128) : null,
        this.profileFor(input),
      );
    return event;
  }

  private profileFor(input: RecordUsageInput): string | null {
    if (input.profile !== undefined) return input.profile;
    try {
      return this.profileOf?.() ?? null;
    } catch {
      return null;
    }
  }

  recordRateLimit(vendor: string): void {
    const now = new Date();
    const existing = this.db
      .prepare("SELECT consecutive_429s FROM vendor_rate_limits WHERE vendor = ?")
      .get(vendor) as { consecutive_429s: number } | undefined;
    const consecutive = (existing?.consecutive_429s ?? 0) + 1;
    const cooldownMs = this.rateLimitCooldownMs * Math.min(consecutive, 5);
    const cooldownUntil = new Date(now.getTime() + cooldownMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO vendor_rate_limits (vendor, last_429_at, consecutive_429s, cooldown_until)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(vendor) DO UPDATE SET
           last_429_at = excluded.last_429_at,
           consecutive_429s = excluded.consecutive_429s,
           cooldown_until = excluded.cooldown_until`,
      )
      .run(vendor, now.toISOString(), consecutive, cooldownUntil);
  }

  isVendorInCooldown(vendor: string): boolean {
    const row = this.db
      .prepare("SELECT cooldown_until FROM vendor_rate_limits WHERE vendor = ?")
      .get(vendor) as { cooldown_until: string | null } | undefined;
    if (!row?.cooldown_until) return false;
    return new Date(row.cooldown_until).getTime() > Date.now();
  }

  listRateLimits(): VendorRateLimitState[] {
    const rows = this.db
      .prepare(
        "SELECT vendor, last_429_at, consecutive_429s, cooldown_until FROM vendor_rate_limits",
      )
      .all() as Array<{
      vendor: string;
      last_429_at: string | null;
      consecutive_429s: number;
      cooldown_until: string | null;
    }>;
    return rows.map((r) => ({
      vendor: r.vendor,
      last_429_at: r.last_429_at,
      consecutive_429s: r.consecutive_429s,
      cooldown_until: r.cooldown_until,
      in_cooldown: r.cooldown_until != null && new Date(r.cooldown_until).getTime() > Date.now(),
    }));
  }

  clearVendorCooldown(vendor: string): void {
    this.db.prepare("DELETE FROM vendor_rate_limits WHERE vendor = ?").run(vendor);
  }

  list(opts: { since?: string; tool?: string; limit?: number } = {}): UsageEvent[] {
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (opts.since) {
      clauses.push("created_at >= ?");
      params.push(opts.since);
    }
    if (opts.tool) {
      clauses.push("tool = ?");
      params.push(opts.tool);
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const limit = opts.limit ?? 100;
    const rows = this.db
      .prepare(`SELECT * FROM usage_events ${where} ORDER BY created_at DESC LIMIT ?`)
      .all(...params, limit) as Array<Record<string, unknown>>;
    return rows.map(rowToEvent);
  }

  summarize(opts: { since?: string } = {}): UsageSummary {
    const sinceClause = opts.since ? "WHERE created_at >= ?" : "";
    const params: unknown[] = opts.since ? [opts.since] : [];
    const filter = sinceClause;

    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) as total_calls,
           SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) as ok_calls,
           SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as error_calls,
           SUM(CASE WHEN status = 'fallback' THEN 1 ELSE 0 END) as fallback_calls,
           SUM(CASE WHEN meta_json IS NOT NULL AND json_extract(meta_json, '$.cached') = 1 THEN 1 ELSE 0 END) as cached_calls,
           COALESCE(SUM(cost_usd), 0) as total_cost_usd
         FROM usage_events ${filter}`,
      )
      .get(...params) as {
      total_calls: number;
      ok_calls: number;
      error_calls: number;
      fallback_calls: number;
      cached_calls: number | null;
      total_cost_usd: number;
    };

    const toolFilter = buildFilter(opts.since, null);
    const byTool = this.db
      .prepare(
        `SELECT tool, COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost_usd
         FROM usage_events ${toolFilter.clause}
         GROUP BY tool ORDER BY calls DESC LIMIT 50`,
      )
      .all(...toolFilter.params) as Array<{ tool: string; calls: number; cost_usd: number }>;

    const vendorFilter = buildFilter(opts.since, "vendor IS NOT NULL");
    const byVendor = this.db
      .prepare(
        `SELECT vendor, COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost_usd
         FROM usage_events ${vendorFilter.clause}
         GROUP BY vendor ORDER BY calls DESC LIMIT 50`,
      )
      .all(...vendorFilter.params) as Array<{ vendor: string; calls: number; cost_usd: number }>;

    const capFilter = buildFilter(opts.since, "capability IS NOT NULL");
    const byCapability = this.db
      .prepare(
        `SELECT capability, COUNT(*) as calls, COALESCE(SUM(cost_usd), 0) as cost_usd
         FROM usage_events ${capFilter.clause}
         GROUP BY capability ORDER BY calls DESC LIMIT 50`,
      )
      .all(...capFilter.params) as Array<{ capability: string; calls: number; cost_usd: number }>;

    return {
      total_calls: totals.total_calls,
      ok_calls: totals.ok_calls,
      error_calls: totals.error_calls,
      fallback_calls: totals.fallback_calls,
      cached_calls: totals.cached_calls ?? 0,
      total_cost_usd: totals.total_cost_usd,
      by_tool: byTool,
      by_vendor: byVendor,
      by_capability: byCapability,
      rate_limits: this.listRateLimits(),
    };
  }

  /**
   * Calls and cost per provider per UTC day, newest day first. The provider is
   * the row's vendor (a capability provider id or a mount prefix); rows
   * without one are grouped under "none".
   */
  byProviderAndDay(opts: { since?: string; limit?: number } = {}): UsageByProviderDay[] {
    const where = opts.since ? "WHERE created_at >= ?" : "";
    const params: unknown[] = opts.since ? [opts.since] : [];
    const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 500)), 2000);
    return this.db
      .prepare(
        `SELECT substr(created_at, 1, 10) AS day,
                COALESCE(vendor, 'none') AS provider,
                COUNT(*) AS calls,
                SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
                COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM usage_events ${where}
         GROUP BY day, provider ORDER BY day DESC, cost_usd DESC, calls DESC LIMIT ?`,
      )
      .all(...params, limit) as UsageByProviderDay[];
  }

  close(): void {
    this.db.close();
  }
}

export interface ToolUse {
  tool: string;
  profile: string | null;
  calls: number;
  errors: number;
  lastUsedAt: string;
}

export interface VendorUse {
  lastUsedAt: string;
  /** Calls since the `since` of the query. */
  calls: number;
}

export interface UsageByProviderDay {
  day: string;
  provider: string;
  calls: number;
  errors: number;
  cost_usd: number;
}

export function isRateLimitError(message: string): boolean {
  return RATE_LIMIT_RE.test(message);
}

function buildFilter(
  since: string | undefined,
  extra: string | null,
): { clause: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  if (since) {
    parts.push("created_at >= ?");
    params.push(since);
  }
  if (extra) parts.push(extra);
  return { clause: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

function rowToEvent(row: Record<string, unknown>): UsageEvent {
  return {
    id: String(row.id),
    tool: String(row.tool),
    capability: row.capability != null ? String(row.capability) : null,
    vendor: row.vendor != null ? String(row.vendor) : null,
    provider: row.provider != null ? String(row.provider) : null,
    costUsd: row.cost_usd != null ? Number(row.cost_usd) : null,
    latencyMs: Number(row.latency_ms),
    status: row.status as UsageEvent["status"],
    error: row.error != null ? String(row.error) : null,
    meta: row.meta_json ? (JSON.parse(String(row.meta_json)) as Record<string, unknown>) : null,
    createdAt: String(row.created_at),
  };
}
