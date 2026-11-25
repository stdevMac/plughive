// packs/fal/client.ts
//
// fal.ai HTTP surface used by the pack:
//   catalog   GET  https://api.fal.ai/v1/models            (keyless)
//   pricing   GET  https://api.fal.ai/v1/models/pricing    (needs FAL_KEY)
//   queue     POST https://queue.fal.run/<endpoint_id>     (needs FAL_KEY)
//             GET  status_url / response_url, PUT cancel_url (returned by submit)
// Output files are served from fal.media and *.fal.media.
import type { PackFetch } from "plughive/pack";
import {
  type CancelOutcome,
  type Json,
  type JsonSchema,
  ProviderError,
  checkModelId,
  encodeId,
  oneLine,
  openApiToJsonSchema,
  readJson,
  readText,
} from "./common.js";

export const PROVIDER = "fal";
export const CATALOG_URL = "https://api.fal.ai/v1/models";
export const QUEUE_ORIGIN = "https://queue.fal.run";
export const KEY_HELP = "https://fal.ai/dashboard/keys";

export const CATEGORIES = [
  "text-to-image",
  "image-to-image",
  "text-to-video",
  "image-to-video",
  "video-to-video",
  "text-to-speech",
  "speech-to-text",
  "text-to-audio",
  "audio-to-audio",
  "image-to-3d",
  "text-to-3d",
  "vision",
  "llm",
  "training",
] as const;

export function checkFalId(id: string): string {
  return checkModelId(PROVIDER, id, 2, 8);
}

/** Output modality from a fal category ("text-to-image" gives "image"). */
export function modalityOf(category: string): string {
  const out = category.includes("-to-") ? category.split("-to-").pop() : category;
  if (out === "speech") return "audio";
  if (category === "speech-to-text" || category === "llm" || category === "vision") return "text";
  return out || "other";
}

export interface ModelSummary {
  id: string;
  name: string;
  category: string;
  modality: string;
  description: string;
  status: string;
}

export interface ModelSpec extends ModelSummary {
  input: JsonSchema | null;
  output: JsonSchema | null;
}

export function summarize(m: Json): ModelSummary | null {
  if (!m || typeof m.endpoint_id !== "string") return null;
  const md = m.metadata ?? {};
  const category = typeof md.category === "string" ? md.category : "";
  return {
    id: m.endpoint_id,
    name: typeof md.display_name === "string" ? md.display_name : m.endpoint_id,
    category,
    modality: modalityOf(category),
    description: oneLine(md.description, 200),
    status: typeof md.status === "string" ? md.status : "unknown",
  };
}

function bodySchemaRef(op: Json, where: "request" | "response"): Json {
  const content = where === "request" ? op?.requestBody?.content : op?.responses?.["200"]?.content;
  return content?.["application/json"]?.schema ?? null;
}

/** Model metadata plus input/output JSON Schemas from a catalog entry with `expand=openapi-3.0`. */
export function parseSpec(m: Json): ModelSpec | null {
  const summary = summarize(m);
  if (!summary) return null;
  const oa = m.openapi;
  const comps = oa?.components?.schemas as Record<string, Json> | undefined;
  const paths = (oa?.paths ?? {}) as Record<string, Json>;
  // Some specs file the operation under an alias (e.g. `fal-ai/hunyuan3d-v3/text-to-3d` is
  // documented at `/fal-ai/hunyuan3d-v3-text-to-3d/text-to-3d`). Fall back to the only submit path.
  let base = `/${summary.id}`;
  if (!paths[base]?.post) {
    const submits = Object.keys(paths).filter((p) => !p.includes("/requests/") && paths[p]?.post);
    if (submits.length === 1) base = submits[0] as string;
  }
  const post = paths[base]?.post;
  const result = paths[`${base}/requests/{request_id}`]?.get;
  const inRef = bodySchemaRef(post, "request");
  const outRef = bodySchemaRef(result, "response");
  return {
    ...summary,
    input: inRef ? openApiToJsonSchema(inRef, comps) : null,
    output: outRef ? openApiToJsonSchema(outRef, comps) : null,
  };
}

export interface SearchParams {
  query?: string;
  category?: string;
  limit: number;
  cursor?: string;
}

export interface Price {
  unit_price: number;
  unit: string;
  currency: string;
}

function authHeader(key: string): Record<string, string> {
  return { Authorization: `Key ${key}` };
}

/** Readable message for a failed fal response. Never includes the key or request URLs. */
export async function falError(
  res: Response,
  what: string,
  submit = false,
): Promise<ProviderError> {
  const body = await readJson(res, 1024 * 1024).catch(() => undefined);
  let detail = "";
  if (typeof body?.error?.message === "string") detail = body.error.message;
  else if (typeof body?.detail === "string") detail = body.detail;
  else if (Array.isArray(body?.detail)) {
    detail = body.detail
      .slice(0, 6)
      .map((d: Json) => {
        const loc = Array.isArray(d?.loc) ? d.loc.filter((x: Json) => x !== "body").join(".") : "";
        return `${loc ? `${loc}: ` : ""}${oneLine(d?.msg ?? d?.message ?? "", 160)}`;
      })
      .join("; ");
  }
  detail = oneLine(detail, 400);
  const s = res.status;
  let hint = "";
  if (s === 401 || s === 403) {
    hint = ` Check that FAL_KEY is a valid key from ${KEY_HELP} and that the account has credit.`;
  } else if (s === 404) hint = " Check the model id with fal_search_models.";
  else if (s === 422) hint = " Fix the input (see fal_describe_model) and try again.";
  else if (s === 429) hint = " fal is rate limiting this key; wait a little and retry.";
  else if (s >= 500 && submit) {
    // A 5xx on the submit can arrive after fal queued (and will bill) the job.
    hint =
      " fal had a server error, but the job may have been queued and billed anyway. Check the fal dashboard (Requests) before submitting it again.";
  } else if (s >= 500) hint = " fal had a server error; retry later.";
  return new ProviderError(
    PROVIDER,
    `${what} failed with HTTP ${s}${detail ? `: ${detail}` : ""}.${hint}`,
    s,
  );
}

/** A queue URL returned by fal, or null when it is anything else (never send the key off fal). */
function queueUrl(u: unknown): string | null {
  if (typeof u === "string") {
    try {
      const url = new URL(u);
      if (url.protocol === "https:" && url.host === "queue.fal.run") return url.toString();
    } catch {
      // fall through
    }
  }
  return null;
}

export interface QueueHandle {
  requestId: string;
  statusUrl: string;
  responseUrl: string;
  cancelUrl: string;
}

const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function checkRequestId(id: string): string {
  if (!REQUEST_ID.test(id)) {
    throw new ProviderError(PROVIDER, `"${oneLine(id, 80)}" is not a fal request id.`);
  }
  return id;
}

/**
 * Queue URLs for a request id, built the way fal documents them: the queue
 * path uses the app (`owner/name`) without the endpoint's sub-path.
 */
export function handleFor(model: string, requestId: string): QueueHandle {
  const app = encodeId(checkFalId(model).split("/").slice(0, 2).join("/"));
  const base = `${QUEUE_ORIGIN}/${app}/requests/${encodeURIComponent(checkRequestId(requestId))}`;
  return { requestId, statusUrl: `${base}/status`, responseUrl: base, cancelUrl: `${base}/cancel` };
}

/** Result body text that means "not ready yet" rather than "the job failed". */
const NOT_READY =
  /in progress|in_progress|not (?:yet )?(?:ready|completed|finished)|in queue|in_queue/i;

/** Hosts of file-shaped output objects (`{url, content_type|file_name}`) that are not on fal's CDN. */
export function foreignFileHosts(output: Json): string[] {
  const hosts = new Set<string>();
  const walk = (v: Json, depth: number): void => {
    if (depth > 20 || hosts.size >= 8 || !v || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    if (
      typeof v.url === "string" &&
      (typeof v.content_type === "string" || typeof v.file_name === "string") &&
      !isFalFile(v.url)
    ) {
      let host = "unknown host";
      try {
        host = new URL(v.url).host || host;
      } catch {
        // keep the placeholder
      }
      hosts.add(oneLine(host, 100));
    }
    for (const x of Object.values(v)) walk(x as Json, depth + 1);
  };
  walk(output, 0);
  return [...hosts];
}

export class FalClient {
  constructor(private readonly fetch: PackFetch) {}

  async search(
    p: SearchParams,
    signal?: AbortSignal,
  ): Promise<{ models: Json[]; next: string | null }> {
    const url = new URL(CATALOG_URL);
    if (p.query) url.searchParams.set("q", p.query);
    if (p.category) url.searchParams.set("category", p.category);
    url.searchParams.set("status", "active");
    url.searchParams.set("limit", String(p.limit));
    if (p.cursor) url.searchParams.set("cursor", p.cursor);
    const res = await this.fetch(url.toString(), { signal });
    if (!res.ok) throw await falError(res, "fal model search");
    const body = await readJson(res);
    return {
      models: Array.isArray(body?.models) ? body.models : [],
      next: typeof body?.next_cursor === "string" && body.has_more ? body.next_cursor : null,
    };
  }

  /** Catalog entries with OpenAPI for up to 50 ids. Unknown ids are missing from the result. */
  async specs(ids: string[], signal?: AbortSignal): Promise<Map<string, ModelSpec>> {
    const out = new Map<string, ModelSpec>();
    if (ids.length === 0) return out;
    const url = new URL(CATALOG_URL);
    for (const id of ids.slice(0, 50)) url.searchParams.append("endpoint_id", checkFalId(id));
    url.searchParams.set("expand", "openapi-3.0");
    const res = await this.fetch(url.toString(), { signal });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return out;
    }
    if (!res.ok) throw await falError(res, "fal model lookup");
    const body = await readJson(res);
    for (const m of Array.isArray(body?.models) ? body.models : []) {
      const spec = parseSpec(m);
      if (spec) out.set(spec.id, spec);
    }
    return out;
  }

  async pricing(ids: string[], key: string, signal?: AbortSignal): Promise<Map<string, Price>> {
    const out = new Map<string, Price>();
    if (ids.length === 0) return out;
    const url = new URL(`${CATALOG_URL}/pricing`);
    for (const id of ids.slice(0, 50)) url.searchParams.append("endpoint_id", checkFalId(id));
    const res = await this.fetch(url.toString(), { headers: authHeader(key), signal });
    if (!res.ok) throw await falError(res, "fal pricing lookup");
    const body = await readJson(res);
    for (const p of Array.isArray(body?.prices) ? body.prices : []) {
      if (typeof p?.endpoint_id === "string" && typeof p.unit_price === "number") {
        out.set(p.endpoint_id, {
          unit_price: p.unit_price,
          unit: String(p.unit ?? ""),
          currency: String(p.currency ?? "USD"),
        });
      }
    }
    return out;
  }

  async submit(id: string, input: Json, key: string, signal?: AbortSignal): Promise<QueueHandle> {
    const res = await this.fetch(`${QUEUE_ORIGIN}/${encodeId(checkFalId(id))}`, {
      method: "POST",
      headers: { ...authHeader(key), "content-type": "application/json" },
      body: JSON.stringify(input),
      signal,
    });
    if (!res.ok) throw await falError(res, `fal submit for ${id}`, true);
    const body = await readJson(res, 1024 * 1024);
    if (typeof body?.request_id !== "string" || !REQUEST_ID.test(body.request_id)) {
      throw new ProviderError(
        PROVIDER,
        "fal accepted the request but returned no usable request id, so the job cannot be tracked or cancelled. Check the fal dashboard before running it again.",
      );
    }
    // fal normally returns these. When one is missing or points off fal, use the
    // documented queue path for the request id so the job can still be tracked.
    const derived = handleFor(id, body.request_id);
    return {
      requestId: body.request_id,
      statusUrl: queueUrl(body.status_url) ?? derived.statusUrl,
      responseUrl: queueUrl(body.response_url) ?? derived.responseUrl,
      cancelUrl: queueUrl(body.cancel_url) ?? derived.cancelUrl,
    };
  }

  async status(h: QueueHandle, key: string, signal?: AbortSignal): Promise<Json> {
    const res = await this.fetch(h.statusUrl, { headers: authHeader(key), signal });
    if (!res.ok && res.status !== 202) throw await falError(res, "fal status check");
    return (await readJson(res, 4 * 1024 * 1024)) ?? {};
  }

  /**
   * The stored result. `{ done: false }` only when fal says it is not ready
   * (202, or a 400 whose body says so); any other 400 is the model's own
   * error and is thrown.
   */
  async result(
    h: QueueHandle,
    key: string,
    signal?: AbortSignal,
  ): Promise<{ done: boolean; value?: Json }> {
    const res = await this.fetch(h.responseUrl, { headers: authHeader(key), signal });
    if (res.status === 202) {
      await res.body?.cancel().catch(() => {});
      return { done: false };
    }
    if (res.status === 400) {
      const text = await readText(res, 1024 * 1024).catch(() => "");
      if (NOT_READY.test(text.slice(0, 2000))) return { done: false };
      throw await falError(
        new Response(text, { status: 400, headers: { "content-type": "application/json" } }),
        "the fal job",
      );
    }
    if (res.status === 499) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderError(PROVIDER, "the fal job was cancelled before it finished.", 499);
    }
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderError(
        PROVIDER,
        "the fal result has expired or was never stored; run the job again.",
        404,
      );
    }
    if (!res.ok) throw await falError(res, "the fal job");
    return { done: true, value: (await readJson(res)) ?? {} };
  }

  /** "sent" only when fal accepted the cancel (2xx). */
  async cancel(h: QueueHandle, key: string): Promise<CancelOutcome> {
    const res = await this.fetch(h.cancelUrl, {
      method: "PUT",
      headers: authHeader(key),
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok ? "sent" : "failed";
  }
}

/** fal output files: fal CDN links and inline data URIs. */
export function isFalFile(u: string): boolean {
  if (u.startsWith("data:")) return /^data:[a-z]+\/[A-Za-z0-9.+-]+;base64,/.test(u);
  try {
    const url = new URL(u);
    return (
      url.protocol === "https:" &&
      (url.hostname === "fal.media" || url.hostname.endsWith(".fal.media"))
    );
  } catch {
    return false;
  }
}
