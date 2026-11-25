// packs/seo/client.ts
//
// DataForSEO API v3 client. https://docs.dataforseo.com
// Auth: HTTP Basic with `login:password` (the API password from
// app.dataforseo.com > API Access, not the account password).
//
// All endpoints take an array of tasks (we wrap singletons). "/live" endpoints
// are synchronous and billed per task, so requests go through paid-http.ts:
// retried only on a 429 with a short Retry-After or a failure before the
// request was sent, never on a 5xx or timeout (that could bill twice). The
// fetch and the credentials are injected: this file never touches the network
// or the environment on its own.
import type { PackFetch } from "plughive/pack";
import { type Billing, meteredRequest } from "./paid-http.js";

export interface SerpReq {
  keyword: string;
  location_name?: string;
  location_code?: number;
  language_name?: string;
  language_code?: string;
  device?: "desktop" | "mobile";
  depth?: number;
}

export interface KeywordsVolumeReq {
  keywords: string[];
  location_code?: number;
  language_code?: string;
}

export interface KeywordsForSiteReq {
  target: string;
  location_code?: number;
  language_code?: string;
  limit?: number;
}

export interface BacklinksReq {
  target: string;
  limit?: number;
  internal_list_limit?: number;
  backlinks_status_type?: "live" | "all";
  mode?: "as_is" | "one_per_domain" | "one_per_anchor";
}

export interface OnPageReq {
  url: string;
  enable_javascript?: boolean;
  custom_user_agent?: string;
}

export type DataForSEOResponse = Record<string, unknown>;

export interface DataForSEOOpts {
  retryBaseMs?: number;
  /** Attempts for free endpoints (every endpoint used here is paid; see paid-http.ts). */
  maxAttempts?: number;
  baseUrl?: string;
  /** The tool call's signal: cancels the request and any retry wait. */
  signal?: AbortSignal;
  /** Per request. Default 120 s (live SERP and on-page calls can be slow). */
  timeoutMs?: number;
}

const BASE = "https://api.dataforseo.com";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Every endpoint this client calls, classified by billing. All of them are
 * DataForSEO "live"/instant endpoints, which charge per task as soon as the
 * task is accepted, so none is retried after the request was sent.
 */
export const DATAFORSEO_BILLING = {
  "/v3/serp/google/organic/live/regular": "paid",
  "/v3/keywords_data/google_ads/search_volume/live": "paid",
  "/v3/keywords_data/google_ads/keywords_for_site/live": "paid",
  "/v3/backlinks/summary/live": "paid",
  "/v3/backlinks/backlinks/live": "paid",
  "/v3/on_page/instant_pages": "paid",
} as const satisfies Record<string, Billing>;
type DataForSEOPath = keyof typeof DATAFORSEO_BILLING;

export class DataForSEOClient {
  private readonly auth: string;
  private readonly baseUrl: string;
  private readonly retryBaseMs: number;
  private readonly maxAttempts: number;
  private readonly signal: AbortSignal | undefined;
  private readonly timeoutMs: number;

  constructor(
    private readonly fetchFn: PackFetch,
    login: string,
    password: string,
    opts: DataForSEOOpts = {},
  ) {
    this.auth = `Basic ${Buffer.from(`${login}:${password}`).toString("base64")}`;
    this.baseUrl = opts.baseUrl ?? BASE;
    this.retryBaseMs = opts.retryBaseMs ?? 500;
    this.maxAttempts = opts.maxAttempts ?? 3;
    this.signal = opts.signal;
    this.timeoutMs = opts.timeoutMs ?? 120_000;
  }

  serpGoogleOrganicLive(req: SerpReq): Promise<DataForSEOResponse> {
    return this.post("/v3/serp/google/organic/live/regular", [
      pruneUndefined({
        keyword: req.keyword,
        location_name: req.location_name ?? "United States",
        language_name: req.language_name ?? "English",
        location_code: req.location_code,
        language_code: req.language_code,
        device: req.device,
        depth: req.depth ?? 20,
      }),
    ]);
  }

  keywordsSearchVolumeLive(req: KeywordsVolumeReq): Promise<DataForSEOResponse> {
    return this.post("/v3/keywords_data/google_ads/search_volume/live", [
      pruneUndefined({
        keywords: req.keywords,
        location_code: req.location_code ?? 2840, // United States
        language_code: req.language_code ?? "en",
      }),
    ]);
  }

  keywordsForSiteLive(req: KeywordsForSiteReq): Promise<DataForSEOResponse> {
    return this.post("/v3/keywords_data/google_ads/keywords_for_site/live", [
      pruneUndefined({
        target: req.target,
        location_code: req.location_code ?? 2840,
        language_code: req.language_code ?? "en",
        limit: req.limit ?? 100,
      }),
    ]);
  }

  backlinksSummaryLive(req: BacklinksReq): Promise<DataForSEOResponse> {
    return this.post("/v3/backlinks/summary/live", [
      pruneUndefined({
        target: req.target,
        internal_list_limit: req.internal_list_limit ?? 10,
        backlinks_status_type: req.backlinks_status_type ?? "live",
      }),
    ]);
  }

  backlinksListLive(req: BacklinksReq): Promise<DataForSEOResponse> {
    return this.post("/v3/backlinks/backlinks/live", [
      pruneUndefined({
        target: req.target,
        mode: req.mode ?? "as_is",
        limit: req.limit ?? 100,
        backlinks_status_type: req.backlinks_status_type ?? "live",
      }),
    ]);
  }

  onPageInstant(req: OnPageReq): Promise<DataForSEOResponse> {
    return this.post("/v3/on_page/instant_pages", [
      pruneUndefined({
        url: req.url,
        enable_javascript: req.enable_javascript ?? true,
        custom_user_agent: req.custom_user_agent,
      }),
    ]);
  }

  private async post(path: DataForSEOPath, payload: unknown): Promise<DataForSEOResponse> {
    const res = await meteredRequest({
      fetch: this.fetchFn,
      url: this.baseUrl + path,
      method: "POST",
      headers: {
        Authorization: this.auth,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(payload),
      billing: DATAFORSEO_BILLING[path],
      label: "DataForSEO",
      endpoint: path,
      ...(this.signal ? { signal: this.signal } : {}),
      timeoutMs: this.timeoutMs,
      maxBytes: MAX_RESPONSE_BYTES,
      retryBaseMs: this.retryBaseMs,
      maxAttempts: this.maxAttempts,
    });
    let body: DataForSEOResponse;
    try {
      const parsed: unknown = JSON.parse(res.text);
      body = parsed && typeof parsed === "object" ? (parsed as DataForSEOResponse) : {};
    } catch {
      throw new Error(`DataForSEO ${path} returned a response that is not JSON`);
    }
    // DataForSEO wraps everything in { status_code, status_message, tasks }.
    // Status codes >= 40000 are errors even on HTTP 200, at the top level and
    // per task (a task-level error otherwise reads as an empty result).
    const code = body.status_code;
    if (typeof code === "number" && code >= 40000) {
      throw new Error(`DataForSEO ${code}: ${oneLine(body.status_message)}`);
    }
    const task = Array.isArray(body.tasks) ? (body.tasks[0] as Record<string, unknown>) : null;
    const taskCode = task?.status_code;
    if (typeof taskCode === "number" && taskCode >= 40000) {
      throw new Error(`DataForSEO task ${taskCode}: ${oneLine(task?.status_message)}`);
    }
    return body;
  }
}

function oneLine(v: unknown): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening control chars
  const s = (typeof v === "string" ? v : "error").replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return s.length > 200 ? `${s.slice(0, 200)}…` : s;
}

function pruneUndefined<T extends Record<string, unknown>>(obj: T): T {
  for (const k of Object.keys(obj)) {
    if (obj[k] === undefined) delete obj[k];
  }
  return obj;
}
