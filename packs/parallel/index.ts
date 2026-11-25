// packs/parallel/index.ts
//
// web.search through the Parallel.ai Search API.
// https://docs.parallel.ai/api-reference/search-beta/search
// POST https://api.parallel.ai/v1/search with `x-api-key`.
//
// Input mapping: query -> objective and the single entry of search_queries
// (both are sent; search_queries is required), max_results ->
// advanced_settings.max_results, include/exclude_domains ->
// advanced_settings.source_policy.include_domains / exclude_domains, recency
// -> source_policy.after_date (YYYY-MM-DD), country -> advanced_settings.location
// (lowercase ISO 3166-1 alpha-2), model -> mode (turbo, fast, basic, advanced).
import { CapabilityError, type PackContext, definePack, defineProvider } from "plughive/pack";

export const PROVIDER_ID = "parallel";
export const PROVIDER_PRIORITY = 46;
const SECRET = "PARALLEL_API_KEY";
const URL_SEARCH = "https://api.parallel.ai/v1/search";
const MODES = ["turbo", "fast", "basic", "advanced"] as const;
const RECENCY_DAYS = { day: 1, week: 7, month: 31, year: 365 } as const;
/** Excerpts are full markdown passages: the snippet keeps the start of them. */
const SNIPPET_CHARS = 1500;
// Search API, https://docs.parallel.ai/getting-started/pricing (2026-11): per
// request with 10 results, turbo/fast $0.001, basic/advanced $0.005, plus
// $0.001 per result beyond 10. No mode sent is priced as basic (upper side).
export const PRICE_PER_SEARCH_USD: Record<(typeof MODES)[number], number> = {
  turbo: 0.001,
  fast: 0.001,
  basic: 0.005,
  advanced: 0.005,
};
const INCLUDED_RESULTS = 10;
const PRICE_PER_EXTRA_RESULT_USD = 0.001;
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_ERROR_CHARS = 200;

interface ParallelResult {
  url?: unknown;
  title?: unknown;
  publish_date?: unknown;
  excerpts?: unknown;
}

export const provider = defineProvider({
  id: PROVIDER_ID,
  capability: "web.search",
  priority: PROVIDER_PRIORITY,
  setupHint: `set ${SECRET} (https://platform.parallel.ai)`,
  isConfigured: (ctx) => ctx.secrets.has(SECRET),
  models: () => MODES,
  estimate: (input) => estimate(input.model, input.max_results),
  async run(input, ctx) {
    if (input.model !== undefined && !(MODES as readonly string[]).includes(input.model)) {
      throw new CapabilityError(
        `Parallel has no search mode "${input.model}" (${MODES.join(", ")}).`,
        {
          retryable: true,
          code: "UNSUPPORTED_OPTION",
        },
      );
    }
    const key = await apiKey(ctx);
    const sourcePolicy: Record<string, unknown> = {};
    if (input.include_domains?.length) sourcePolicy.include_domains = input.include_domains;
    if (input.exclude_domains?.length) sourcePolicy.exclude_domains = input.exclude_domains;
    if (input.recency) {
      sourcePolicy.after_date = new Date(Date.now() - RECENCY_DAYS[input.recency] * 86_400_000)
        .toISOString()
        .slice(0, 10);
    }
    const advanced: Record<string, unknown> = { max_results: input.max_results ?? 10 };
    if (Object.keys(sourcePolicy).length) advanced.source_policy = sourcePolicy;
    if (input.country) advanced.location = input.country.toLowerCase();
    const body: Record<string, unknown> = {
      objective: input.query,
      search_queries: [input.query.slice(0, 200)],
      advanced_settings: advanced,
      ...(input.model ? { mode: input.model } : {}),
    };
    const res = await ctx.fetch(URL_SEARCH, {
      method: "POST",
      headers: { "x-api-key": key, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw await httpError(res, key);
    const j = await readJson(res);
    const rows = Array.isArray(j.results) ? (j.results as ParallelResult[]) : [];
    const results = rows
      .filter((r) => typeof r?.url === "string" && r.url.length > 0)
      .map((r) => {
        const excerpts = Array.isArray(r.excerpts)
          ? r.excerpts.filter((x): x is string => typeof x === "string" && x.trim() !== "")
          : [];
        const snippet = excerpts.join("\n\n").slice(0, SNIPPET_CHARS);
        return {
          title: typeof r.title === "string" && r.title ? r.title : String(r.url),
          url: String(r.url),
          ...(snippet ? { snippet } : {}),
          ...(typeof r.publish_date === "string" ? { published_at: r.publish_date } : {}),
        };
      });
    return {
      results,
      provider: PROVIDER_ID,
      ...(input.model ? { model: input.model } : {}),
      ...(typeof j.search_id === "string" ? { search_id: j.search_id } : {}),
    };
  },
});

/** One search: the mode's price plus results beyond 10; no or unknown mode as basic. */
export function estimate(model: string | undefined, maxResults: number | undefined) {
  const mode = (model && model in PRICE_PER_SEARCH_USD ? model : "basic") as (typeof MODES)[number];
  const n = maxResults ?? 10;
  const usd =
    PRICE_PER_SEARCH_USD[mode] + Math.max(0, n - INCLUDED_RESULTS) * PRICE_PER_EXTRA_RESULT_USD;
  return {
    usd: Math.round(usd * 1e6) / 1e6,
    basis: `static price table (2026-11): ${mode} search, ${n} results`,
  };
}

async function apiKey(ctx: PackContext): Promise<string> {
  if (!(await ctx.secrets.has(SECRET))) {
    throw new CapabilityError(`Parallel is not set up: ${SECRET} is missing.`, {
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
    throw new CapabilityError("Parallel returned a response that is not JSON.", {
      code: "BAD_RESPONSE",
    });
  }
}

/**
 * A failed Parallel response as a CapabilityError: Parallel's own message
 * (key redacted, single line, capped). 401/403/429/5xx are retryable: such a
 * search returned nothing.
 */
export async function httpError(res: Response, key: string): Promise<CapabilityError> {
  const s = res.status;
  const message = await errorMessage(res, key);
  const retryAfter = Number(res.headers.get("retry-after"));
  return new CapabilityError(`Parallel ${s}${message ? `: ${message}` : ""}`, {
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
