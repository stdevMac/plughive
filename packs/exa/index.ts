// packs/exa/index.ts
//
// web.search through Exa. https://docs.exa.ai/reference/search
// POST https://api.exa.ai/search with `x-api-key`. Results carry highlight
// snippets (contents.highlights) and costDollars.total.
//
// Input mapping: max_results -> numResults, include/exclude_domains ->
// includeDomains/excludeDomains, recency -> startPublishedDate (now minus the
// window), country -> userLocation, model -> type (auto, lite, deep-lite, deep).
import { CapabilityError, type PackContext, definePack, defineProvider } from "plughive/pack";

export const PROVIDER_ID = "exa";
export const PROVIDER_PRIORITY = 50;
const SECRET = "EXA_API_KEY";
const URL_SEARCH = "https://api.exa.ai/search";
const TYPES = ["auto", "lite", "deep-lite", "deep"] as const;
const RECENCY_DAYS = { day: 1, week: 7, month: 31, year: 365 } as const;
const SNIPPET_CHARS = 600;
// Pay-as-you-go prices, https://exa.ai/pricing (2026-11): a search per type
// with up to 10 results, $0.001 per result above 10, and $0.001 per page of
// highlights (every result carries them here).
export const PRICE_PER_SEARCH_USD: Record<(typeof TYPES)[number], number> = {
  lite: 0.004,
  auto: 0.007,
  "deep-lite": 0.012,
  deep: 0.012,
};
const INCLUDED_RESULTS = 10;
const PRICE_PER_EXTRA_RESULT_USD = 0.001;
const PRICE_PER_HIGHLIGHTS_PAGE_USD = 0.001;
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_ERROR_CHARS = 200;

interface ExaResult {
  title?: unknown;
  url?: unknown;
  publishedDate?: unknown;
  highlights?: unknown;
  summary?: unknown;
  text?: unknown;
}

export const provider = defineProvider({
  id: PROVIDER_ID,
  capability: "web.search",
  priority: PROVIDER_PRIORITY,
  setupHint: `set ${SECRET} (https://dashboard.exa.ai/api-keys)`,
  isConfigured: (ctx) => ctx.secrets.has(SECRET),
  models: () => TYPES,
  estimate: (input) => estimate(input.model, input.max_results),
  async run(input, ctx) {
    const type = input.model ?? "auto";
    if (!(TYPES as readonly string[]).includes(type)) {
      throw new CapabilityError(`Exa has no search type "${type}" (${TYPES.join(", ")}).`, {
        retryable: true,
        code: "UNSUPPORTED_OPTION",
      });
    }
    const key = await apiKey(ctx);
    const body: Record<string, unknown> = {
      query: input.query,
      type,
      numResults: input.max_results ?? 10,
      contents: { highlights: { maxCharacters: SNIPPET_CHARS } },
    };
    if (input.include_domains?.length) body.includeDomains = input.include_domains;
    if (input.exclude_domains?.length) body.excludeDomains = input.exclude_domains;
    if (input.recency) {
      body.startPublishedDate = new Date(
        Date.now() - RECENCY_DAYS[input.recency] * 86_400_000,
      ).toISOString();
    }
    if (input.country) body.userLocation = input.country.toUpperCase();
    const res = await ctx.fetch(URL_SEARCH, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await httpError(res, key);
    const j = (await readJson(res)) as { results?: unknown; costDollars?: { total?: unknown } };
    const rows = Array.isArray(j.results) ? (j.results as ExaResult[]) : [];
    const results = rows
      .filter((r) => typeof r?.url === "string" && r.url.length > 0)
      .map((r) => {
        const snippet = snippetOf(r);
        return {
          title: typeof r.title === "string" && r.title ? r.title : String(r.url),
          url: String(r.url),
          ...(snippet ? { snippet } : {}),
          ...(typeof r.publishedDate === "string" ? { published_at: r.publishedDate } : {}),
        };
      });
    const total = j.costDollars?.total;
    return {
      results,
      provider: PROVIDER_ID,
      model: type,
      ...(typeof total === "number" && Number.isFinite(total) ? { cost_usd: total } : {}),
    };
  },
});

/**
 * Upper bound for one search: the type's price, extra results and highlights
 * on every result. An unknown type (refused by run) is priced as deep.
 */
export function estimate(model: string | undefined, maxResults: number | undefined) {
  const type = (
    model && model in PRICE_PER_SEARCH_USD ? model : model ? "deep" : "auto"
  ) as (typeof TYPES)[number];
  const n = maxResults ?? 10;
  const usd =
    PRICE_PER_SEARCH_USD[type] +
    Math.max(0, n - INCLUDED_RESULTS) * PRICE_PER_EXTRA_RESULT_USD +
    n * PRICE_PER_HIGHLIGHTS_PAGE_USD;
  return {
    usd: Math.round(usd * 1e6) / 1e6,
    basis: `static price table (2026-11): ${type} search, ${n} results with highlights`,
  };
}

function snippetOf(r: ExaResult): string | undefined {
  if (Array.isArray(r.highlights)) {
    const h = r.highlights.filter((x): x is string => typeof x === "string" && x.trim() !== "");
    if (h.length) return h.join(" ... ").slice(0, SNIPPET_CHARS * 2);
  }
  if (typeof r.summary === "string" && r.summary) return r.summary;
  if (typeof r.text === "string" && r.text) return r.text.slice(0, SNIPPET_CHARS);
  return undefined;
}

async function apiKey(ctx: PackContext): Promise<string> {
  if (!(await ctx.secrets.has(SECRET))) {
    throw new CapabilityError(`Exa is not set up: ${SECRET} is missing.`, {
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
    throw new CapabilityError("Exa returned a response that is not JSON.", {
      code: "BAD_RESPONSE",
    });
  }
}

/**
 * A failed Exa response as a CapabilityError: Exa's own message (key redacted,
 * single line, capped). 401/403/429/5xx are retryable: a search that failed
 * that way returned nothing and is not billed.
 */
export async function httpError(res: Response, key: string): Promise<CapabilityError> {
  const s = res.status;
  const message = await errorMessage(res, key);
  const retryAfter = Number(res.headers.get("retry-after"));
  return new CapabilityError(`Exa ${s}${message ? `: ${message}` : ""}`, {
    retryable: s === 401 || s === 403 || s === 429 || s >= 500,
    status: s,
    code: s === 429 ? "RATE_LIMITED" : s === 401 || s === 403 ? "AUTH_FAILED" : "PROVIDER_ERROR",
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
  });
}

async function errorMessage(res: Response, key: string): Promise<string> {
  let message = "";
  try {
    const text = await readCappedText(res, MAX_ERROR_BYTES);
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const e = j.error as { message?: unknown } | string | undefined;
      const m = typeof e === "string" ? e : (e?.message ?? j.message ?? j.detail);
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
