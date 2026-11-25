// Usage: time ranges and the per-day series the chart draws.
import type { UsageResponse } from "./types";

export type Range = "today" | "7d" | "30d" | "all";

const DAY = 86_400_000;

/** The `since` value for a range; days are UTC because the ledger groups by UTC day. */
export function sinceFor(range: Range, now = Date.now()): string | undefined {
  if (range === "all") return undefined;
  const startOfToday = Math.floor(now / DAY) * DAY;
  const days = range === "today" ? 0 : range === "7d" ? 6 : 29;
  return new Date(startOfToday - days * DAY).toISOString();
}

export interface DayPoint {
  day: string;
  calls: number;
  errors: number;
  cost: number;
}

/**
 * One point per day from the start of the range to today, gaps filled with
 * zero. `provider` narrows to one provider. For "all" the series starts at the
 * first day with data and is capped at `maxDays`.
 */
export function daySeries(
  rows: UsageResponse["by_provider_day"],
  range: Range,
  opts: { provider?: string | null; now?: number; maxDays?: number } = {},
): DayPoint[] {
  const now = opts.now ?? Date.now();
  const maxDays = opts.maxDays ?? 90;
  const byDay = new Map<string, DayPoint>();
  for (const r of rows) {
    if (opts.provider && r.provider !== opts.provider) continue;
    const p = byDay.get(r.day) ?? { day: r.day, calls: 0, errors: 0, cost: 0 };
    p.calls += r.calls;
    p.errors += r.errors;
    p.cost += r.cost_usd ?? 0;
    byDay.set(r.day, p);
  }
  const today = Math.floor(now / DAY) * DAY;
  let start: number;
  const since = sinceFor(range, now);
  if (since) start = Date.parse(since);
  else {
    const first = [...byDay.keys()].sort()[0];
    start = first ? Date.parse(`${first}T00:00:00Z`) : today;
  }
  start = Math.max(start, today - (maxDays - 1) * DAY);
  const out: DayPoint[] = [];
  for (let t = start; t <= today; t += DAY) {
    const day = new Date(t).toISOString().slice(0, 10);
    out.push(byDay.get(day) ?? { day, calls: 0, errors: 0, cost: 0 });
  }
  return out;
}

/** Totals per provider over the rows, largest spend first. */
export function providerTotals(
  rows: UsageResponse["by_provider_day"],
): Array<{ provider: string; calls: number; errors: number; cost: number }> {
  const m = new Map<string, { provider: string; calls: number; errors: number; cost: number }>();
  for (const r of rows) {
    const p = m.get(r.provider) ?? { provider: r.provider, calls: 0, errors: 0, cost: 0 };
    p.calls += r.calls;
    p.errors += r.errors;
    p.cost += r.cost_usd ?? 0;
    m.set(r.provider, p);
  }
  return [...m.values()].sort((a, b) => b.cost - a.cost || b.calls - a.calls);
}

/** A rounded top for a chart axis: 1, 2 or 5 times a power of ten. */
export function niceMax(v: number): number {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 5, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
