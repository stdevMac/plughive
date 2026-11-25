// packs/openrouter/estimates.ts
//
// What a capability call will cost, before it runs (the spend policy's
// `estimate` hook), from OpenRouter's own prices: the video catalog's
// pricing_skus, else the /models row's pricing (prompt, completion,
// image_output, image_token...). Lookups go through the pack's catalog cache
// (fresh cache, then live, then stale cache or the bundled snapshot). A model
// with no usable price has no estimate (null), and so has a call whose count
// is unknown before it runs (chat output with no max_tokens, audio of unknown
// length): never an assumed default.
//
// Token counts are approximations: text is about 4 characters per token, and
// an output image is about 1290 tokens on Google models (1K), 4160 on OpenAI
// models (high quality, 1024x1024) and 1670 where OpenRouter prices
// image_token (its own per-image conversion).
import type { PackContext } from "plughive/pack";
import { CATALOG_KINDS, type ModelEntry, parseGeneralRow } from "./client.js";
import { type Json, checkArtifactId } from "./common.js";
import { runtimeOf } from "./runtime.js";

export interface Estimate {
  usd: number;
  basis: string;
}

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;
/**
 * Input tokens as an upper bound: byte-level tokenizers never make more
 * tokens than the text has UTF-8 bytes (an average is about 4 bytes per
 * token, so this is high, never low).
 */
const tokensOf = (text: string) => new TextEncoder().encode(text).length;

/** A price string as a number; null when missing, negative (OpenRouter's "-1" = varies) or not a number. */
function price(prices: Record<string, string>, key: string): number | null {
  const raw = prices[key];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

interface Priced {
  entry: ModelEntry | null;
  prices: Record<string, string>;
  source: string;
}

/**
 * The model's prices. A catalog entry (video) carries its own; image and
 * speech catalog rows carry none, so their prices come from the /models row,
 * cached as `pricing:<id>`. Null when the model or its prices are unknown, or
 * the lookup fails.
 */
async function pricesOf(ctx: PackContext, id: string): Promise<Priced | null> {
  try {
    const rt = runtimeOf(ctx);
    const found = await rt.lookup(ctx, id);
    let { entry, source } = found;
    if (!entry) return null;
    // lookup() answers from the offline copy first; a price wants the
    // current catalog (fresh cache, else live, else the stale copy).
    const kind = entry.kind;
    if (CATALOG_KINDS.includes(kind as never) && source === "snapshot") {
      const r = await rt.catalog(ctx, kind as (typeof CATALOG_KINDS)[number]);
      const hit = r.entries.find((e) => e.id === id);
      if (hit) ({ entry, source } = { entry: hit, source: r.source });
    }
    if (entry.pricing && Object.keys(entry.pricing).length > 0)
      return { entry, prices: entry.pricing, source };
    // An entry from the general list already is the /models row.
    if (!CATALOG_KINDS.includes(entry.kind as never)) return null;
    const { value, cached } = await rt.cache.through(`pricing:${id}`, async () => {
      const body = await rt.client(ctx.fetch).search({ q: id, limit: 100 }, ctx.signal);
      const rows: Json[] = Array.isArray(body?.data) ? body.data : [];
      const row = rows.find((r) => r?.id === id || r?.canonical_slug === id);
      return row ? (parseGeneralRow({ ...row, id })?.pricing ?? null) : null;
    });
    if (!value || typeof value !== "object") return null;
    return { entry, prices: value as Record<string, string>, source: cached ? "cache" : "live" };
  } catch {
    return null;
  }
}

const basisOf = (source: string, note?: string) =>
  `OpenRouter price (${source})${note ? `, ${note}` : ""}`;

/** Upper-bound tokens of one message's content; null when it holds anything but text (images, files). */
function contentTokens(content: unknown): number | null {
  if (content == null) return 0;
  if (typeof content === "string") return tokensOf(content);
  if (!Array.isArray(content)) return null;
  let n = 0;
  for (const part of content) {
    if (part?.type !== "text" || typeof part.text !== "string") return null;
    n += tokensOf(part.text);
  }
  return n;
}

/**
 * Chat: prompt tokens (UTF-8 bytes, an upper bound) plus max_tokens of output. Null
 * without max_tokens: the output length is unknown before the call.
 */
export async function estimateChat(
  model: string,
  input: { messages: { content: unknown }[]; max_tokens?: number | undefined },
  ctx: PackContext,
): Promise<Estimate | null> {
  if (input.max_tokens === undefined) return null;
  const p = await pricesOf(ctx, model);
  if (!p) return null;
  const prompt = price(p.prices, "prompt");
  const completion = price(p.prices, "completion");
  if (prompt === null || completion === null) return null;
  let inTok = 0;
  for (const m of input.messages) {
    const t = contentTokens(m.content);
    if (t === null) return null;
    inTok += t;
  }
  const outTok = input.max_tokens;
  const usd = inTok * prompt + outTok * completion + (price(p.prices, "request") ?? 0);
  return { usd: round6(usd), basis: basisOf(p.source) };
}

/** Embeddings: input tokens (UTF-8 bytes, an upper bound) at the prompt price. */
export async function estimateEmbed(
  model: string,
  texts: string[],
  ctx: PackContext,
): Promise<Estimate | null> {
  const p = await pricesOf(ctx, model);
  const prompt = p ? price(p.prices, "prompt") : null;
  if (!p || prompt === null) return null;
  const inTok = texts.reduce((n, t) => n + tokensOf(t), 0);
  return { usd: round6(inTok * prompt), basis: basisOf(p.source) };
}

/** Output tokens per image, for models priced per output token. */
function tokensPerImage(model: string, prices: Record<string, string>): number | null {
  if (price(prices, "image_token") !== null) return 1670;
  if (model.startsWith("google/")) return 1290;
  if (model.startsWith("openai/")) return 4160;
  return null;
}

/** Images: n images at the per-image price (or tokens per image x the output token price), plus the prompt. */
export async function estimateImage(
  model: string,
  input: { prompt: string; n?: number | undefined },
  ctx: PackContext,
): Promise<Estimate | null> {
  const p = await pricesOf(ctx, model);
  if (!p) return null;
  const perToken = price(p.prices, "image_token") ?? price(p.prices, "image_output");
  const per = tokensPerImage(model, p.prices);
  if (perToken === null || per === null) return null;
  const n = input.n ?? 1;
  const usd = n * per * perToken + tokensOf(input.prompt) * (price(p.prices, "prompt") ?? 0);
  return { usd: round6(usd), basis: basisOf(p.source, `~${per} tokens per image`) };
}

/** Per-second video SKUs: [prefix]base[_audio][_resolution][_audio]. */
const VIDEO_SKU =
  /^(text_to_video_|image_to_video_)?(duration_seconds|cents_per_second_output|cents_per_video_output_second)(_with_audio|_without_audio)?(?:_(\d+p|\dk))?(_with_audio|_without_audio)?$/i;

/**
 * Video: the per-second price for the asked resolution (the highest matching
 * SKU: with or without audio, whichever costs more) x the length, snapped to
 * the lengths the model allows. Token-priced models have no estimate.
 */
export async function estimateVideo(
  model: string,
  input: {
    duration_seconds?: number | undefined;
    resolution?: string | undefined;
    image_input?: string | undefined;
  },
  ctx: PackContext,
): Promise<Estimate | null> {
  const p = await pricesOf(ctx, model);
  if (!p) return null;
  const want = input.resolution?.toLowerCase();
  const skus: { res: string | null; usd: number }[] = [];
  for (const key of Object.keys(p.prices)) {
    const m = VIDEO_SKU.exec(key);
    const v = price(p.prices, key);
    if (!m || v === null) continue;
    if (m[1] === "text_to_video_" && input.image_input) continue;
    if (m[1] === "image_to_video_" && !input.image_input) continue;
    skus.push({ res: m[4]?.toLowerCase() ?? null, usd: m[2] === "duration_seconds" ? v : v / 100 });
  }
  if (skus.length === 0) return null;
  const matching = want ? skus.filter((s) => s.res === want) : [];
  const base = skus.filter((s) => s.res === null);
  const pool = matching.length > 0 ? matching : base.length > 0 ? base : skus;
  const perSecond = Math.max(...pool.map((s) => s.usd));
  const d = p.entry?.params.duration;
  const allowed =
    d?.type === "enum" ? d.values.filter((v): v is number => typeof v === "number" && v > 0) : [];
  // Without a length the model picks one: the longest it allows is the upper
  // bound, and with no list of lengths the cost is unknown.
  const asked = input.duration_seconds;
  let seconds: number;
  if (asked === undefined) {
    if (allowed.length === 0) return null;
    seconds = Math.max(...allowed);
  } else {
    seconds =
      allowed.length > 0
        ? allowed.reduce((a, b) => (Math.abs(b - asked) < Math.abs(a - asked) ? b : a))
        : asked;
  }
  let usd = perSecond * seconds;
  const imageIn = price(p.prices, "cents_per_image_input");
  if (input.image_input && imageIn !== null) usd += imageIn / 100;
  const minimum = price(p.prices, "minimum_cents_per_generation");
  if (minimum !== null) usd = Math.max(usd, minimum / 100);
  return {
    usd: round6(usd),
    basis: basisOf(
      p.source,
      asked === undefined ? `${seconds} s, the longest allowed` : `${seconds} s`,
    ),
  };
}

/** Speech: the prompt price is per input character. */
export async function estimateSpeech(
  model: string,
  text: string,
  ctx: PackContext,
): Promise<Estimate | null> {
  const p = await pricesOf(ctx, model);
  const perChar = p ? price(p.prices, "prompt") : null;
  if (!p || perChar === null) return null;
  return { usd: round6(perChar * text.length), basis: basisOf(p.source, "per character") };
}

/**
 * Transcription: the prompt price is per second of audio, from the
 * library's recorded length. Null when the file or its length is unknown.
 */
export async function estimateTranscribe(
  model: string,
  artifactId: string,
  ctx: PackContext,
): Promise<Estimate | null> {
  const p = await pricesOf(ctx, model);
  const perSecond = p ? price(p.prices, "prompt") : null;
  if (!p || perSecond === null) return null;
  let rec: Awaited<ReturnType<PackContext["library"]["get"]>>;
  try {
    rec = await ctx.library.get(checkArtifactId(artifactId));
  } catch {
    return null;
  }
  if (!rec) return null;
  const meta = rec.meta ?? {};
  const known = [meta.duration_seconds, meta.duration].find(
    (v): v is number => typeof v === "number" && v > 0,
  );
  return known === undefined ? null : { usd: round6(perSecond * known), basis: basisOf(p.source) };
}
