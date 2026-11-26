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
  /** Most bytes a finished crawl may add up to across its `next` pages. Default 64 MiB. */
  maxCrawlBytes?: number;
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
/** Most bytes a crawl result may add up to across all its `next` pages. */
const MAX_CRAWL_BYTES = 64 * 1024 * 1024;

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
  private readonly maxCrawlBytes: number;

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
    this.maxCrawlBytes = opts.maxCrawlBytes ?? MAX_CRAWL_BYTES;
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
    const path = `/v2/crawl/${encodeURIComponent(jobId)}`;
    const firstRes = await this.requestSized("GET", path, "/v2/crawl/:id");
    const first = firstRes.out as CrawlStatusResp;
    if (first.status !== "completed") return first;
    const data = Array.isArray(first.data) ? [...first.data] : [];
    let total = firstRes.bytes;
    let next = typeof first.next === "string" ? first.next : null;
    const origin = new URL(this.baseUrl).origin;
    const seen = new Set<string>();
    for (let page = 0; next && page < MAX_CRAWL_PAGES; page++) {
      let u: URL;
      try {
        u = new URL(next);
      } catch {
        break;
      }
      // Only further pages of this same job, each fetched once.
      if (u.origin !== origin || u.pathname !== path || seen.has(u.search)) break;
      seen.add(u.search);
      const more = await this.requestSized(
        "GET",
        u.pathname + u.search,
        "/v2/crawl/:id (next page)",
      );
      total += more.bytes;
      if (total > this.maxCrawlBytes) {
        throw new Error(
          `Firecrawl crawl ${jobId}: the result is over ${this.maxCrawlBytes} bytes; crawl fewer pages (limit) or narrow include_paths`,
        );
      }
      const body = more.out as CrawlStatusResp;
      if (Array.isArray(body.data)) data.push(...body.data);
      next = typeof body.next === "string" ? body.next : null;
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
    return (await this.requestSized(method, path, endpoint, body)).out;
  }

  /** A request, with the size of the body it answered. */
  private async requestSized(
    method: "GET" | "POST",
    path: string,
    endpoint: string,
    body?: string,
  ): Promise<{ out: Record<string, unknown>; bytes: number }> {
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
    return { out, bytes: Buffer.byteLength(res.text, "utf8") };
  }
}

function oneLine(v: unknown): string {
  if (typeof v !== "string") return "";
  // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening control chars
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}
