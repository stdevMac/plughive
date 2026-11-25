// packs/openrouter/client.ts
//
// OpenRouter HTTP client and catalog parsing. The model catalogs
// (/models, /videos/models, /images/models, /audio/speech/models) are public;
// every generation endpoint needs the API key. OpenRouter publishes no JSON
// Schema per model, so `inputSchema` builds one from the catalog's declared
// parameters (enums, ranges and flags).
import type { PackFetch } from "plughive/pack";
import {
  type Json,
  type JsonSchema,
  LONG_CALL_MS,
  MAX_JSON_BYTES,
  ProviderError,
  checkModelId,
  oneLine,
  readCapped,
  readJson,
  safeMessage,
} from "./common.js";

export const PROVIDER = "openrouter";
export const API_HOST = "openrouter.ai";
export const API = `https://${API_HOST}/api/v1`;

export type Kind = "video" | "image" | "speech" | "transcription" | "chat";
/** Kinds with their own catalog endpoint (and so a typed parameter list). */
export type CatalogKind = "video" | "image" | "speech";
export const CATALOG_KINDS: readonly CatalogKind[] = ["video", "image", "speech"];

export type Param =
  | { type: "enum"; values: (string | number)[] }
  | { type: "range"; min: number; max: number }
  | { type: "boolean" };

export interface ModelEntry {
  id: string;
  name: string;
  description: string;
  kind: Kind;
  input_modalities: string[];
  params: Record<string, Param>;
  /** Raw price strings in USD, keyed by OpenRouter's SKU or token names. */
  pricing: Record<string, string> | null;
  /** Video only: frame images the model accepts ("first_frame", "last_frame"). */
  frame_images?: string[];
  /** Video only: provider parameters OpenRouter forwards unchanged. */
  passthrough?: string[];
  /** Video only: true when the model may pick its own duration (-1). */
  auto_duration?: boolean;
}

/** A compact search row. */
export interface ModelSummary {
  id: string;
  name: string;
  kind: Kind;
  description: string;
  input_modalities: string[];
  pricing: Record<string, string> | null;
}

const PARAM_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const MAX_ENUM = 400;

function str(v: unknown, max = 300): string {
  return oneLine(typeof v === "string" ? v : "", max);
}

function strings(v: unknown, max = MAX_ENUM): string[] {
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x.length <= 200).slice(0, max)
    : [];
}

function validId(id: unknown): string | null {
  if (typeof id !== "string") return null;
  try {
    return checkModelId(PROVIDER, id, 2, 3);
  } catch {
    return null;
  }
}

function priceMap(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>).slice(0, 40)) {
    if ((typeof x === "string" || typeof x === "number") && PARAM_NAME.test(k)) out[k] = String(x);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** One `{type: enum|range|boolean}` parameter from a catalog row. */
export function parseParam(v: unknown): Param | null {
  if (!v || typeof v !== "object") return null;
  const p = v as Record<string, unknown>;
  if (p.type === "enum" && Array.isArray(p.values)) {
    const values = p.values
      .filter(
        (x): x is string | number =>
          (typeof x === "string" && x.length <= 200) ||
          (typeof x === "number" && Number.isFinite(x)),
      )
      .slice(0, MAX_ENUM);
    return values.length > 0 ? { type: "enum", values } : null;
  }
  if (
    p.type === "range" &&
    typeof p.min === "number" &&
    typeof p.max === "number" &&
    p.min <= p.max
  ) {
    return { type: "range", min: p.min, max: p.max };
  }
  if (p.type === "boolean") return { type: "boolean" };
  return null;
}

function paramsOf(v: unknown): Record<string, Param> {
  const out: Record<string, Param> = {};
  if (!v || typeof v !== "object" || Array.isArray(v)) return out;
  for (const [k, raw] of Object.entries(v as Record<string, unknown>).slice(0, 60)) {
    if (!PARAM_NAME.test(k) || k === "model" || k === "prompt" || k === "input") continue;
    const p = parseParam(raw);
    if (p) out[k] = p;
  }
  return out;
}

const enumOf = (values: unknown): Param | null => {
  const v = strings(values);
  return v.length > 0 ? { type: "enum", values: v } : null;
};

export function parseVideoRow(row: Json): ModelEntry | null {
  const id = validId(row?.id);
  if (!id) return null;
  const params: Record<string, Param> = {};
  const durations: number[] = Array.isArray(row.supported_durations)
    ? row.supported_durations.filter(
        (d: unknown): d is number =>
          Number.isInteger(d) && (d as number) > 0 && (d as number) <= 600,
      )
    : [];
  if (durations.length > 0) params.duration = { type: "enum", values: durations.slice(0, 100) };
  const res = enumOf(row.supported_resolutions);
  if (res) params.resolution = res;
  const ar = enumOf(row.supported_aspect_ratios);
  if (ar) params.aspect_ratio = ar;
  const size = enumOf(row.supported_sizes);
  if (size) params.size = size;
  if (row.generate_audio === true) params.generate_audio = { type: "boolean" };
  if (row.seed === true) params.seed = { type: "range", min: 0, max: 4_294_967_295 };
  return {
    id,
    name: str(row.name, 120) || id,
    description: str(row.description),
    kind: "video",
    input_modalities: [
      "text",
      ...(strings(row.supported_frame_images).length > 0 ? ["image"] : []),
    ],
    params,
    pricing: priceMap(row.pricing_skus),
    frame_images: strings(row.supported_frame_images).filter(
      (f) => f === "first_frame" || f === "last_frame",
    ),
    passthrough: strings(row.allowed_passthrough_parameters, 30).filter((p) =>
      /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(p),
    ),
    auto_duration: Array.isArray(row.supported_durations) && row.supported_durations.includes(-1),
  };
}

export function parseImageRow(row: Json): ModelEntry | null {
  const id = validId(row?.id);
  if (!id) return null;
  return {
    id,
    name: str(row.name, 120) || id,
    description: str(row.description),
    kind: "image",
    input_modalities: strings(row.architecture?.input_modalities, 10),
    params: paramsOf(row.supported_parameters),
    pricing: priceMap(row.pricing),
  };
}

export function parseSpeechRow(row: Json): ModelEntry | null {
  const id = validId(row?.id);
  if (!id) return null;
  const outs: Json[] = Array.isArray(row.output_modalities) ? row.output_modalities : [];
  const speech = outs.find((o) => o?.type === "speech") ?? outs[0];
  return {
    id,
    name: str(row.name, 120) || id,
    description: str(row.description),
    kind: "speech",
    input_modalities: Array.isArray(row.input_modalities)
      ? row.input_modalities
          .map((m: Json) => (typeof m === "string" ? m : m?.type))
          .filter((m: unknown) => typeof m === "string")
      : ["text"],
    params: paramsOf(speech?.supported_parameters),
    pricing: priceMap(row.pricing),
  };
}

/** A row of the general /models list (chat, transcription and the rest). */
export function parseGeneralRow(row: Json): ModelEntry | null {
  const id = validId(row?.id);
  if (!id) return null;
  const out = strings(row.architecture?.output_modalities, 10);
  const kind: Kind = out.includes("video")
    ? "video"
    : out.includes("speech")
      ? "speech"
      : out.includes("transcription")
        ? "transcription"
        : out.includes("image")
          ? "image"
          : "chat";
  const params: Record<string, Param> = {};
  const voices = strings(row.supported_voices);
  if (kind === "speech" && voices.length > 0) params.voice = { type: "enum", values: voices };
  return {
    id,
    name: str(row.name, 120) || id,
    description: str(row.description),
    kind,
    input_modalities: strings(row.architecture?.input_modalities, 10),
    params,
    pricing: priceMap(row.pricing),
  };
}

const PARSERS: Record<CatalogKind, (row: Json) => ModelEntry | null> = {
  video: parseVideoRow,
  image: parseImageRow,
  speech: parseSpeechRow,
};

/** Parse a catalog body (`{data: [...]}`); rows with a bad id are dropped. */
export function parseCatalog(kind: CatalogKind, body: Json): ModelEntry[] {
  const rows: Json[] = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : [];
  const out: ModelEntry[] = [];
  for (const row of rows.slice(0, 2000)) {
    const e = PARSERS[kind](row);
    if (e) out.push(e);
  }
  return out;
}

export function summarize(e: ModelEntry): ModelSummary {
  return {
    id: e.id,
    name: e.name,
    kind: e.kind,
    description: oneLine(e.description, 200),
    input_modalities: e.input_modalities,
    pricing: e.pricing,
  };
}

// ---------------------------------------------------------------------------
// Synthesised input schemas
// ---------------------------------------------------------------------------

/**
 * "artifact:<id>" from the library, or an https URL. URLs are refused at run
 * time unless the allow_url_inputs setting is on: OpenRouter and the model
 * provider would fetch them, so an injected link (one with a secret in its
 * query, say) would be handed to a third party.
 */
export const FILE_REF_PATTERN =
  "^(artifact:[A-Za-z0-9][A-Za-z0-9_-]{0,127}|https://[^\\s]{1,4000})$";
const FILE_REF_HELP =
  'A library file as "artifact:<id>". An https URL works only when the allow_url_inputs setting is on (OpenRouter fetches it)';
const VOICE_PATTERN = "^[A-Za-z0-9 ._-]+$";
const AUDIO_REF_PATTERN = "^artifact:[A-Za-z0-9][A-Za-z0-9_-]{0,127}$";
const LANGUAGE_PATTERN = "^[a-z]{2}$";

/**
 * The only patterns inputSchema() writes, all constants of this pack. The
 * shared schema sanitiser drops every `pattern` (remote regexes are unsafe),
 * so the runtime re-checks these trusted ones itself.
 */
export const LOCAL_PATTERNS: ReadonlyMap<string, RegExp> = new Map(
  [FILE_REF_PATTERN, VOICE_PATTERN, AUDIO_REF_PATTERN, LANGUAGE_PATTERN].map((p) => [
    p,
    new RegExp(p),
  ]),
);

const INT_PARAMS = new Set([
  "n",
  "seed",
  "output_compression",
  "frame_count",
  "frame_duration_ms",
  "steps",
  "duration",
]);

function paramSchema(name: string, p: Param): JsonSchema {
  // The catalog marks seed support with a flag on some models; the request field is an integer.
  if (name === "seed" && p.type !== "range")
    return { type: "integer", minimum: 0, maximum: 4_294_967_295 };
  if (p.type === "boolean") return { type: "boolean" };
  if (p.type === "enum") {
    const allNumbers = p.values.every((v) => typeof v === "number");
    return allNumbers
      ? { type: "integer", enum: p.values }
      : { type: "string", enum: p.values.map(String) };
  }
  const integer = INT_PARAMS.has(name) || /(^num_|_count$|_steps$)/.test(name);
  return { type: integer ? "integer" : "number", minimum: p.min, maximum: p.max };
}

/**
 * The input schema for a model, built from its catalog parameters. The field
 * names follow OpenRouter's request bodies; file fields take library refs.
 */
export function inputSchema(e: ModelEntry): JsonSchema {
  const props: Record<string, JsonSchema> = {};
  const required: string[] = [];
  if (e.kind === "video") {
    props.prompt = {
      type: "string",
      minLength: 1,
      maxLength: 8000,
      description: "What the video should show",
    };
    required.push("prompt");
    for (const [k, p] of Object.entries(e.params)) props[k] = paramSchema(k, p);
    if (props.duration) {
      props.duration.description = e.auto_duration
        ? "Length in seconds. Leave it out to let the model choose."
        : "Length in seconds";
    }
    if (e.frame_images?.includes("first_frame")) {
      props.first_frame = {
        type: "string",
        pattern: FILE_REF_PATTERN,
        description: `Start frame image. ${FILE_REF_HELP}`,
      };
    }
    if (e.frame_images?.includes("last_frame")) {
      props.last_frame = {
        type: "string",
        pattern: FILE_REF_PATTERN,
        description: `End frame image. ${FILE_REF_HELP}`,
      };
    }
    props.input_references = {
      type: "array",
      maxItems: 8,
      items: { type: "string", pattern: FILE_REF_PATTERN },
      description: `Reference images (style or subject), for models that use them. ${FILE_REF_HELP}`,
    };
  } else if (e.kind === "image") {
    props.prompt = {
      type: "string",
      minLength: 1,
      maxLength: 32_000,
      description: "What the image should show",
    };
    required.push("prompt");
    for (const [k, p] of Object.entries(e.params)) {
      if (k === "input_references") {
        if (p.type === "range" && p.max >= 1) {
          props.input_references = {
            type: "array",
            maxItems: Math.min(16, Math.floor(p.max)),
            items: { type: "string", pattern: FILE_REF_PATTERN },
            description: `Images to edit or use as references. ${FILE_REF_HELP}`,
          };
        }
        continue;
      }
      props[k] = paramSchema(k, p);
    }
  } else if (e.kind === "speech") {
    props.input = { type: "string", minLength: 1, maxLength: 20_000, description: "Text to speak" };
    required.push("input");
    for (const [k, p] of Object.entries(e.params)) props[k] = paramSchema(k, p);
    if (!props.voice) {
      // The catalog lists no voices for this model: accept a free-form voice id.
      props.voice = {
        type: "string",
        maxLength: 100,
        pattern: VOICE_PATTERN,
        description:
          "Voice id. OpenRouter lists none for this model; see the model provider's voice list.",
      };
    }
    props.instructions = {
      type: "string",
      maxLength: 2000,
      description: "Delivery instructions (tone, pace). Only some models use them.",
    };
  } else if (e.kind === "transcription") {
    props.audio = {
      type: "string",
      pattern: AUDIO_REF_PATTERN,
      description: 'The audio file to transcribe, as "artifact:<id>"',
    };
    required.push("audio");
    props.language = {
      type: "string",
      pattern: LANGUAGE_PATTERN,
      description: "ISO-639-1 code, for example en. Auto-detected when left out.",
    };
    props.prompt = {
      type: "string",
      maxLength: 2000,
      description: "Context such as names or vocabulary (some providers only)",
    };
  } else {
    props.messages = {
      type: "array",
      minItems: 1,
      items: { type: "object" },
      description: "Chat messages",
    };
    required.push("messages");
  }
  return { type: "object", properties: props, required, additionalProperties: false };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const JOB_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** A job id given by a caller (openrouter_video_result). */
export function checkCallerJobId(id: unknown): string {
  if (typeof id !== "string" || !JOB_ID.test(id)) {
    throw new ProviderError(PROVIDER, `"${oneLine(id, 80)}" is not an OpenRouter video job id.`);
  }
  return id;
}

export function checkJobId(id: unknown): string {
  if (typeof id !== "string" || !JOB_ID.test(id)) {
    throw new ProviderError(
      PROVIDER,
      "OpenRouter returned a video job without a usable id. Try again.",
    );
  }
  return id;
}

export interface VideoJob {
  id: string;
  status: string;
  progress: number | null;
  error: string | null;
  urls: string[];
  cost: number | null;
}

export function parseVideoJob(body: Json, fallbackId?: string): VideoJob {
  const b =
    body?.data && typeof body.data === "object" && !Array.isArray(body.data) && body.data.status
      ? body.data
      : body;
  const id = checkJobId(b?.id ?? fallbackId);
  const urls = strings(b?.unsigned_urls, 32);
  const progress =
    typeof b?.progress === "number" && Number.isFinite(b.progress) ? b.progress : null;
  const err =
    typeof b?.error === "string"
      ? b.error
      : typeof b?.error?.message === "string"
        ? b.error.message
        : null;
  return {
    id,
    status: typeof b?.status === "string" ? b.status : "pending",
    progress,
    error: err,
    urls,
    cost: costOf(b),
  };
}

export function costOf(body: Json): number | null {
  const c = body?.usage?.cost;
  if (typeof c === "number" && Number.isFinite(c) && c >= 0) return c;
  if (typeof c === "string" && /^\d+(\.\d+)?$/.test(c)) return Number(c);
  return null;
}

/** A readable, key-free error for a failed OpenRouter response. */
/** Said instead of "try again" when a generation request may already have been charged. */
export const CHARGED_NOTE =
  "The request may already have been processed and charged; check https://openrouter.ai/activity before running it again";

export async function openrouterError(
  res: Response,
  what: string,
  paid = false,
): Promise<ProviderError> {
  let detail = "";
  try {
    const body = await readJson(res, 256 * 1024);
    const m = body?.error?.message ?? body?.message ?? body?.error;
    if (typeof m === "string") detail = safeMessage(new Error(m));
    const raw = body?.error?.metadata?.raw;
    if (typeof raw === "string" && detail.length < 200)
      detail = `${detail} (${safeMessage(new Error(raw)).slice(0, 200)})`;
  } catch {
    detail = "";
  }
  const s = res.status;
  const tail = detail ? `: ${detail}` : "";
  let msg: string;
  if (s === 401)
    msg = "OpenRouter rejected the API key. Check OPENROUTER_API_KEY in the store's secrets.";
  else if (s === 402)
    msg = `Your OpenRouter account does not have enough credits for this ${what}. Add credits at https://openrouter.ai/settings/credits${tail}`;
  else if (s === 403)
    msg = `OpenRouter refused the ${what} (often a moderation or key limit)${tail}`;
  else if (s === 404)
    msg = `OpenRouter does not know this model or job. Check the id with openrouter_search_models${tail}`;
  else if (s === 408)
    msg = `OpenRouter timed out on the ${what}. ${paid ? CHARGED_NOTE : "Try again"}${tail}`;
  else if (s === 429)
    msg = `OpenRouter is rate limiting this key. Wait a little and try again${tail}`;
  else if (s >= 500) {
    msg = `OpenRouter or the model provider had an error (HTTP ${s}). ${paid ? CHARGED_NOTE : "Try again later"}${tail}`;
  } else msg = `OpenRouter rejected the ${what} (HTTP ${s})${tail}`;
  return new ProviderError(PROVIDER, oneLine(msg, 600), s);
}

export interface SearchParams {
  q?: string;
  output_modalities?: string;
  limit: number;
}

export class OpenRouterClient {
  constructor(private readonly fetchFn: PackFetch) {}

  private async send(
    method: "GET" | "POST",
    path: string,
    what: string,
    opts: {
      key?: string;
      body?: Json;
      signal?: AbortSignal;
      accept?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { Accept: opts.accept ?? "application/json" };
    if (opts.key) headers.Authorization = `Bearer ${opts.key}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: opts.signal,
      };
      // Synchronous generations can run for minutes: ask the host for a longer per-request timeout.
      res = await this.fetchFn(
        `${API}${path}`,
        opts.timeoutMs ? { ...init, timeoutMs: opts.timeoutMs } : init,
      );
    } catch (e) {
      if (opts.signal?.aborted || (e as Error)?.name === "AbortError") throw e;
      // Every POST here is a paid generation: a failure after the request left
      // (a timeout, a reset) can still be charged.
      const paidTail = method === "POST" ? `. ${CHARGED_NOTE}.` : "";
      throw new ProviderError(
        PROVIDER,
        `could not reach OpenRouter for the ${what}: ${safeMessage(e)}${paidTail}`,
      );
    }
    if (!res.ok) throw await openrouterError(res, what, method === "POST");
    return res;
  }

  private async json(
    res: Response,
    what: string,
    max = MAX_JSON_BYTES,
    paid = false,
  ): Promise<Json> {
    const body = await readJson(res, max);
    if (body === undefined) {
      throw new ProviderError(
        PROVIDER,
        `OpenRouter sent an unreadable ${what} response. ${paid ? `${CHARGED_NOTE}.` : "Try again."}`,
      );
    }
    return body;
  }

  /** Public catalog for one kind (no key). */
  async catalog(kind: CatalogKind, signal?: AbortSignal): Promise<Json> {
    const path =
      kind === "video"
        ? "/videos/models"
        : kind === "image"
          ? "/images/models"
          : "/audio/speech/models";
    return this.json(await this.send("GET", path, "model catalog", { signal }), "catalog");
  }

  /** The general /models list with a text query (no key). */
  async search(p: SearchParams, signal?: AbortSignal): Promise<Json> {
    const qs = new URLSearchParams();
    if (p.q) qs.set("q", p.q);
    qs.set("output_modalities", p.output_modalities ?? "all");
    qs.set("limit", String(p.limit));
    qs.set("offset", "0");
    return this.json(
      await this.send("GET", `/models?${qs.toString()}`, "model search", { signal }),
      "search",
    );
  }

  async submitVideo(body: Json, key: string, signal?: AbortSignal): Promise<VideoJob> {
    const res = await this.send("POST", "/videos", "video request", { key, body, signal });
    const json = await this.json(res, "video", MAX_JSON_BYTES, true);
    try {
      return parseVideoJob(json);
    } catch {
      throw new ProviderError(
        PROVIDER,
        "OpenRouter accepted the video request but returned no usable job id, so it cannot be tracked. The video may still be generated and charged; check https://openrouter.ai/activity before running it again.",
      );
    }
  }

  async getVideo(id: string, key: string, signal?: AbortSignal): Promise<VideoJob> {
    const res = await this.send(
      "GET",
      `/videos/${encodeURIComponent(checkJobId(id))}`,
      "video status",
      { key, signal },
    );
    return parseVideoJob(await this.json(res, "video status"), id);
  }

  async images(body: Json, key: string, signal?: AbortSignal): Promise<Json> {
    const res = await this.send("POST", "/images", "image request", {
      key,
      body,
      signal,
      timeoutMs: LONG_CALL_MS,
    });
    return this.json(res, "image", 96 * 1024 * 1024, true);
  }

  async speech(
    body: Json,
    key: string,
    signal?: AbortSignal,
  ): Promise<{ bytes: Uint8Array; mime: string | null }> {
    const res = await this.send("POST", "/audio/speech", "speech request", {
      key,
      body,
      signal,
      accept: "audio/*",
      timeoutMs: LONG_CALL_MS,
    });
    const bytes = await readCapped(res, 100 * 1024 * 1024, "speech audio");
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || null;
    return { bytes, mime };
  }

  async transcribe(body: Json, key: string, signal?: AbortSignal): Promise<Json> {
    const res = await this.send("POST", "/audio/transcriptions", "transcription request", {
      key,
      body,
      signal,
      timeoutMs: LONG_CALL_MS,
    });
    return this.json(res, "transcription", MAX_JSON_BYTES, true);
  }

  async chat(body: Json, key: string, signal?: AbortSignal): Promise<Json> {
    const res = await this.send("POST", "/chat/completions", "chat request", {
      key,
      body,
      signal,
      timeoutMs: LONG_CALL_MS,
    });
    return this.json(res, "chat", MAX_JSON_BYTES, true);
  }

  /** POST /embeddings (https://openrouter.ai/docs/api/reference/embeddings). */
  async embeddings(body: Json, key: string, signal?: AbortSignal): Promise<Json> {
    const res = await this.send("POST", "/embeddings", "embedding request", {
      key,
      body,
      signal,
      timeoutMs: LONG_CALL_MS,
    });
    return this.json(res, "embedding", 96 * 1024 * 1024, true);
  }
}

/** The content URL for output `index` of a video job (needs the API key). */
export function videoContentUrl(id: string, index: number): string {
  return `${API}/videos/${encodeURIComponent(checkJobId(id))}/content?index=${index}`;
}

/** True for a URL on the OpenRouter API host (those downloads carry the key). */
export function isApiUrl(u: URL): boolean {
  return u.protocol === "https:" && u.host === API_HOST;
}
