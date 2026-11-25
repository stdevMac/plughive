// paid-http.ts
//
// One HTTP exchange with a metered API, retried only when a retry cannot
// charge twice. Shared by packs/{growth,seo,web}: the three copies are kept
// byte-identical (packs cannot import each other), enforced by
// tests/packs/paid-http.test.ts.
//
// Every endpoint is classified by the caller:
//  - "paid": the request may consume credits. It is retried only when the
//    provider provably did not process it: an HTTP 429 that carries a bounded
//    Retry-After, or a failure before the request left this machine (DNS,
//    connection refused, host unreachable). A 5xx, a timeout or a dropped
//    connection after the request was sent is NOT retried: the provider may
//    already have done (and billed) the work. The error says so.
//  - "free": read-only or unmetered. Retried with backoff on 429, 5xx and
//    network errors, up to `maxAttempts`.
// The caller's signal cancels both the request and any backoff sleep, and
// every attempt carries a timeout. Response bodies are read with a byte cap,
// and error messages carry the provider's short error field, never the raw
// body (which may hold personal data about the person being looked up).
import type { PackFetch } from "plughive/pack";

export type Billing = "paid" | "free";

export interface MeteredRequest {
  fetch: PackFetch;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  billing: Billing;
  /** Provider name used in error messages ("Apollo", "DataForSEO", ...). */
  label: string;
  /** Path or endpoint name used in error messages (never includes secrets). */
  endpoint: string;
  signal?: AbortSignal;
  /** Per attempt, headers and body included. Default 60000. */
  timeoutMs?: number;
  /** Largest response body read. Default 8 MiB. */
  maxBytes?: number;
  /** Attempts for free endpoints (paid endpoints get at most 2). Default 3. */
  maxAttempts?: number;
  /** First backoff delay for free endpoints. Default 500 ms. */
  retryBaseMs?: number;
  /** Longest Retry-After honoured. Default 30 s; longer waits fail instead. */
  maxRetryAfterMs?: number;
}

export interface MeteredResponse {
  status: number;
  headers: Headers;
  text: string;
}

/** A failed metered call. `mayHaveCharged` is true when a retry could bill twice. */
export class MeteredHttpError extends Error {
  readonly status: number | null;
  readonly mayHaveCharged: boolean;
  readonly retryable = false;
  constructor(message: string, opts: { status: number | null; mayHaveCharged: boolean }) {
    super(message);
    this.name = "MeteredHttpError";
    this.status = opts.status;
    this.mayHaveCharged = opts.mayHaveCharged;
  }
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const PAID_MAX_ATTEMPTS = 2;

/** Error codes that mean the request never reached the provider. */
const PRE_DISPATCH_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export function isPreDispatchFailure(err: unknown, depth = 0): boolean {
  if (!err || typeof err !== "object" || depth > 4) return false;
  const e = err as { code?: unknown; reason?: unknown; cause?: unknown };
  if (typeof e.code === "string" && PRE_DISPATCH_CODES.has(e.code)) return true;
  // The daemon's safe-fetch refuses before connecting when DNS fails.
  if (e.reason === "dns_failure") return true;
  return isPreDispatchFailure(e.cause, depth + 1);
}

/** Retry-After in ms (delta-seconds or HTTP date), or null when absent/invalid. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const v = value.trim();
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  // An HTTP-date always names a day/month ("Wed, 21 Oct 2015 07:28:00 GMT");
  // without this, Date.parse would read "-5" or "2" as a year.
  if (!/[A-Za-z]/.test(v)) return null;
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function abortError(signal: AbortSignal): Error {
  const r = signal.reason;
  return r instanceof Error ? r : new Error("the request was cancelled");
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal as AbortSignal));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Read a body up to `max` bytes; past that the stream is cancelled and this throws. */
export async function readCappedText(res: Response, max: number, label: string): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new MeteredHttpError(`${label} response is larger than ${max} bytes`, {
      status: res.status,
      mayHaveCharged: false,
    });
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new MeteredHttpError(`${label} response is larger than ${max} bytes`, {
        status: res.status,
        mayHaveCharged: false,
      });
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * The provider's own short error text (an `error`/`message` style field),
 * on one line and capped. Never the raw body.
 */
export function shortError(text: string, max = 160): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "";
  }
  if (!parsed || typeof parsed !== "object") return "";
  const o = parsed as Record<string, unknown>;
  for (const k of ["error", "message", "status_message", "detail", "error_message"]) {
    const v = o[k];
    const s =
      typeof v === "string"
        ? v
        : v && typeof v === "object" && typeof (v as { message?: unknown }).message === "string"
          ? ((v as { message: string }).message as string)
          : null;
    if (s) {
      // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening control chars
      const one = s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
      return one.length > max ? `${one.slice(0, max)}…` : one;
    }
  }
  return "";
}

const CHARGE_NOTE =
  "The request may already have been processed and charged, so it was not repeated automatically. " +
  "Check the provider's usage or results before running it again.";

/** One metered request with the retry policy described at the top of this file. */
export async function meteredRequest(req: MeteredRequest): Promise<MeteredResponse> {
  const paid = req.billing === "paid";
  const maxAttempts = paid ? PAID_MAX_ATTEMPTS : Math.max(1, Math.min(req.maxAttempts ?? 3, 5));
  const base = req.retryBaseMs ?? 500;
  const maxRetryAfter = req.maxRetryAfterMs ?? 30_000;
  const maxBytes = req.maxBytes ?? DEFAULT_MAX_BYTES;
  const where = `${req.label} ${req.endpoint}`;
  const backoff = (attempt: number) => base * 2 ** (attempt - 1);

  for (let attempt = 1; ; attempt++) {
    if (req.signal?.aborted) throw abortError(req.signal);
    const last = attempt >= maxAttempts;
    let res: Response;
    try {
      res = await req.fetch(req.url, {
        method: req.method ?? "POST",
        ...(req.headers ? { headers: req.headers } : {}),
        ...(req.body !== undefined ? { body: req.body } : {}),
        ...(req.signal ? { signal: req.signal } : {}),
        timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });
    } catch (e) {
      if (req.signal?.aborted) throw abortError(req.signal);
      const pre = isPreDispatchFailure(e);
      if (!last && (pre || !paid)) {
        await sleep(backoff(attempt), req.signal);
        continue;
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new MeteredHttpError(
        paid && !pre
          ? `${where} failed after the request was sent (${msg}). ${CHARGE_NOTE}`
          : `${where} failed: ${msg}`,
        { status: null, mayHaveCharged: paid && !pre },
      );
    }

    if (res.status >= 200 && res.status < 300) {
      return {
        status: res.status,
        headers: res.headers,
        text: await readCappedText(res, maxBytes, where),
      };
    }

    // Error bodies are small; read a little for the provider's error field.
    let text = "";
    try {
      text = await readCappedText(res, 64 * 1024, where);
    } catch {
      text = "";
    }
    const detail = shortError(text);
    const suffix = detail ? `: ${detail}` : "";

    if (res.status === 429) {
      const ra = parseRetryAfter(res.headers.get("retry-after"));
      if (!last && ra !== null && ra <= maxRetryAfter) {
        await sleep(ra, req.signal);
        continue;
      }
      if (!last && !paid) {
        await sleep(backoff(attempt), req.signal);
        continue;
      }
      throw new MeteredHttpError(
        `${where} was rate limited (429)${suffix}.${ra !== null ? ` Retry after about ${Math.ceil(ra / 1000)} s.` : ""}`,
        { status: 429, mayHaveCharged: false },
      );
    }
    if (res.status >= 500) {
      if (!last && !paid) {
        await sleep(backoff(attempt), req.signal);
        continue;
      }
      throw new MeteredHttpError(
        paid
          ? `${where} returned ${res.status}${suffix}. ${CHARGE_NOTE}`
          : `${where} returned ${res.status}${suffix}`,
        { status: res.status, mayHaveCharged: paid },
      );
    }
    throw new MeteredHttpError(`${where} returned ${res.status}${suffix}`, {
      status: res.status,
      mayHaveCharged: false,
    });
  }
}
