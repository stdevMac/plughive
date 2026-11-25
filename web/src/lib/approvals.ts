// Spend caps and approvals: the shapes of /api/approvals and /api/policy, and
// the pure helpers the Approvals page and the Usage cap editor use.
import { t } from "../i18n";

export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "consumed";

export interface ApprovalView {
  id: string;
  kind: "tool" | "provider" | "workflow";
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
  url: string;
}

export interface ApprovalsResponse {
  ok: true;
  approvals: ApprovalView[];
  pending: number;
}

/** The "approval" event on /api/events. */
export interface ApprovalEvent {
  id: string;
  status: ApprovalStatus;
  tool: string;
  pending: number;
}

export type CapScope = "global" | "provider" | "profile";
export type CapPeriod = "daily" | "monthly";
export type CapMode = "block" | "ask";

export interface Cap {
  scope: CapScope;
  id?: string;
  period: CapPeriod;
  limit_usd: number;
  mode: CapMode;
}

/** policy.json as the daemon reads it (defaults filled in). */
export interface Policy {
  version: 1;
  caps: Cap[];
  rules: {
    auto_approve_under_usd: number | null;
    always_ask_tools: string[];
    always_ask_providers: string[];
    ask_before_destructive: boolean;
    ask_before_sending: boolean;
    approve_in_chat: boolean;
  };
  profiles: Record<string, unknown>;
  approval_ttl_minutes: number;
  telegram: { enabled: boolean; allowed_chat_ids: string[] };
}

export interface CapStatus {
  cap: Cap;
  since: string;
  /** Null: the ledger could not be read, so the cap counts as used up. */
  spent_usd: number | null;
  remaining_usd: number;
}

export interface PolicyReport {
  ok: true;
  valid: boolean;
  exists: boolean;
  error?: string;
  policy: Policy;
  caps: CapStatus[];
}

export const MAX_POLICY_USD = 1_000_000;
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

const STATUS_KEY: Record<ApprovalStatus, string> = {
  pending: "approvals.status.pending",
  approved: "approvals.status.approved",
  denied: "approvals.status.denied",
  expired: "approvals.status.expired",
  consumed: "approvals.status.consumed",
};

/** The label of an approval status in the current language. */
export function statusLabel(s: ApprovalStatus): string {
  return t(STATUS_KEY[s]);
}

export function statusTone(s: ApprovalStatus): "ok" | "warn" | "danger" | "accent" | "neutral" {
  if (s === "pending") return "warn";
  if (s === "approved") return "accent";
  if (s === "consumed") return "ok";
  if (s === "denied") return "danger";
  return "neutral";
}

/** "Daily, all providers", "Monthly, provider fal", "Daily, profile work". */
export function capLabel(cap: Cap): string {
  const period =
    cap.period === "daily" ? t("approvals.cap.period.daily") : t("approvals.cap.period.monthly");
  if (cap.scope === "global") return t("approvals.cap.global", { period });
  const scope =
    cap.scope === "provider" ? t("approvals.cap.scope.provider") : t("approvals.cap.scope.profile");
  return t("approvals.cap.scoped", { period, scope, id: cap.id ?? "?" });
}

export interface CapProgress {
  /** 0 to 100, for the bar width. */
  pct: number;
  tone: "ok" | "warn" | "danger";
  /** Spent at or over the limit (or the ledger could not be read). */
  reached: boolean;
}

/** How full a cap is: warn from 80%, danger once reached. */
export function capProgress(s: CapStatus): CapProgress {
  if (s.spent_usd === null) return { pct: 100, tone: "danger", reached: true };
  const limit = s.cap.limit_usd;
  const reached = s.spent_usd >= limit;
  const ratio = limit > 0 ? s.spent_usd / limit : reached ? 1 : 0;
  const pct = Math.max(0, Math.min(100, ratio * 100));
  return { pct, tone: reached ? "danger" : ratio >= 0.8 ? "warn" : "ok", reached };
}

/** A dollar amount typed by a person ("2", "$1.50", "0.25"); null when it is not one. */
export function parseUsd(text: string): number | null {
  const t = text.trim().replace(/^\$/, "").trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) && v >= 0 && v <= MAX_POLICY_USD ? v : null;
}

/** One editable row of the cap editor (the limit kept as typed). */
export interface CapDraft {
  scope: CapScope;
  id: string;
  period: CapPeriod;
  limit: string;
  mode: CapMode;
}

export function toDraft(cap: Cap): CapDraft {
  return {
    scope: cap.scope,
    id: cap.id ?? "",
    period: cap.period,
    limit: String(cap.limit_usd),
    mode: cap.mode,
  };
}

/**
 * The caps the drafts describe, or the first problem with them (a missing
 * id, a limit that is not an amount, the same cap twice).
 */
export function capsFromDrafts(
  drafts: CapDraft[],
): { caps: Cap[]; error: null } | { caps: null; error: string } {
  const caps: Cap[] = [];
  const seen = new Set<string>();
  for (const [i, d] of drafts.entries()) {
    const n = i + 1;
    const limit = parseUsd(d.limit);
    if (limit === null)
      return {
        caps: null,
        error: t("approvals.caps.limitError", { n }),
      };
    const id = d.id.trim();
    if (d.scope !== "global" && !ID_RE.test(id)) {
      return {
        caps: null,
        error: t("approvals.caps.scopeError", {
          n,
          scope:
            d.scope === "provider"
              ? t("approvals.cap.scope.provider")
              : t("approvals.cap.scope.profile"),
        }),
      };
    }
    const key = `${d.scope}|${d.scope === "global" ? "" : id}|${d.period}`;
    if (seen.has(key))
      return {
        caps: null,
        error: t("approvals.caps.duplicateError", { n }),
      };
    seen.add(key);
    caps.push(
      d.scope === "global"
        ? { scope: d.scope, period: d.period, limit_usd: limit, mode: d.mode }
        : { scope: d.scope, id, period: d.period, limit_usd: limit, mode: d.mode },
    );
  }
  return { caps, error: null };
}

/** The policy to PUT: the edited caps, every other field kept as it was. */
export function withCaps(policy: Policy, caps: Cap[]): Policy {
  return { ...policy, caps };
}

/** Pending count after an event: the event carries the daemon's count. */
export function pendingAfter(prev: number, e: Partial<ApprovalEvent>): number {
  return typeof e.pending === "number" && e.pending >= 0 ? e.pending : prev;
}
