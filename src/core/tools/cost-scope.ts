// src/core/tools/cost-scope.ts
//
// Keeps one dollar from being written to the usage ledger twice.
//
// A tool call can run a capability provider (or another tool), and the cost
// the provider reports usually travels back up in each result. The capability
// router records the cost on its own row (provider, model). The registry then
// records, for the calling tool, only what was NOT already written by
// something it ran. The running total travels in an AsyncLocalStorage, so no
// signature carries it.
import { AsyncLocalStorage } from "node:async_hooks";

interface CostScope {
  /** Dollars already written to the ledger by calls made inside this scope. */
  accounted: number;
}

const storage = new AsyncLocalStorage<CostScope>();

/** Run `fn` in a fresh scope and report what was accounted for while it ran. */
export async function withCostScope<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; accounted: number }> {
  const scope: CostScope = { accounted: 0 };
  const value = await storage.run(scope, fn);
  return { value, accounted: scope.accounted };
}

/** Same, for a call that may throw: the accounted total survives the failure. */
export async function settleCostScope<T>(
  fn: () => Promise<T>,
): Promise<
  { ok: true; value: T; accounted: number } | { ok: false; error: unknown; accounted: number }
> {
  const scope: CostScope = { accounted: 0 };
  try {
    const value = await storage.run(scope, fn);
    return { ok: true, value, accounted: scope.accounted };
  } catch (error) {
    return { ok: false, error, accounted: scope.accounted };
  }
}

/** Note that `usd` was written to the ledger for the call running right now. */
export function addAccountedCost(usd: number | null | undefined): void {
  if (typeof usd !== "number" || !Number.isFinite(usd) || usd <= 0) return;
  const scope = storage.getStore();
  if (scope) scope.accounted += usd;
}

/** What is left to record for a call that reports `reported` in its result. */
export function unaccountedCost(reported: number | null, accounted: number): number | null {
  if (reported === null || !Number.isFinite(reported)) return null;
  const rest = reported - accounted;
  // Float noise from summing provider costs is not a charge.
  return rest > 1e-9 ? rest : null;
}
