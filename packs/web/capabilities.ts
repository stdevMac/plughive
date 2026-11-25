// packs/web/capabilities.ts
//
// The capability providers this pack serves:
//  - firecrawl (priority 40): web.search (POST /v2/search) and web.fetch
//    (POST /v2/scrape), https://docs.firecrawl.dev/api-reference. Both calls
//    consume credits, so they go through paid-http.ts and are never repeated
//    after they were sent. A request Firecrawl refused outright (401, 402, 403,
//    429) or that never left this machine throws a retryable CapabilityError,
//    so the router tries the next provider; anything after that is final.
//  - browser (priority 10): web.fetch with the local headless Chromium, see
//    browser-fetch.ts.
// An option a provider cannot honour throws a retryable UNSUPPORTED_OPTION
// before any request.
import {
  type AnyProviderDefinition,
  CapabilityError,
  type PackContext,
  defineProvider,
} from "plughive/pack";
import {
  BROWSER_PRIORITY,
  BROWSER_PROVIDER_ID,
  BROWSER_SETUP_HINT,
  type BrowserFetchDeps,
  browserFetch,
  playwrightAvailable,
} from "./browser-fetch.js";
import { FirecrawlClient } from "./firecrawl.js";
import { MeteredHttpError } from "./paid-http.js";

export const FIRECRAWL_PROVIDER_ID = "firecrawl";
export const FIRECRAWL_PRIORITY = 40;
const SECRET = "FIRECRAWL_API_KEY";
/** Firecrawl's own query limit (POST /v2/search `query` maxLength). */
const FIRECRAWL_MAX_QUERY = 500;
const DEFAULT_MAX_CHARS = 100_000;
/**
 * Dollars per Firecrawl credit, from the Standard plan list price ($83 for
 * 100,000 credits a month). Plans differ, so costs derived from it are marked
 * `cost_estimated`; `credits_used` carries what Firecrawl actually billed.
 */
export const FIRECRAWL_USD_PER_CREDIT = 0.00083;
/** Firecrawl's published rates: scrape 1 credit a page; search 2 credits per 10 results. */
const SCRAPE_CREDITS = 1;
const searchCredits = (results: number) => 2 * Math.ceil(results / 10);

/** credits_used plus an estimated cost_usd, or nothing when the count is unknown. */
function creditCost(credits: unknown): Record<string, number | boolean> {
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return {};
  return {
    credits_used: credits,
    cost_usd: Math.round(credits * FIRECRAWL_USD_PER_CREDIT * 1e6) / 1e6,
    cost_estimated: true,
  };
}

const TBS = { day: "qdr:d", week: "qdr:w", month: "qdr:m", year: "qdr:y" } as const;

/** Test hook: the client's retry backoff (ms). */
export const firecrawlProviderHooks: { retryBaseMs?: number } = {};

const unsupported = (who: string, what: string) =>
  new CapabilityError(`${who} cannot do ${what}.`, { retryable: true, code: "UNSUPPORTED_OPTION" });

async function client(ctx: PackContext): Promise<FirecrawlClient> {
  if (!(await ctx.secrets.has(SECRET))) {
    throw new CapabilityError(`Firecrawl is not set up: ${SECRET} is missing.`, {
      retryable: true,
      code: "NOT_CONFIGURED",
    });
  }
  return new FirecrawlClient(ctx.fetch, await ctx.secrets.get(SECRET), {
    signal: ctx.signal,
    ...(firecrawlProviderHooks.retryBaseMs !== undefined
      ? { retryBaseMs: firecrawlProviderHooks.retryBaseMs }
      : {}),
  });
}

/**
 * A request Firecrawl provably did not run (refused with 401/402/403/429, or
 * never sent) becomes a retryable CapabilityError; everything else is final.
 */
async function refusedIsRetryable<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof MeteredHttpError && !e.mayHaveCharged) {
      const s = e.status;
      if (s === null || s === 401 || s === 402 || s === 403 || s === 429) {
        throw new CapabilityError(e.message, {
          retryable: true,
          ...(s !== null ? { status: s } : {}),
          code:
            s === 429
              ? "RATE_LIMITED"
              : s === 402
                ? "QUOTA_EXCEEDED"
                : s === null
                  ? "NETWORK"
                  : "AUTH_FAILED",
        });
      }
    }
    throw e;
  }
}

const firecrawlBase = {
  id: FIRECRAWL_PROVIDER_ID,
  priority: FIRECRAWL_PRIORITY,
  setupHint: `set ${SECRET} (https://www.firecrawl.dev/app/api-keys)`,
  isConfigured: (ctx: PackContext) => ctx.secrets.has(SECRET),
};

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

export function makeProviders(
  browserDeps: BrowserFetchDeps = {},
): readonly AnyProviderDefinition[] {
  const hasPlaywright = playwrightAvailable(browserDeps);
  return [
    defineProvider({
      ...firecrawlBase,
      capability: "web.search",
      estimate: (input) => ({
        usd: searchCredits(input.max_results ?? 10) * FIRECRAWL_USD_PER_CREDIT,
        basis: "static table (Firecrawl credits at the Standard plan price)",
      }),
      run: async (input, ctx) => {
        if (input.model)
          throw unsupported("Firecrawl", `a model choice ("${input.model.slice(0, 64)}")`);
        if (input.query.length > FIRECRAWL_MAX_QUERY)
          throw unsupported("Firecrawl", `a query over ${FIRECRAWL_MAX_QUERY} characters`);
        if (input.include_domains?.length && input.exclude_domains?.length)
          throw unsupported("Firecrawl", "include_domains and exclude_domains together");
        const api = await client(ctx);
        const r = await refusedIsRetryable(() =>
          api.search({
            query: input.query,
            limit: input.max_results ?? 10,
            sources: ["web"],
            ...(input.recency ? { tbs: TBS[input.recency] } : {}),
            ...(input.country ? { country: input.country.toUpperCase() } : {}),
            ...(input.include_domains?.length ? { includeDomains: input.include_domains } : {}),
            ...(input.exclude_domains?.length ? { excludeDomains: input.exclude_domains } : {}),
          }),
        );
        const results = (Array.isArray(r.web) ? r.web : []).flatMap((x) => {
          const url = str(x?.url);
          if (!url) return [];
          const snippet = str(x.description);
          return [{ title: str(x.title) ?? url, url, ...(snippet ? { snippet } : {}) }];
        });
        return { results, provider: FIRECRAWL_PROVIDER_ID, ...creditCost(r.creditsUsed) };
      },
    }),
    defineProvider({
      ...firecrawlBase,
      capability: "web.fetch",
      estimate: () => ({
        usd: SCRAPE_CREDITS * FIRECRAWL_USD_PER_CREDIT,
        basis: "static table (Firecrawl credits at the Standard plan price)",
      }),
      run: async (input, ctx) => {
        if (input.model)
          throw unsupported("Firecrawl", `a model choice ("${input.model.slice(0, 64)}")`);
        const format = input.format ?? "markdown";
        if (format === "text")
          throw unsupported("Firecrawl", "plain-text output (markdown or html)");
        const api = await client(ctx);
        const doc = await refusedIsRetryable(() =>
          api.scrape({ url: input.url, formats: [format], onlyMainContent: format === "markdown" }),
        );
        const content = format === "html" ? doc.html : doc.markdown;
        if (typeof content !== "string") {
          throw new Error(
            `Firecrawl scraped ${input.url} but returned no ${format}. The scrape was billed; check the page before trying again.`,
          );
        }
        const max = input.max_chars ?? DEFAULT_MAX_CHARS;
        const truncated = content.length > max;
        const meta = doc.metadata ?? {};
        const title = str(meta.title);
        return {
          url: str(meta.url) ?? str(meta.sourceURL) ?? input.url,
          ...(title ? { title } : {}),
          content: truncated ? content.slice(0, max) : content,
          format,
          ...(truncated ? { truncated: true } : {}),
          provider: FIRECRAWL_PROVIDER_ID,
          ...creditCost(meta.creditsUsed ?? SCRAPE_CREDITS),
        };
      },
    }),
    defineProvider({
      id: BROWSER_PROVIDER_ID,
      capability: "web.fetch",
      priority: BROWSER_PRIORITY,
      cost: "local",
      setupHint: BROWSER_SETUP_HINT,
      isConfigured: () => hasPlaywright(),
      run: (input, ctx) => browserFetch(input, ctx, browserDeps),
    }),
  ];
}

export const providers = makeProviders();
