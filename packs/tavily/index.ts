// packs/tavily/index.ts
//
// web.search through Tavily.
// https://docs.tavily.com/documentation/api-reference/endpoint/search
// POST https://api.tavily.com/search with `Authorization: Bearer <key>`.
//
// Input mapping: max_results -> max_results (Tavily allows at most 20, so
// larger asks are clamped), include/exclude_domains -> include_domains /
// exclude_domains, recency -> time_range, model -> search_depth (basic,
// advanced, fast, ultra-fast), country -> country. Tavily wants a lowercase
// English country name ("united states"), not an ISO code, and only uses it to
// boost results from that country; the code is turned into the name here.
import { CapabilityError, type PackContext, definePack, defineProvider } from "plughive/pack";

export const PROVIDER_ID = "tavily";
export const PROVIDER_PRIORITY = 48;
const SECRET = "TAVILY_API_KEY";
const URL_SEARCH = "https://api.tavily.com/search";
const DEPTHS = ["basic", "advanced", "fast", "ultra-fast"] as const;
const MAX_RESULTS = 20;
// Pay-as-you-go $0.008 per credit, https://docs.tavily.com/documentation/api-credits
// (2026-11); credits per search from the search_depth docs (2026-11): basic,
// fast and ultra-fast 1, advanced 2. The result count does not change it.
export const PRICE_PER_CREDIT_USD = 0.008;
const CREDITS: Record<(typeof DEPTHS)[number], number> = {
  basic: 1,
  advanced: 2,
  fast: 1,
  "ultra-fast": 1,
};
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_ERROR_CHARS = 200;

interface TavilyResult {
  title?: unknown;
  url?: unknown;
  content?: unknown;
  published_date?: unknown;
  score?: unknown;
}

export const provider = defineProvider({
  id: PROVIDER_ID,
  capability: "web.search",
  priority: PROVIDER_PRIORITY,
  setupHint: `set ${SECRET} (https://app.tavily.com)`,
  isConfigured: (ctx) => ctx.secrets.has(SECRET),
  models: () => DEPTHS,
  estimate: (input) => estimate(input.model),
  async run(input, ctx) {
    const depth = input.model ?? "basic";
    if (!(DEPTHS as readonly string[]).includes(depth)) {
      throw new CapabilityError(`Tavily has no search depth "${depth}" (${DEPTHS.join(", ")}).`, {
        retryable: true,
        code: "UNSUPPORTED_OPTION",
      });
    }
    const key = await apiKey(ctx);
    const body: Record<string, unknown> = {
      query: input.query,
      search_depth: depth,
      max_results: Math.min(input.max_results ?? 10, MAX_RESULTS),
      include_published_date: true,
    };
    if (input.include_domains?.length) body.include_domains = input.include_domains;
    if (input.exclude_domains?.length) body.exclude_domains = input.exclude_domains;
    if (input.recency) body.time_range = input.recency;
    const country = countryName(input.country);
    if (country) body.country = country;
    const res = await ctx.fetch(URL_SEARCH, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await httpError(res, key);
    const j = await readJson(res);
    const rows = Array.isArray(j.results) ? (j.results as TavilyResult[]) : [];
    const results = rows
      .filter((r) => typeof r?.url === "string" && r.url.length > 0)
      .map((r) => ({
        title: typeof r.title === "string" && r.title ? r.title : String(r.url),
        url: String(r.url),
        ...(typeof r.content === "string" && r.content ? { snippet: r.content } : {}),
        ...(typeof r.published_date === "string" ? { published_at: r.published_date } : {}),
        ...(typeof r.score === "number" ? { score: r.score } : {}),
      }));
    return { results, provider: PROVIDER_ID, model: depth };
  },
});

/** One search at its depth's credits; an unknown depth (refused by run) as advanced. */
export function estimate(model: string | undefined) {
  const depth = (model ?? "basic") as (typeof DEPTHS)[number];
  const credits = CREDITS[depth] ?? CREDITS.advanced;
  return {
    usd: Math.round(credits * PRICE_PER_CREDIT_USD * 1e6) / 1e6,
    basis: `static price table (2026-11): ${credits} credit${credits === 1 ? "" : "s"} at $${PRICE_PER_CREDIT_USD}`,
  };
}

const REGION_NAMES = new Intl.DisplayNames(["en"], { type: "region", fallback: "none" });

/** ISO 3166-1 alpha-2 code to the lowercase English name Tavily expects, or undefined. */
export function countryName(code: string | undefined): string | undefined {
  if (!code || !/^[A-Za-z]{2}$/.test(code)) return undefined;
  try {
    const name = REGION_NAMES.of(code.toUpperCase())?.toLowerCase();
    return name && name !== "unknown region" ? name : undefined;
  } catch {
    return undefined;
  }
}

async function apiKey(ctx: PackContext): Promise<string> {
  if (!(await ctx.secrets.has(SECRET))) {
    throw new CapabilityError(`Tavily is not set up: ${SECRET} is missing.`, {
      retryable: true,
      code: "NOT_CONFIGURED",
    });
  }
  return ctx.secrets.get(SECRET);
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const j = await res.json();
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  } catch {
    throw new CapabilityError("Tavily returned a response that is not JSON.", {
      code: "BAD_RESPONSE",
    });
  }
}

/**
 * A failed Tavily response as a CapabilityError: Tavily's own message (key
 * redacted, single line, capped). 401/403/429/432/433 (plan or usage limit)
 * and 5xx are retryable: such a search returned nothing.
 */
export async function httpError(res: Response, key: string): Promise<CapabilityError> {
  const s = res.status;
  const message = await errorMessage(res, key);
  const retryAfter = Number(res.headers.get("retry-after"));
  const limit = s === 429 || s === 432 || s === 433;
  return new CapabilityError(`Tavily ${s}${message ? `: ${message}` : ""}`, {
    retryable: s === 401 || s === 403 || limit || s >= 500,
    status: s,
    code: limit ? "RATE_LIMITED" : s === 401 || s === 403 ? "AUTH_FAILED" : "PROVIDER_ERROR",
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
  });
}

async function errorMessage(res: Response, key: string): Promise<string> {
  let message = "";
  try {
    const text = await readCappedText(res, MAX_ERROR_BYTES);
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const d = j.detail as { error?: unknown } | string | undefined;
      const e = j.error as { message?: unknown } | string | undefined;
      const m =
        typeof d === "string"
          ? d
          : (d?.error ?? (typeof e === "string" ? e : (e?.message ?? j.message)));
      message = typeof m === "string" ? m : "";
    } catch {
      message = text;
    }
  } catch {
    // unreadable body: the status alone
  }
  if (key) message = message.split(key).join("[key]");
  message = message
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return message.length > MAX_ERROR_CHARS ? `${message.slice(0, MAX_ERROR_CHARS)}...` : message;
}

async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
    total += Math.min(value.byteLength, room);
    if (total >= maxBytes) {
      await reader.cancel().catch(() => {});
      break;
    }
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export default definePack({ providers: [provider] });
