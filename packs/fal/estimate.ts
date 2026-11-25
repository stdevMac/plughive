// Cost estimates for the fal capability providers, from fal's own price API
// (GET /v1/models/pricing, cached with the catalog). A price is a unit price
// and a unit ("image", "second", "megapixel", ...); the estimate multiplies it
// by how many units this call will use. When that count cannot be known before
// the call (minutes of an uploaded recording, megapixels of an upscale), the
// estimate is null: "cost unknown", which a max_cost_usd limit refuses.

import type { PackContext } from "plughive/pack";
import type { Price } from "./client.js";
import { SECRET, runtimeOf } from "./runtime.js";

export interface Estimate {
  usd: number;
  basis: string;
}

/** What the call is known to produce, in the units fal prices by. */
export interface Quantity {
  /** Images, videos, clips or other outputs the call makes. */
  outputs?: number;
  /** Length of the output in seconds, when the call sets or implies it. */
  seconds?: number;
  /** Characters of input text (speech). */
  characters?: number;
}

/** One model's price from the cache or fal, or null when there is no key or no price. */
export async function priceOf(ctx: PackContext, model: string): Promise<Price | null> {
  if (!(await ctx.secrets.has(SECRET).catch(() => false))) return null;
  try {
    const rt = runtimeOf(ctx);
    const key = await ctx.secrets.get(SECRET);
    const { value } = await rt.cache.through(`price:${model}`, async () =>
      Object.fromEntries(await rt.client(ctx.fetch).pricing([model], key, ctx.signal)),
    );
    const p = (value as Record<string, Price>)[model];
    return p && typeof p.unit_price === "number" && p.unit_price >= 0 ? p : null;
  } catch {
    return null;
  }
}

/** How many priced units the call uses, or null when the unit is unknown or uncountable. */
export function unitsFor(unit: string, q: Quantity): number | null {
  const u = unit
    .trim()
    .toLowerCase()
    .replace(/^per\s+/, "");
  const outputs = q.outputs ?? 1;
  if (/^(request|call|run|generation|job)s?$/.test(u)) return 1;
  if (/^(image|video|clip|output|audio|file|model|mesh|asset)s?$/.test(u)) return outputs;
  if (/^(second|sec|s)s?( of (video|audio|output))?$/.test(u) || /^(video|audio) seconds?$/.test(u))
    return q.seconds !== undefined ? q.seconds * outputs : null;
  if (/^(minute|min)s?( of (video|audio|output))?$/.test(u) || /^(video|audio) minutes?$/.test(u))
    return q.seconds !== undefined ? (q.seconds / 60) * outputs : null;
  const k = /^(1000|1k|thousand) char(acter)?s?$/.test(u);
  if (k) return q.characters !== undefined ? q.characters / 1000 : null;
  if (/^char(acter)?s?$/.test(u)) return q.characters ?? null;
  // Megapixels, compute seconds and anything else depend on things we cannot
  // see before the call.
  return null;
}

/** Price × units, or null. Only USD prices are used. */
export async function estimateFor(
  ctx: PackContext,
  model: string,
  q: Quantity,
): Promise<Estimate | null> {
  const p = await priceOf(ctx, model);
  if (!p || p.currency.toUpperCase() !== "USD") return null;
  const units = unitsFor(p.unit, q);
  if (units === null || !Number.isFinite(units)) return null;
  const usd = Math.round(p.unit_price * units * 1e6) / 1e6;
  return { usd, basis: `fal price API: ${p.unit_price} USD per ${p.unit} (${model})` };
}
