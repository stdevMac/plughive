// packs/mistral/index.ts
//
// document.parse through Mistral OCR. https://docs.mistral.ai/api/endpoint/ocr
// POST https://api.mistral.ai/v1/ocr with `Authorization: Bearer <key>`. The
// library file goes inline as a base64 data URL: `document_url` for a PDF,
// `image_url` for an image. The reply holds one Markdown string per page.
//
// Input mapping: model -> model (mistral-ocr-*; default mistral-ocr-latest).
// format "markdown" is native; "text" throws a retryable UNSUPPORTED_OPTION so
// the router can pick a provider that returns plain text. The `language` hint
// is ignored: Mistral OCR detects the language itself and takes no hint.
import { CapabilityError, type PackContext, definePack, defineProvider } from "plughive/pack";

export const PROVIDER_ID = "mistral";
export const PROVIDER_PRIORITY = 50;
const SECRET = "MISTRAL_API_KEY";
const URL_OCR = "https://api.mistral.ai/v1/ocr";
const DEFAULT_MODEL = "mistral-ocr-latest";
/** Mistral's documented upload limit for OCR. */
export const MAX_BYTES = 50 * 1024 * 1024;
// OCR per page, https://docs.mistral.ai/inference/pricing (2026-11): OCR 3 is
// $2 per 1,000 pages, OCR 4.1 $4. mistral-ocr-latest may be either, so every
// model is priced at $4 (upper side).
export const PRICE_PER_PAGE_USD = 0.004;
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_ERROR_CHARS = 200;

interface OcrPage {
  index?: unknown;
  markdown?: unknown;
}

const unsupported = (what: string) =>
  new CapabilityError(`Mistral OCR cannot do ${what}.`, {
    retryable: true,
    code: "UNSUPPORTED_OPTION",
  });

export const provider = defineProvider({
  id: PROVIDER_ID,
  capability: "document.parse",
  priority: PROVIDER_PRIORITY,
  setupHint: `set ${SECRET} (https://console.mistral.ai/api-keys)`,
  isConfigured: (ctx) => ctx.secrets.has(SECRET),
  models: () => [DEFAULT_MODEL],
  // An image is one page; a PDF costs its page count when the library knows
  // it. Otherwise the cost is unknown (null), which a max_cost_usd limit
  // refuses: a guessed page count could approve a much dearer call.
  async estimate(input, ctx) {
    const record = await ctx.library.get(input.artifact_id);
    if (!record) return null;
    const known = record.meta?.pages;
    const pages =
      record.mime.toLowerCase() !== "application/pdf"
        ? 1
        : typeof known === "number" && Number.isInteger(known) && known > 0
          ? known
          : null;
    if (pages === null) return null;
    return {
      usd: Math.round(pages * PRICE_PER_PAGE_USD * 1e6) / 1e6,
      basis: `static price table (2026-11): ${pages} page${pages === 1 ? "" : "s"} at $4/1,000`,
    };
  },
  async run(input, ctx) {
    const model = input.model ?? DEFAULT_MODEL;
    if (!model.startsWith("mistral-ocr")) throw unsupported(`model "${model}"`);
    if ((input.format ?? "markdown") !== "markdown") throw unsupported(`format "${input.format}"`);
    const record = await ctx.library.get(input.artifact_id);
    if (!record) {
      throw new CapabilityError(`No library artifact "${input.artifact_id}".`, {
        code: "NOT_FOUND",
      });
    }
    // The stored type: active content such as SVG is stored as text/plain and refused here.
    const mime = record.mime.toLowerCase();
    const isPdf = mime === "application/pdf";
    if (!isPdf && !/^image\/(png|jpeg|webp|gif|avif|tiff|bmp)$/.test(mime)) {
      throw unsupported(`${mime} files (PDF and raster images only)`);
    }
    if (record.bytes > MAX_BYTES) throw unsupported(`files over ${MAX_BYTES / 1024 / 1024} MB`);
    const key = await apiKey(ctx);
    const bytes = await ctx.library.read(input.artifact_id);
    const dataUrl = `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
    const document = isPdf
      ? { type: "document_url", document_url: dataUrl }
      : { type: "image_url", image_url: dataUrl };
    const res = await ctx.fetch(URL_OCR, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ model, document, include_image_base64: false }),
    });
    if (!res.ok) throw await httpError(res, key);
    const j = await readJson(res);
    const pages = Array.isArray(j.pages) ? (j.pages as OcrPage[]) : [];
    const text = pages
      .map((p, i) => ({ i: typeof p?.index === "number" ? p.index : i, md: p?.markdown }))
      .sort((a, b) => a.i - b.i)
      .map((p) => (typeof p.md === "string" ? p.md : ""))
      .join("\n\n")
      .trim();
    const usage = j.usage_info as { pages_processed?: unknown } | undefined;
    const processed = usage?.pages_processed;
    return {
      text,
      format: "markdown" as const,
      provider: PROVIDER_ID,
      pages:
        typeof processed === "number" && Number.isInteger(processed) && processed >= 0
          ? processed
          : pages.length,
      model: typeof j.model === "string" && j.model ? j.model : model,
    };
  },
});

async function apiKey(ctx: PackContext): Promise<string> {
  if (!(await ctx.secrets.has(SECRET))) {
    throw new CapabilityError(`Mistral is not set up: ${SECRET} is missing.`, {
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
    throw new CapabilityError("Mistral returned a response that is not JSON.", {
      code: "BAD_RESPONSE",
    });
  }
}

/**
 * A failed OCR response as a CapabilityError: Mistral's own message (key
 * redacted, single line, capped). 401/403/429/5xx are retryable: such a call
 * processed nothing.
 */
export async function httpError(res: Response, key: string): Promise<CapabilityError> {
  const s = res.status;
  const message = await errorMessage(res, key);
  const retryAfter = Number(res.headers.get("retry-after"));
  return new CapabilityError(`Mistral ${s}${message ? `: ${message}` : ""}`, {
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
      // FastAPI-style 422s carry detail: [{msg}]
      const detail = Array.isArray(j.detail)
        ? (j.detail as { msg?: unknown }[])
            .map((d) => d?.msg)
            .filter((m) => typeof m === "string")
            .join("; ")
        : j.detail;
      const m = j.message ?? (typeof e === "string" ? e : e?.message) ?? detail;
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
