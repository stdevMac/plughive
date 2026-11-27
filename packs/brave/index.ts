// packs/brave/index.ts
//
// web.search through the Brave Search API.
// https://api-dashboard.search.brave.com/app/documentation/web-search/query
// GET https://api.search.brave.com/res/v1/web/search with `X-Subscription-Token`.
//
// Input mapping: max_results -> count (Brave returns at most 20 per page, so
// larger asks are clamped), recency -> freshness (pd, pw, pm, py), country ->
// country. Domains go into the query as search operators: one include domain
// becomes `site:<domain>`, each exclude domain `NOT site:<domain>`. Brave
// documents no grouping, so several include domains throw a retryable
// UNSUPPORTED_OPTION and the router tries another provider. `model` has no
// Brave equivalent and is refused the same way.
import { CapabilityError, type PackContext, definePack, defineProvider } from "plughive/pack";

export const PROVIDER_ID = "brave";
export const PROVIDER_PRIORITY = 44;
const SECRET = "BRAVE_API_KEY";
const URL_SEARCH = "https://api.search.brave.com/res/v1/web/search";
const MAX_COUNT = 20;
const FRESHNESS = { day: "pd", week: "pw", month: "pm", year: "py" } as const;
// Search plan: $5 per 1,000 requests, any count up to 20,
// https://brave.com/search/api/ (2026-11). The monthly free credit is ignored.
export const PRICE_PER_REQUEST_USD = 0.005;
const MAX_ERROR_BYTES = 16 * 1024;
/** Most of a successful JSON response that is read; a larger one is refused. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_CHARS = 200;

interface BraveResult {
  title?: unknown;
  url?: unknown;
  description?: unknown;
  page_age?: unknown;
}

const unsupported = (what: string) =>
  new CapabilityError(`Brave Search cannot do ${what}.`, {
    retryable: true,
    code: "UNSUPPORTED_OPTION",
  });

export const provider = defineProvider({
  id: PROVIDER_ID,
  capability: "web.search",
  priority: PROVIDER_PRIORITY,
  setupHint: `set ${SECRET} (https://api-dashboard.search.brave.com/app/keys)`,
  isConfigured: (ctx) => ctx.secrets.has(SECRET),
  estimate: () => ({
    usd: PRICE_PER_REQUEST_USD,
    basis: "static price table (2026-11): $5 per 1,000 requests",
  }),
  async run(input, ctx) {
    if (input.model) throw unsupported(`model selection ("${input.model}")`);
    if ((input.include_domains?.length ?? 0) > 1) throw unsupported("more than one include domain");
    const key = await apiKey(ctx);
    const q = [
      input.query,
      ...(input.include_domains ?? []).map((d) => `site:${d}`),
      ...(input.exclude_domains ?? []).map((d) => `NOT site:${d}`),
    ].join(" ");
    const params = new URLSearchParams({
      q,
      count: String(Math.min(input.max_results ?? 10, MAX_COUNT)),
    });
    if (input.recency) params.set("freshness", FRESHNESS[input.recency]);
    if (input.country) params.set("country", input.country.toUpperCase());
    const res = await ctx.fetch(`${URL_SEARCH}?${params}`, {
      method: "GET",
      headers: { "X-Subscription-Token": key, Accept: "application/json" },
    });
    if (!res.ok) throw await httpError(res, key);
    const j = await readJson(res);
    const web = j.web as { results?: unknown } | undefined;
    const rows = Array.isArray(web?.results) ? (web.results as BraveResult[]) : [];
    const results = rows
      .filter((r) => typeof r?.url === "string" && r.url.length > 0)
      .map((r) => {
        const title = typeof r.title === "string" ? plain(r.title) : "";
        const snippet = typeof r.description === "string" ? plain(r.description) : "";
        return {
          title: title || String(r.url),
          url: String(r.url),
          ...(snippet ? { snippet } : {}),
          ...(typeof r.page_age === "string" ? { published_at: r.page_age } : {}),
        };
      });
    return { results, provider: PROVIDER_ID };
  },
});

/** Brave marks query terms with <strong> and escapes entities: return plain text. */
export function plain(s: string): string {
  return s
    .replace(/<[^>]*>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

async function apiKey(ctx: PackContext): Promise<string> {
  if (!(await ctx.secrets.has(SECRET))) {
    throw new CapabilityError(`Brave Search is not set up: ${SECRET} is missing.`, {
      retryable: true,
      code: "NOT_CONFIGURED",
    });
  }
  return ctx.secrets.get(SECRET);
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  const { bytes, truncated } = await readCapped(res, MAX_JSON_BYTES);
  if (truncated) {
    throw new CapabilityError(
      `Brave Search sent a response larger than ${MAX_JSON_BYTES / 1024 / 1024} MB; it was not read.`,
      { code: "BAD_RESPONSE" },
    );
  }
  let j: unknown;
  try {
    j = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CapabilityError("Brave Search returned a response that is not JSON.", {
      code: "BAD_RESPONSE",
    });
  }
  return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
}

/**
 * A failed Brave response as a CapabilityError: Brave's own message (key
 * redacted, single line, capped). 401/403/429/5xx are retryable: such a
 * search returned nothing.
 */
export async function httpError(res: Response, key: string): Promise<CapabilityError> {
  const s = res.status;
  const message = await errorMessage(res, key);
  const retryAfter = Number(res.headers.get("retry-after"));
  return new CapabilityError(`Brave Search ${s}${message ? `: ${message}` : ""}`, {
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
      const e = j.error as { detail?: unknown; message?: unknown } | string | undefined;
      const m = typeof e === "string" ? e : (e?.detail ?? e?.message ?? j.message);
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
  return new TextDecoder().decode((await readCapped(res, maxBytes)).bytes);
}

/** Up to `maxBytes` of a body; `truncated` when there was more (the rest is not read). */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

export default definePack({ providers: [provider] });
