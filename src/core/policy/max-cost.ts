// src/core/policy/max-cost.ts
//
// `max_cost_usd`: a per-call ceiling a caller may put on a media call. It is
// not part of any capability's input (and capability schemas strip unknown keys),
// so the router takes it out, rejects invalid values right away, and hands
// valid limits to the gate.
import { CapabilityError } from "../pack-api.js";

/** Largest per-call maximum accepted. */
export const MAX_COST_CEILING_USD = 10_000;

export function validMaxCost(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_COST_CEILING_USD
    ? value
    : undefined;
}

function invalidMaxCostError(): CapabilityError {
  return new CapabilityError(
    `max_cost_usd must be a finite number from 0 to ${MAX_COST_CEILING_USD}`,
    { code: "INVALID_ARGUMENTS" },
  );
}

/**
 * The capability input without `max_cost_usd`, and the effective maximum:
 * the run option when set, else the field (or the lower of the two). Any
 * invalid `max_cost_usd` value is rejected immediately so it is never silently
 * stripped by a non-strict capability schema.
 */
export function splitMaxCost(
  rawInput: unknown,
  fromOptions: number | undefined,
): { input: unknown; maxCostUsd: number | undefined } {
  let maxCostUsd: number | undefined;
  if (fromOptions !== undefined) {
    maxCostUsd = validMaxCost(fromOptions);
    if (maxCostUsd === undefined) throw invalidMaxCostError();
  }
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput)) {
    return { input: rawInput, maxCostUsd };
  }
  if (!("max_cost_usd" in rawInput)) return { input: rawInput, maxCostUsd };
  const { max_cost_usd: field, ...rest } = rawInput as Record<string, unknown>;
  if (field === undefined) return { input: rest, maxCostUsd };
  const fieldValue = validMaxCost(field);
  if (fieldValue === undefined) throw invalidMaxCostError();
  maxCostUsd = maxCostUsd === undefined ? fieldValue : Math.min(maxCostUsd, fieldValue);
  return { input: rest, maxCostUsd };
}
