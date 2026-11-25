// packs/jina/index.ts
//
// web.fetch through the Jina Reader. https://jina.ai/reader
// POST https://r.jina.ai/ with a JSON body {url}, `Authorization: Bearer <key>`,
// `Accept: application/json` (the reply is {code, status, data: {title, url,
// content}}) and `X-Return-Format` (markdown, html or text).
//
// Input mapping: format -> X-Return-Format, max_chars -> the content is cut
// here (the Reader has no length option) and `truncated` is set. `model` has
// no Reader equivalent and throws a retryable UNSUPPORTED_OPTION.
//
// text.rerank through the Jina Reranker, a cross-encoder that reads the query
// and each document together (more accurate than comparing embeddings).
// https://jina.ai/reranker  POST https://api.jina.ai/v1/rerank
// {model, query, documents, top_n, return_documents:false} ->
// {results:[{index, relevance_score}], usage:{total_tokens}}.
//
// text.embed through Jina Embeddings v3. https://jina.ai/embeddings
// POST https://api.jina.ai/v1/embeddings {model, input, task, dimensions} ->
// {data:[{index, embedding}], usage:{total_tokens}}. input_type maps to the
// retrieval.query / retrieval.passage task adapters.
import { CapabilityError, type PackContext, definePack, defineProvider } from "plughive/pack";

export const PROVIDER_ID = "jina";
export const PROVIDER_PRIORITY = 40;
const SECRET = "JINA_API_KEY";
const URL_READER = "https://r.jina.ai/";
const URL_RERANK = "https://api.jina.ai/v1/rerank";
const URL_EMBED = "https://api.jina.ai/v1/embeddings";
export const RERANK_MODELS = [
  "jina-reranker-v2-base-multilingual",
  "jina-reranker-m0",
  "jina-colbert-v2",
] as const;
export const EMBED_MODELS = ["jina-embeddings-v3"] as const;
/** jina-embeddings-v3 is Matryoshka-trained: any size up to 1024 works. */
const EMBED_MAX_DIMENSIONS = 1024;
const EMBED_MAX_INPUTS = 2048;
const DEFAULT_MAX_CHARS = 100_000;
// Tokens from the shared prepaid pool: the 1B-token pack is $50, $0.05 per
// million (2026-11), https://jina.ai/api-dashboard/pricing/ . Reader bills the
// tokens of its whole output (before our max_chars cut), Reranker and
// Embeddings the tokens of their input. Tokens are taken as chars / 2, an
// upper-leaning count (English runs nearer 4 chars a token).
export const PRICE_PER_MILLION_TOKENS_USD = 0.05;
const CHARS_PER_TOKEN = 2;
const tokenUsd = (tokens: number) =>
  Math.max(1e-6, Math.round(tokens * PRICE_PER_MILLION_TOKENS_USD) / 1e6);
const tokensIn = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);
const BASIS = "static price table (2026-11): $0.05/M tokens";

/**
 * Reader cost is unknown before the call: Jina bills the tokens of the whole
 * upstream page, and only the local `max_chars` cut happens here, so a small
 * max_chars does not mean a small bill. Null (unknown) makes the spend policy
 * ask under a cap instead of guessing near zero.
 */
export function estimateFetch(_maxChars: number | undefined): null {
  return null;
}

/** Reranker: the query is read with every document. */
export function estimateRerank(query: string, documents: readonly string[]) {
  const chars = documents.reduce((n, d) => n + query.length + d.length, 0);
  return { usd: tokenUsd(tokensIn(chars)), basis: `${BASIS}, ${chars} input chars` };
}

/** Embeddings: the input texts. */
export function estimateEmbed(texts: readonly string[]) {
  const chars = texts.reduce((n, t) => n + t.length, 0);
  return { usd: tokenUsd(tokensIn(chars)), basis: `${BASIS}, ${chars} input chars` };
}
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_ERROR_CHARS = 200;

export const provider = defineProvider({
  id: PROVIDER_ID,
  capability: "web.fetch",
  priority: PROVIDER_PRIORITY,
  setupHint: `set ${SECRET} (https://jina.ai/api-dashboard)`,
  isConfigured: (ctx) => ctx.secrets.has(SECRET),
  estimate: (input) => estimateFetch(input.max_chars),
  async run(input, ctx) {
    if (input.model) {
      throw new CapabilityError(`Jina Reader has no model choice ("${input.model}").`, {
        retryable: true,
        code: "UNSUPPORTED_OPTION",
      });
    }
    const key = await apiKey(ctx);
    const format = input.format ?? "markdown";
    const res = await ctx.fetch(URL_READER, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Return-Format": format,
      },
      body: JSON.stringify({ url: input.url }),
    });
    if (!res.ok) throw await httpError(res, key);
    const j = await readJson(res);
    const data = (j.data && typeof j.data === "object" ? j.data : {}) as Record<string, unknown>;
    if (typeof data.content !== "string") {
      throw new CapabilityError("Jina Reader returned no page content.", { code: "BAD_RESPONSE" });
    }
    const max = input.max_chars ?? DEFAULT_MAX_CHARS;
    const truncated = data.content.length > max;
    return {
      url: typeof data.url === "string" && data.url ? data.url : input.url,
      ...(typeof data.title === "string" && data.title ? { title: data.title } : {}),
      content: truncated ? data.content.slice(0, max) : data.content,
      format,
      provider: PROVIDER_ID,
      ...(truncated ? { truncated: true } : {}),
    };
  },
});

function noModel(kind: string, model: string, models: readonly string[]): CapabilityError {
  return new CapabilityError(`Jina has no ${kind} model "${model}" (${models.join(", ")}).`, {
    retryable: true,
    code: "UNSUPPORTED_OPTION",
  });
}

async function postJson(
  ctx: PackContext,
  url: string,
  key: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await ctx.fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await httpError(res, key, "Jina");
  return readJson(res, "Jina");
}

const tokensOf = (j: Record<string, unknown>): Record<string, number> => {
  const t = (j.usage as { total_tokens?: unknown } | undefined)?.total_tokens;
  return typeof t === "number" && Number.isFinite(t) ? { tokens_used: t } : {};
};

export const rerankProvider = defineProvider({
  id: PROVIDER_ID,
  capability: "text.rerank",
  priority: PROVIDER_PRIORITY,
  setupHint: `set ${SECRET} (https://jina.ai/api-dashboard)`,
  isConfigured: (ctx) => ctx.secrets.has(SECRET),
  models: () => RERANK_MODELS,
  estimate: (input) => estimateRerank(input.query, input.documents),
  async run(input, ctx) {
    const model = input.model ?? RERANK_MODELS[0];
    if (!(RERANK_MODELS as readonly string[]).includes(model)) {
      throw noModel("rerank", model, RERANK_MODELS);
    }
    const key = await apiKey(ctx);
    const topN = Math.min(input.top_n ?? input.documents.length, input.documents.length);
    const j = await postJson(ctx, URL_RERANK, key, {
      model,
      query: input.query,
      documents: input.documents,
      top_n: topN,
      return_documents: false,
    });
    const rows = Array.isArray(j.results) ? (j.results as Record<string, unknown>[]) : [];
    const results = rows
      .filter(
        (r) =>
          Number.isInteger(r?.index) &&
          (r.index as number) >= 0 &&
          (r.index as number) < input.documents.length &&
          typeof r.relevance_score === "number",
      )
      .map((r) => ({ index: r.index as number, score: r.relevance_score as number }))
      .sort((a, b) => b.score - a.score)
      .slice(0, topN);
    if (results.length === 0) {
      throw new CapabilityError("Jina Reranker returned no results.", { code: "BAD_RESPONSE" });
    }
    return { results, model, provider: PROVIDER_ID, ...tokensOf(j) };
  },
});

export const embedProvider = defineProvider({
  id: PROVIDER_ID,
  capability: "text.embed",
  priority: PROVIDER_PRIORITY,
  setupHint: `set ${SECRET} (https://jina.ai/api-dashboard)`,
  isConfigured: (ctx) => ctx.secrets.has(SECRET),
  models: () => EMBED_MODELS,
  estimate: (input) => estimateEmbed(input.texts),
  async run(input, ctx) {
    const model = input.model ?? EMBED_MODELS[0];
    if (!(EMBED_MODELS as readonly string[]).includes(model)) {
      throw noModel("embedding", model, EMBED_MODELS);
    }
    if (input.dimensions !== undefined && input.dimensions > EMBED_MAX_DIMENSIONS) {
      throw new CapabilityError(
        `${model} embeds at most ${EMBED_MAX_DIMENSIONS} dimensions (asked ${input.dimensions}).`,
        { retryable: true, code: "UNSUPPORTED_OPTION" },
      );
    }
    if (input.texts.length > EMBED_MAX_INPUTS) {
      throw new CapabilityError(`Jina embeds at most ${EMBED_MAX_INPUTS} texts per call.`, {
        retryable: true,
        code: "UNSUPPORTED_OPTION",
      });
    }
    const key = await apiKey(ctx);
    const j = await postJson(ctx, URL_EMBED, key, {
      model,
      input: input.texts,
      ...(input.input_type
        ? { task: input.input_type === "query" ? "retrieval.query" : "retrieval.passage" }
        : { task: "text-matching" }),
      ...(input.dimensions !== undefined ? { dimensions: input.dimensions } : {}),
      embedding_type: "float",
    });
    const rows = Array.isArray(j.data) ? (j.data as Record<string, unknown>[]) : [];
    const embeddings: number[][] = new Array(input.texts.length);
    for (const r of rows) {
      const i = r?.index;
      const v = r?.embedding;
      if (
        Number.isInteger(i) &&
        (i as number) >= 0 &&
        (i as number) < input.texts.length &&
        Array.isArray(v) &&
        v.length > 0 &&
        v.every((x) => typeof x === "number" && Number.isFinite(x))
      ) {
        embeddings[i as number] = v as number[];
      }
    }
    const first = embeddings[0];
    if (
      !first ||
      embeddings.length !== input.texts.length ||
      [...embeddings].some((e) => !e || e.length !== first.length)
    ) {
      throw new CapabilityError(
        `Jina returned ${rows.length} embeddings for ${input.texts.length} texts.`,
        { code: "BAD_RESPONSE" },
      );
    }
    return {
      embeddings,
      model,
      dimensions: first.length,
      provider: PROVIDER_ID,
      ...tokensOf(j),
    };
  },
});

async function apiKey(ctx: PackContext): Promise<string> {
  if (!(await ctx.secrets.has(SECRET))) {
    throw new CapabilityError(`Jina Reader is not set up: ${SECRET} is missing.`, {
      retryable: true,
      code: "NOT_CONFIGURED",
    });
  }
  return ctx.secrets.get(SECRET);
}

async function readJson(res: Response, who = "Jina Reader"): Promise<Record<string, unknown>> {
  try {
    const j = await res.json();
    return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
  } catch {
    throw new CapabilityError(`${who} returned a response that is not JSON.`, {
      code: "BAD_RESPONSE",
    });
  }
}

/**
 * A failed Reader response as a CapabilityError: Jina's own message (key
 * redacted, single line, capped). 401/402 (balance)/403/429/5xx are retryable:
 * another provider may fetch the page. Other 4xx (the page could not be read)
 * are not.
 */
export async function httpError(
  res: Response,
  key: string,
  who = "Jina Reader",
): Promise<CapabilityError> {
  const s = res.status;
  const message = await errorMessage(res, key);
  const retryAfter = Number(res.headers.get("retry-after"));
  return new CapabilityError(`${who} ${s}${message ? `: ${message}` : ""}`, {
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
      const e = j.error as { message?: unknown } | string | undefined;
      const m =
        j.readableMessage ?? j.message ?? (typeof e === "string" ? e : e?.message) ?? j.detail;
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

export default definePack({ providers: [provider, rerankProvider, embedProvider] });
