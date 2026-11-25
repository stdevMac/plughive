// src/core/policy/spend.ts
//
// Spend so far against each cap, from the usage ledger (an indexed SUM over
// the cap's period). Amounts are what the ledger recorded: providers that do
// not report a cost count as zero, so caps are as exact as the costs behind
// them.
import type { SpendQuery } from "../../lib/usage.js";
import { type Cap, type Policy, periodStart } from "./policy.js";

export interface SpendSource {
  spent(q: SpendQuery): number;
}

export interface CapStatus {
  cap: Cap;
  since: string;
  spent_usd: number;
  remaining_usd: number;
}

export function capStatus(cap: Cap, source: SpendSource, now: number): CapStatus {
  const since = periodStart(cap.period, now);
  const q: SpendQuery = { since };
  if (cap.scope === "provider" && cap.id) q.provider = cap.id;
  if (cap.scope === "profile" && cap.id) q.profile = cap.id;
  let spent = 0;
  try {
    spent = source.spent(q);
  } catch {
    // The ledger cannot be read: count the cap as used up (fail closed).
    spent = Number.POSITIVE_INFINITY;
  }
  const spentUsd = Number.isFinite(spent) ? Math.round(spent * 1e6) / 1e6 : spent;
  return {
    cap,
    since,
    spent_usd: spentUsd,
    remaining_usd: Math.max(0, cap.limit_usd - spentUsd),
  };
}

/** The caps that apply to a call: global ones, the provider's, the profile's. */
export function capsFor(
  policy: Policy,
  target: { provider?: string | null; profile: string },
): Cap[] {
  return policy.caps.filter(
    (c) =>
      c.scope === "global" ||
      (c.scope === "provider" && target.provider != null && c.id === target.provider) ||
      (c.scope === "profile" && c.id === target.profile),
  );
}

/**
 * Whether a call would go over the cap: the estimate does not fit in what is
 * left. With no estimate, only a cap already used up counts.
 */
export function overCap(status: CapStatus, estimateUsd: number | null): boolean {
  if (status.spent_usd >= status.cap.limit_usd) return true;
  return estimateUsd !== null && status.spent_usd + estimateUsd > status.cap.limit_usd;
}

export function describeCap(cap: Cap): string {
  const who = cap.scope === "global" ? "global" : `${cap.scope} "${cap.id}"`;
  return `the ${cap.period} ${who} cap of $${cap.limit_usd}`;
}
