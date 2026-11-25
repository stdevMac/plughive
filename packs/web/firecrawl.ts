// packs/web/firecrawl.ts
//
// Firecrawl v2 API client. https://docs.firecrawl.dev
// Auth: Authorization: Bearer {key}. JSON in/out. The fetch and the key are
// injected, so this file never touches the network or the environment itself.
// Requests go through paid-http.ts: credit-consuming calls are never retried
// after they were sent (a 5xx or timeout may still have been billed).
import type { PackFetch } from "plughive/pack";
import { type Billing, meteredRequest } from "./paid-http.js";

export interface FirecrawlOpts {
  retryBaseMs?: number;
  /** Attempts for free endpoints (crawl status). Paid endpoints: see paid-http.ts. */
  maxAttempts?: number;
  baseUrl?: string;
  /** The tool call's signal: cancels the request and any retry wait. */
  signal?: AbortSignal;
  /** Per request. Default 360 s (a scrape may itself wait up to 300 s). */
  timeoutMs?: number;
}

export interface ScrapeReq {
  url: string;
  formats?: Array<"markdown" | "html" | "rawHtml" | "links" | "screenshot" | "json">;
  onlyMainContent?: boolean;
  waitFor?: number;
  timeout?: number;
  includeTags?: string[];
  excludeTags?: string[];
}

export interface FirecrawlDocument {
  markdown?: string;
  html?: string;
  rawHtml?: string;
  links?: string[];
  screenshot?: string;
  json?: unknown;
  metadata?: {
    title?: string;
    description?: string;
    sourceURL?: string;
    statusCode?: number;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface SearchReq {
  query: string;
  limit?: number;
  sources?: Array<"web" | "news" | "images">;
  location?: string;
  tbs?: string;
  /** ISO country code (Firecrawl's default is US). */
  country?: string;
  /** Hostnames to search within. Firecrawl refuses it together with excludeDomains. */
  includeDomains?: string[];
  excludeDomains?: string[];
}

export interface SearchResult {
  url?: string;
  title?: string;
  description?: string;
  [k: string]: unknown;
}

export interface SearchResp {
  /** Credits Firecrawl billed for the call (top-level `creditsUsed`), when it says. */
  creditsUsed?: number;
  web?: SearchResult[];
  news?: SearchResult[];
  images?: SearchResult[];
}

export interface MapReq {
  url: string;
  limit?: number;
  search?: string;
}

export interface CrawlReq {
  url: string;
  limit?: number;
  maxDepth?: number;
  includePaths?: string[];
  excludePaths?: string[];
  scrapeOptions?: { formats?: string[]; onlyMainContent?: boolean };
}

export interface CrawlStatusResp {
  status: "scraping" | "completed" | "failed" | string;
  total?: number;
  completed?: number;
  data?: FirecrawlDocument[];
  error?: string;
  next?: string;
  [k: string]: unknown;
}

const BASE = "https://api.firecrawl.dev";
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_CRAWL_PAGES = 50;

/**
 * Every POST endpoint this client calls, classified by billing. Scrape,
 * search, map and crawl submission all consume Firecrawl credits, so none is
 * retried after the request was sent. Crawl status (GET) is free.
 */
export const FIRECRAWL_BILLING = {
  "/v2/scrape": "paid",
  "/v2/search": "paid",
  "/v2/map": "paid",
  "/v2/crawl": "paid",
} as const satisfies Record<string, Billing>;
type FirecrawlPath = keyof typeof FIRECRAWL_BILLING;

export class FirecrawlClient {
  private readonly baseUrl: string;
  private readonly retryBaseMs: number;
  private readonly maxAttempts: number;
  private readonly signal: AbortSignal | undefined;
  private readonly timeoutMs: number;

  constructor(
    private readonly fetchFn: PackFetch,
    private readonly apiKey: string,
    opts: FirecrawlOpts = {},
  ) {
    this.baseUrl = opts.baseUrl ?? BASE;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.signal = opts.signal;
    this.timeoutMs = opts.timeoutMs ?? 360_000;
  }

  async scrape(req: ScrapeReq): Promise<FirecrawlDocument> {
    const body = await this.post("/v2/scrape", req);
    return (body.data ?? {}) as FirecrawlDocument;
  }

  async search(req: SearchReq): Promise<SearchResp> {
    const body = await this.post("/v2/search", req);
    const data = (body.data ?? {}) as SearchResp;
    const credits = body.creditsUsed;
    return typeof credits === "number" && Number.isFinite(credits)
      ? { ...data, creditsUsed: credits }
      : data;
  }

  async map(req: MapReq): Promise<{ links: string[] }> {
    const body = await this.post("/v2/map", req);
    // /v2/map returns { success, links } at top level. Each link may be a plain
    // string or an object like { url, title, description } depending on options.
    const data = body.data as { links?: unknown[] } | undefined;
    const raw: unknown[] = (Array.isArray(body.links) ? body.links : data?.links) ?? [];
    const links = raw.map((l) => {
      if (typeof l === "string") return l;
      if (l && typeof l === "object" && "url" in l) return String((l as { url: unknown }).url);
      return String(l);
    });
    return { links };
  }

  /** POST /v2/crawl: submits a crawl job. Returns the job id (poll with crawlStatus). */
  async submitCrawl(req: CrawlReq): Promise<{ id: string; url?: string }> {
    const body = await this.post("/v2/crawl", req);
    return { id: body.id as string, url: body.url as string | undefined };
  }

  /**
   * GET /v2/crawl/:id: current crawl state. When the finished result is
   * larger than one response, Firecrawl returns a `next` URL; those pages are
   * followed (same origin as the API only, so the key never leaves it) and
   * their documents appended. Free: polling does not consume credits.
   */
  async crawlStatus(jobId: string): Promise<CrawlStatusResp> {
    const first = (await this.request(
      "GET",
      `/v2/crawl/${encodeURIComponent(jobId)}`,
      "/v2/crawl/:id",
    )) as CrawlStatusResp;
    if (first.status !== "completed") return first;
    const data = Array.isArray(first.data) ? [...first.data] : [];
    let next = typeof first.next === "string" ? first.next : null;
    const origin = new URL(this.baseUrl).origin;
    for (let page = 0; next && page < MAX_CRAWL_PAGES; page++) {
      let u: URL;
      try {
        u = new URL(next);
      } catch {
        break;
      }
      if (u.origin !== origin) break;
      const more = (await this.request(
        "GET",
        u.pathname + u.search,
        "/v2/crawl/:id (next page)",
      )) as CrawlStatusResp;
      if (Array.isArray(more.data)) data.push(...more.data);
      next = typeof more.next === "string" ? more.next : null;
    }
    return { ...first, data, next: next ?? undefined };
  }

  private post(path: FirecrawlPath, payload: unknown): Promise<Record<string, unknown>> {
    return this.request("POST", path, path, JSON.stringify(payload));
  }

  private async request(
    method: "GET" | "POST",
    path: string,
    endpoint: string,
    body?: string,
  ): Promise<Record<string, unknown>> {
    const billing: Billing =
      method === "GET" ? "free" : FIRECRAWL_BILLING[endpoint as FirecrawlPath];
    const res = await meteredRequest({
      fetch: this.fetchFn,
      url: this.baseUrl + path,
      method,
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body } : {}),
      billing,
      label: "Firecrawl",
      endpoint,
      ...(this.signal ? { signal: this.signal } : {}),
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      retryBaseMs: this.retryBaseMs,
      maxAttempts: this.maxAttempts,
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.text);
    } catch {
      throw new Error(`Firecrawl ${endpoint} returned a response that is not JSON`);
    }
    const out = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    if (out.success === false) {
      throw new Error(`Firecrawl ${endpoint}: ${oneLine(out.error) || "request failed"}`);
    }
    return out;
  }
}

function oneLine(v: unknown): string {
  if (typeof v !== "string") return "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening control chars
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}
