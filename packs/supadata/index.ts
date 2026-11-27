// packs/supadata/index.ts
//
// media.transcript through Supadata. https://docs.supadata.ai
// GET https://api.supadata.ai/v1/transcript?url=... with `x-api-key`.
// 200 returns the transcript; 202 returns {jobId} for a long or generated
// transcript, polled at GET /v1/transcript/{jobId} until completed or failed;
// 206 means no transcript is available for the video.
//
// Input mapping: language -> lang (base code, lowercase), timestamps ->
// text=false (segments with offset/duration in ms, returned in seconds),
// model -> mode (native, auto, generate; Supadata's default is auto).
import { CapabilityError, type PackContext, definePack, defineProvider } from "plughive/pack";

export const PROVIDER_ID = "supadata";
export const PROVIDER_PRIORITY = 50;
const SECRET = "SUPADATA_API_KEY";
const URL_TRANSCRIPT = "https://api.supadata.ai/v1/transcript";
const MODES = ["auto", "native", "generate"] as const;
export const POLL = { intervalMs: 3000, timeoutMs: 10 * 60 * 1000, maxTransientFailures: 3 };
// Credits, https://supadata.ai/pricing (2026-11): a native transcript is 1
// credit, an AI-generated one 2 credits per minute. Supadata sells credits
// only in plans; the dearest credit is the Basic plan's ($60 a year for 300 a
// month, $0.0167), so a credit is priced at $0.017. auto falls back to
// generating, so it is priced as generate. The video's length is unknown
// before the call, so an auto or generate call has no estimate (null: "cost
// unknown", which a max_cost_usd limit refuses) rather than a guessed one.
export const PRICE_PER_CREDIT_USD = 0.017;
const MAX_ERROR_BYTES = 16 * 1024;
/** Most of a successful JSON response that is read; a larger one is refused. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_CHARS = 200;

interface Chunk {
  text?: unknown;
  offset?: unknown;
  duration?: unknown;
}

export const provider = defineProvider({
  id: PROVIDER_ID,
  capability: "media.transcript",
  priority: PROVIDER_PRIORITY,
  setupHint: `set ${SECRET} (https://dash.supadata.ai)`,
  isConfigured: (ctx) => ctx.secrets.has(SECRET),
  models: () => MODES,
  estimate: (input) => estimate(input.model),
  async run(input, ctx) {
    if (input.model !== undefined && !(MODES as readonly string[]).includes(input.model)) {
      throw new CapabilityError(`Supadata has no mode "${input.model}" (${MODES.join(", ")}).`, {
        retryable: true,
        code: "UNSUPPORTED_OPTION",
      });
    }
    const key = await apiKey(ctx);
    const params = new URLSearchParams({
      url: input.url,
      text: input.timestamps ? "false" : "true",
    });
    if (input.language) params.set("lang", (input.language.split(/[-_]/)[0] ?? "").toLowerCase());
    if (input.model) params.set("mode", input.model);
    const headers = { "x-api-key": key, Accept: "application/json" };
    const res = await ctx.fetch(`${URL_TRANSCRIPT}?${params}`, { method: "GET", headers });
    if (res.status === 206) throw unavailable(await errorMessage(res, key));
    if (!res.ok) throw await httpError(res, key);
    let j = await readJson(res);
    if (res.status === 202) {
      const jobId = j.jobId;
      // The id goes into a URL path and into error messages: printable ASCII only.
      if (typeof jobId !== "string" || !/^[\x21-\x7e]{1,200}$/.test(jobId)) {
        throw new CapabilityError("Supadata accepted the request but returned no job id.", {
          code: "BAD_RESPONSE",
        });
      }
      j = await poll(jobId, headers, key, ctx);
    }
    return normalize(j, input.model);
  },
});

/** Native: 1 credit. auto or generate: an assumed 30-minute video generated. */
export function estimate(model: string | undefined): { usd: number; basis: string } | null {
  if (model === "native") {
    return {
      usd: PRICE_PER_CREDIT_USD,
      basis: "static price table (2026-11): 1 credit, upper plan rate",
    };
  }
  return null;
}

function normalize(j: Record<string, unknown>, model: string | undefined) {
  const lang = typeof j.lang === "string" && j.lang ? { language: j.lang } : {};
  const m = { provider: PROVIDER_ID, ...(model ? { model } : {}) };
  if (typeof j.content === "string") return { text: j.content.trim(), ...lang, ...m };
  if (!Array.isArray(j.content)) {
    throw new CapabilityError("Supadata returned no transcript content.", { code: "BAD_RESPONSE" });
  }
  const segments = (j.content as Chunk[])
    .filter((c) => typeof c?.text === "string")
    .map((c) => {
      const start = typeof c.offset === "number" ? c.offset / 1000 : undefined;
      const end =
        start !== undefined && typeof c.duration === "number"
          ? (Number(c.offset) + c.duration) / 1000
          : undefined;
      return {
        ...(start !== undefined ? { start } : {}),
        ...(end !== undefined ? { end } : {}),
        text: String(c.text),
      };
    });
  const text = segments
    .map((s) => s.text.trim())
    .filter(Boolean)
    .join(" ");
  return { text, segments, ...lang, ...m };
}

/** Poll an accepted job. Failures from here on are not retryable: the job was accepted. */
async function poll(
  jobId: string,
  headers: Record<string, string>,
  key: string,
  ctx: PackContext,
): Promise<Record<string, unknown>> {
  const url = `${URL_TRANSCRIPT}/${encodeURIComponent(jobId)}`;
  const started = Date.now();
  let failures = 0;
  for (;;) {
    if (Date.now() - started > POLL.timeoutMs) {
      throw new CapabilityError(`Supadata job ${jobId} did not finish in time.`, {
        code: "TIMEOUT",
        mayHaveCharged: true,
      });
    }
    await sleep(POLL.intervalMs, ctx.signal);
    let res: Response;
    try {
      res = await ctx.fetch(url, { method: "GET", headers });
    } catch (err) {
      if (ctx.signal.aborted) throw err;
      if (++failures > POLL.maxTransientFailures) throw err;
      continue;
    }
    if (res.status === 429 || res.status >= 500) {
      await res.body?.cancel().catch(() => {});
      if (++failures > POLL.maxTransientFailures) {
        throw new CapabilityError(`Supadata ${res.status} while polling job ${jobId}.`, {
          status: res.status,
          code: "PROVIDER_ERROR",
          mayHaveCharged: true,
        });
      }
      continue;
    }
    if (!res.ok) {
      const e = await httpError(res, key);
      throw new CapabilityError(e.message, {
        status: res.status,
        code: "PROVIDER_ERROR",
        mayHaveCharged: true,
      });
    }
    failures = 0;
    const j = await readJson(res);
    const status = j.status;
    if (status === "completed") return j;
    if (status === "failed") {
      const e = j.error as { message?: unknown } | string | undefined;
      const m = typeof e === "string" ? e : e?.message;
      throw new CapabilityError(
        `Supadata job failed${typeof m === "string" && m ? `: ${redact(m, key)}` : "."}`,
        { code: "JOB_FAILED", mayHaveCharged: true },
      );
    }
    ctx.progress(
      Math.min(0.9, (Date.now() - started) / POLL.timeoutMs),
      `Supadata: ${String(status ?? "queued")}`,
    );
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

const unavailable = (message: string) =>
  new CapabilityError(
    `Supadata has no transcript for this video${message ? `: ${message}` : "."}`,
    {
      retryable: true,
      status: 206,
      code: "TRANSCRIPT_UNAVAILABLE",
    },
  );

async function apiKey(ctx: PackContext): Promise<string> {
  if (!(await ctx.secrets.has(SECRET))) {
    throw new CapabilityError(`Supadata is not set up: ${SECRET} is missing.`, {
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
      `Supadata sent a response larger than ${MAX_JSON_BYTES / 1024 / 1024} MB; it was not read.`,
      { code: "BAD_RESPONSE" },
    );
  }
  let j: unknown;
  try {
    j = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CapabilityError("Supadata returned a response that is not JSON.", {
      code: "BAD_RESPONSE",
    });
  }
  return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
}

/**
 * A failed Supadata response as a CapabilityError: Supadata's own message
 * (key redacted, single line, capped). 401/402 (plan limit)/403/429/5xx are
 * retryable: such a request was not accepted.
 */
export async function httpError(res: Response, key: string): Promise<CapabilityError> {
  const s = res.status;
  const message = await errorMessage(res, key);
  const retryAfter = Number(res.headers.get("retry-after"));
  return new CapabilityError(`Supadata ${s}${message ? `: ${message}` : ""}`, {
    retryable: s === 401 || s === 402 || s === 403 || s === 429 || s >= 500,
    status: s,
    code:
      s === 429
        ? "RATE_LIMITED"
        : s === 401 || s === 403
          ? "AUTH_FAILED"
          : s === 402
            ? "QUOTA_EXCEEDED"
            : "PROVIDER_ERROR",
    ...(Number.isFinite(retryAfter) && retryAfter > 0 ? { retryAfterMs: retryAfter * 1000 } : {}),
  });
}

async function errorMessage(res: Response, key: string): Promise<string> {
  let message = "";
  try {
    const text = await readCappedText(res, MAX_ERROR_BYTES);
    try {
      const j = JSON.parse(text) as Record<string, unknown>;
      const m = j.message ?? j.details ?? j.error;
      message = typeof m === "string" ? m : "";
    } catch {
      message = text;
    }
  } catch {
    // unreadable body: the status alone
  }
  return redact(message, key);
}

function redact(raw: string, key: string): string {
  let message = key ? raw.split(key).join("[key]") : raw;
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
