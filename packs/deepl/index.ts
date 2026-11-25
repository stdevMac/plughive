// packs/deepl/index.ts
//
// text.translate through DeepL. https://developers.deepl.com/api-reference/translate
// POST /v2/translate with `Authorization: DeepL-Auth-Key <key>` and a JSON body.
// Free keys end in ":fx" and use api-free.deepl.com; Pro keys use api.deepl.com.
//
// Input mapping: target_language -> target_lang (uppercase; bare "en" and "pt"
// become EN-US and PT-PT because DeepL refuses the bare codes as targets),
// source_language -> source_lang (base code only: DeepL takes no variant
// there), formality more/less -> prefer_more/prefer_less (the prefer_ forms
// fall back silently for languages without formality instead of failing),
// model -> model_type (quality_optimized, prefer_quality_optimized,
// latency_optimized).
import { CapabilityError, type PackContext, definePack, defineProvider } from "plughive/pack";

export const PROVIDER_ID = "deepl";
export const PROVIDER_PRIORITY = 60;
const SECRET = "DEEPL_API_KEY";
const URL_PRO = "https://api.deepl.com/v2/translate";
const URL_FREE = "https://api-free.deepl.com/v2/translate";
const MODEL_TYPES = ["quality_optimized", "prefer_quality_optimized", "latency_optimized"] as const;
const FORMALITY = { default: "default", more: "prefer_more", less: "prefer_less" } as const;
/** DeepL's request size limit. */
const MAX_BODY_BYTES = 128 * 1024;
// API Pro: $25 per 1,000,000 characters of source text, plus a $5.49 monthly
// base fee that is not per call, https://www.deepl.com/en/pro-api (2026-11).
// The text's UTF-16 length is counted: never below DeepL's character count.
export const PRICE_PER_MILLION_CHARS_USD = 25;
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_ERROR_CHARS = 200;

const unsupported = (what: string) =>
  new CapabilityError(`DeepL cannot do ${what}.`, { retryable: true, code: "UNSUPPORTED_OPTION" });

/** DeepL target code: EN-GB/PT-BR style variants kept, bare en/pt defaulted. */
export function targetLang(code: string): string {
  const [base = "", variant] = code.split(/[-_]/);
  const b = base.toUpperCase();
  if (variant) return `${b}-${variant.toUpperCase()}`;
  if (b === "EN") return "EN-US";
  if (b === "PT") return "PT-PT";
  return b;
}

export const endpointFor = (key: string) => (key.trim().endsWith(":fx") ? URL_FREE : URL_PRO);

export const provider = defineProvider({
  id: PROVIDER_ID,
  capability: "text.translate",
  priority: PROVIDER_PRIORITY,
  setupHint: `set ${SECRET} (https://www.deepl.com/your-account/keys)`,
  isConfigured: (ctx) => ctx.secrets.has(SECRET),
  models: () => MODEL_TYPES,
  estimate: (input) => estimate(input.text),
  async run(input, ctx) {
    if (input.model !== undefined && !(MODEL_TYPES as readonly string[]).includes(input.model)) {
      throw unsupported(`model "${input.model}" (${MODEL_TYPES.join(", ")})`);
    }
    const key = await apiKey(ctx);
    const body: Record<string, unknown> = {
      text: [input.text],
      target_lang: targetLang(input.target_language),
    };
    if (input.source_language) {
      body.source_lang = (input.source_language.split(/[-_]/)[0] ?? "").toUpperCase();
    }
    if (input.formality) body.formality = FORMALITY[input.formality];
    if (input.model) body.model_type = input.model;
    const json = JSON.stringify(body);
    if (Buffer.byteLength(json) > MAX_BODY_BYTES) throw unsupported("texts over 128 KiB");
    const res = await ctx.fetch(endpointFor(key), {
      method: "POST",
      headers: {
        Authorization: `DeepL-Auth-Key ${key.trim()}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: json,
    });
    if (!res.ok) throw await httpError(res, key);
    const j = await readJson(res);
    const first = (Array.isArray(j.translations) ? j.translations[0] : undefined) as
      | { text?: unknown; detected_source_language?: unknown; model_type_used?: unknown }
      | undefined;
    if (typeof first?.text !== "string") {
      throw new CapabilityError("DeepL returned no translation.", { code: "BAD_RESPONSE" });
    }
    return {
      text: first.text,
      provider: PROVIDER_ID,
      ...(typeof first.detected_source_language === "string"
        ? { detected_source_language: first.detected_source_language }
        : {}),
      ...(typeof first.model_type_used === "string" ? { model: first.model_type_used } : {}),
    };
  },
});

/** Source characters at the API Pro rate. */
export function estimate(text: string) {
  return {
    usd: Math.max(1e-6, Math.round(text.length * PRICE_PER_MILLION_CHARS_USD) / 1e6),
    basis: `static price table (2026-11): ${text.length} chars at $25/M`,
  };
}

async function apiKey(ctx: PackContext): Promise<string> {
  if (!(await ctx.secrets.has(SECRET))) {
    throw new CapabilityError(`DeepL is not set up: ${SECRET} is missing.`, {
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
    throw new CapabilityError("DeepL returned a response that is not JSON.", {
      code: "BAD_RESPONSE",
    });
  }
}

/**
 * A failed DeepL response as a CapabilityError: DeepL's own message (key
 * redacted, single line, capped). 401/403, 429 and 529 (too many requests),
 * 456 (quota exceeded) and 5xx are retryable: nothing was translated or billed.
 */
export async function httpError(res: Response, key: string): Promise<CapabilityError> {
  const s = res.status;
  const message = await errorMessage(res, key);
  const retryAfter = Number(res.headers.get("retry-after"));
  const limited = s === 429 || s === 529;
  return new CapabilityError(`DeepL ${s}${message ? `: ${message}` : ""}`, {
    retryable: s === 401 || s === 403 || s === 456 || limited || s >= 500,
    status: s,
    code: limited
      ? "RATE_LIMITED"
      : s === 456
        ? "QUOTA_EXCEEDED"
        : s === 401 || s === 403
          ? "AUTH_FAILED"
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
      const m = j.message ?? j.detail;
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
