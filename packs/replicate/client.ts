// packs/replicate/client.ts
//
// Replicate HTTP surface used by the pack (every call needs the API token):
//   search       GET  https://api.replicate.com/v1/search?query=&limit=
//   collections  GET  https://api.replicate.com/v1/collections/{slug}
//   model        GET  https://api.replicate.com/v1/models/{owner}/{name}
//   version      GET  https://api.replicate.com/v1/models/{owner}/{name}/versions/{id}
//   predict      POST https://api.replicate.com/v1/models/{owner}/{name}/predictions (official)
//                POST https://api.replicate.com/v1/predictions {version, input}     (others)
//   poll/cancel  GET urls.get, POST urls.cancel (returned by predict)
//   prediction   GET  https://api.replicate.com/v1/predictions/{id}
//   upload       POST https://api.replicate.com/v1/files (multipart)
//   delete file  DELETE https://api.replicate.com/v1/files/{id}
//   train        POST https://api.replicate.com/v1/models/{owner}/{name}/versions/{id}/trainings
//                     {destination, input}
//   training     GET  https://api.replicate.com/v1/trainings/{id} (cancel: POST .../cancel)
// Output files are served from replicate.delivery and *.replicate.delivery.
import type { PackFetch } from "plughive/pack";
import {
  type CancelOutcome,
  type Json,
  type JsonSchema,
  LONG_CALL_MS,
  ProviderError,
  checkModelId,
  encodeId,
  oneLine,
  openApiToJsonSchema,
  readJson,
} from "./common.js";

export const PROVIDER = "replicate";
export const API = "https://api.replicate.com/v1";
export const API_HOST = "api.replicate.com";
export const KEY_HELP = "https://replicate.com/account/api-tokens";

const VERSION_ID = /^[a-f0-9]{64}$/;
/** Prediction and file ids are short lowercase base32-like strings; anything else is refused. */
const OBJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function checkPredictionId(id: string): string {
  if (!OBJECT_ID.test(id)) {
    throw new ProviderError(PROVIDER, `"${oneLine(id, 60)}" is not a Replicate prediction id.`);
  }
  return id;
}

export interface UploadedFile {
  id: string;
  url: string;
}
const SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

export interface ModelRef {
  owner: string;
  name: string;
  /** 64-hex version id, when pinned. */
  version: string | null;
  /** owner/name */
  id: string;
}

/** Parse `owner/name` or `owner/name:version`. Throws a readable error otherwise. */
export function parseModelRef(raw: string): ModelRef {
  const [base = "", version, extra] = raw.split(":");
  const bad = () =>
    new ProviderError(
      PROVIDER,
      `"${oneLine(raw, 80)}" is not a valid Replicate model. Use "owner/name" or "owner/name:<64-char version id>".`,
    );
  if (extra !== undefined) throw bad();
  if (version !== undefined && !VERSION_ID.test(version)) throw bad();
  let id: string;
  try {
    id = checkModelId(PROVIDER, base, 2, 2);
  } catch {
    throw bad();
  }
  const [owner = "", name = ""] = id.split("/");
  return { owner, name, version: version ?? null, id };
}

export function checkCollection(slug: string): string {
  if (!SLUG.test(slug)) {
    throw new ProviderError(PROVIDER, `"${oneLine(slug, 60)}" is not a Replicate collection slug.`);
  }
  return slug;
}

const MODALITY_HINTS: [string, RegExp][] = [
  ["video", /\b(video|i2v|t2v|animate|animation|lip ?sync)\b/i],
  ["audio", /\b(speech|tts|text-to-speech|voice|music|audio|song|sound)\b/i],
  ["text", /\b(llm|chat|language model|transcri\w*|speech-to-text|asr|whisper|caption\w*)\b/i],
  ["3d", /\b(3d|mesh|gaussian|point cloud)\b/i],
  [
    "image",
    /\b(image|photo|picture|diffusion|flux|sdxl|text-to-image|inpaint\w*|upscal\w*|edit\w*)\b/i,
  ],
];

/** Best-effort output modality from the name, description and search tags. */
export function guessModality(text: string): string {
  for (const [m, re] of MODALITY_HINTS) if (re.test(text)) return m;
  return "other";
}

export interface ModelSummary {
  id: string;
  description: string;
  modality: string;
  official: boolean;
  run_count: number | null;
  tags: string[];
  url: string | null;
}

/** Compact row from a model object (and optional search metadata). */
export function summarize(model: Json, meta?: Json): ModelSummary | null {
  if (typeof model?.owner !== "string" || typeof model?.name !== "string") return null;
  const id = `${model.owner}/${model.name}`;
  const tags: string[] = Array.isArray(meta?.tags)
    ? meta.tags.filter((t: Json) => typeof t === "string").slice(0, 8)
    : [];
  const description = oneLine(model.description ?? meta?.generated_description ?? "", 240);
  return {
    id,
    description,
    modality: guessModality(`${id} ${description} ${tags.join(" ")}`),
    official: model.is_official === true,
    run_count: typeof model.run_count === "number" ? model.run_count : null,
    tags,
    url:
      typeof model.url === "string" && model.url.startsWith("https://replicate.com/")
        ? model.url
        : null,
  };
}

export interface ModelSpec {
  id: string;
  description: string;
  official: boolean;
  version: string | null;
  input: JsonSchema | null;
  output: JsonSchema | null;
  default_example_input: Json;
  url: string | null;
}

/** Input and output JSON Schemas of a version's Cog OpenAPI document. */
export function schemasOf(openapi: Json): { input: JsonSchema | null; output: JsonSchema | null } {
  const comps = openapi?.components?.schemas as Record<string, Json> | undefined;
  if (!comps) return { input: null, output: null };
  return {
    input: comps.Input ? openApiToJsonSchema({ $ref: "#/components/schemas/Input" }, comps) : null,
    output: comps.Output
      ? openApiToJsonSchema({ $ref: "#/components/schemas/Output" }, comps)
      : null,
  };
}

/** Spec returned by `GET /models/{owner}/{name}` (optionally with a pinned version object). */
export function parseSpec(model: Json, version?: Json): ModelSpec | null {
  const s = summarize(model);
  if (!s) return null;
  const v = version ?? model.latest_version ?? null;
  const { input, output } = schemasOf(v?.openapi_schema);
  const example = model.default_example?.input;
  return {
    id: s.id,
    description: s.description,
    official: s.official,
    version: typeof v?.id === "string" && VERSION_ID.test(v.id) ? v.id : null,
    input,
    output,
    default_example_input: example && typeof example === "object" ? example : null,
    url: s.url,
  };
}

function auth(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` };
}

/** Readable message for a failed Replicate response. Never includes the token or URLs. */
export async function replicateError(
  res: Response,
  what: string,
  submit = false,
): Promise<ProviderError> {
  const body = await readJson(res, 1024 * 1024).catch(() => undefined);
  let detail = "";
  if (typeof body?.detail === "string") detail = body.detail;
  else if (typeof body?.title === "string") detail = body.title;
  if (Array.isArray(body?.invalid_fields)) {
    const fields = body.invalid_fields
      .slice(0, 6)
      .map((f: Json) => `${oneLine(f?.field ?? "", 60)}: ${oneLine(f?.description ?? "", 160)}`)
      .join("; ");
    if (fields) detail = detail ? `${detail} (${fields})` : fields;
  }
  detail = oneLine(detail, 400);
  const s = res.status;
  let hint = "";
  if (s === 401 || s === 403) {
    hint = ` Check that REPLICATE_API_TOKEN is a valid token from ${KEY_HELP}.`;
  } else if (s === 402) hint = " The Replicate account needs credit or a payment method.";
  else if (s === 404) hint = " Check the model with replicate_search_models.";
  else if (s === 413) hint = " The file is too large for Replicate (100 MB max).";
  else if (s === 422) hint = " Fix the input (see replicate_describe_model) and try again.";
  else if (s === 429) hint = " Replicate is rate limiting this token; wait a little and retry.";
  else if (s >= 500 && submit) {
    // A 5xx on the create can arrive after Replicate started (and will bill) the prediction.
    hint =
      " Replicate had a server error, but the prediction may have started and be billed anyway. Check https://replicate.com/predictions before running it again.";
  } else if (s >= 500) hint = " Replicate had a server error; retry later.";
  return new ProviderError(
    PROVIDER,
    `${what} failed with HTTP ${s}${detail ? `: ${detail}` : ""}.${hint}`,
    s,
  );
}

/** A prediction URL returned by Replicate; refuse anything else before sending the token to it. */
function apiUrl(u: unknown, field: string): string {
  if (typeof u === "string") {
    try {
      const url = new URL(u);
      if (
        url.protocol === "https:" &&
        url.host === API_HOST &&
        (url.pathname.startsWith("/v1/predictions/") || url.pathname.startsWith("/v1/trainings/"))
      ) {
        return url.toString();
      }
    } catch {
      // fall through
    }
  }
  throw new ProviderError(
    PROVIDER,
    `Replicate returned an unexpected ${field}; the job was not tracked.`,
  );
}

export interface Prediction {
  id: string;
  /** owner/name, when Replicate says. */
  model: string | null;
  status: string;
  output: Json;
  error: Json;
  logs: string;
  metrics: Json;
  getUrl: string;
  cancelUrl: string;
}

function toPrediction(body: Json): Prediction {
  if (typeof body?.id !== "string") {
    throw new ProviderError(PROVIDER, "Replicate returned a prediction without an id.");
  }
  return {
    id: body.id,
    model:
      typeof body.model === "string" &&
      /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}$/.test(body.model)
        ? body.model
        : null,
    status: String(body.status ?? ""),
    output: body.output ?? null,
    error: body.error ?? null,
    logs: typeof body.logs === "string" ? body.logs.slice(-4000) : "",
    metrics: body.metrics && typeof body.metrics === "object" ? body.metrics : null,
    getUrl: apiUrl(body.urls?.get, "urls.get"),
    cancelUrl: apiUrl(body.urls?.cancel, "urls.cancel"),
  };
}

/** Last "NN%" in the logs (most Cog models print tqdm bars), as a fraction. */
export function logProgress(logs: string): number | null {
  const all = [...logs.matchAll(/(\d{1,3})%\|/g)];
  const last = all.at(-1)?.[1];
  if (!last) return null;
  const n = Number.parseInt(last, 10);
  return n >= 0 && n <= 100 ? n / 100 : null;
}

export class ReplicateClient {
  constructor(private readonly fetch: PackFetch) {}

  private async getJson(
    path: string,
    key: string,
    what: string,
    signal?: AbortSignal,
  ): Promise<Json> {
    const res = await this.fetch(`${API}${path}`, { headers: auth(key), signal });
    if (!res.ok) throw await replicateError(res, what);
    return (await readJson(res)) ?? {};
  }

  async search(
    query: string,
    limit: number,
    key: string,
    signal?: AbortSignal,
  ): Promise<ModelSummary[]> {
    const url = new URL(`${API}/search`);
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(limit));
    const res = await this.fetch(url.toString(), { headers: auth(key), signal });
    if (!res.ok) throw await replicateError(res, "Replicate search");
    const body = await readJson(res);
    const rows: ModelSummary[] = [];
    for (const m of Array.isArray(body?.models) ? body.models : []) {
      const s = summarize(m?.model, m?.metadata);
      if (s) rows.push(s);
    }
    return rows;
  }

  async collection(slug: string, key: string, signal?: AbortSignal): Promise<ModelSummary[]> {
    const body = await this.getJson(
      `/collections/${checkCollection(slug)}`,
      key,
      "Replicate collection lookup",
      signal,
    );
    const rows: ModelSummary[] = [];
    for (const m of Array.isArray(body?.models) ? body.models : []) {
      const s = summarize(m);
      if (s) rows.push(s);
    }
    return rows;
  }

  /** Null when Replicate has no such model. */
  async model(ref: ModelRef, key: string, signal?: AbortSignal): Promise<ModelSpec | null> {
    const res = await this.fetch(`${API}/models/${encodeId(ref.id)}`, {
      headers: auth(key),
      signal,
    });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    if (!res.ok) throw await replicateError(res, `Replicate model lookup for ${ref.id}`);
    const model = await readJson(res);
    if (!ref.version) return parseSpec(model);
    const version = await this.getJson(
      `/models/${encodeId(ref.id)}/versions/${ref.version}`,
      key,
      `Replicate version lookup for ${ref.id}`,
      signal,
    );
    return parseSpec(model, version);
  }

  async create(
    spec: ModelSpec,
    ref: ModelRef,
    input: Json,
    key: string,
    opts: { cancelAfterSeconds: number; signal?: AbortSignal },
  ): Promise<Prediction> {
    const version = ref.version ?? (spec.official ? null : spec.version);
    if (!spec.official && !version) {
      throw new ProviderError(PROVIDER, `${ref.id} has no runnable version on Replicate.`);
    }
    const url = version ? `${API}/predictions` : `${API}/models/${encodeId(ref.id)}/predictions`;
    const body = version ? { version, input } : { input };
    const res = await this.fetch(url, {
      method: "POST",
      headers: {
        ...auth(key),
        "content-type": "application/json",
        "Cancel-After": `${Math.max(5, Math.round(opts.cancelAfterSeconds))}s`,
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });
    if (!res.ok) throw await replicateError(res, `Replicate prediction for ${ref.id}`, true);
    const created = await readJson(res, 4 * 1024 * 1024);
    try {
      return toPrediction(created);
    } catch (e) {
      // The prediction exists and is billed. Keep its id when it is usable and
      // use the documented URLs for it, so it can still be tracked and cancelled.
      const id = typeof created?.id === "string" && OBJECT_ID.test(created.id) ? created.id : null;
      if (id) {
        const getUrl = `${API}/predictions/${id}`;
        return toPrediction({ ...created, urls: { get: getUrl, cancel: `${getUrl}/cancel` } });
      }
      throw new ProviderError(
        PROVIDER,
        `Replicate accepted the prediction for ${ref.id} but returned no usable id, so it cannot be tracked or cancelled (${(e as Error).message}). Check https://replicate.com/predictions before running it again.`,
      );
    }
  }

  /**
   * Start a training of `trainer` (pinned version) into the `destination`
   * model, which must already exist. Returns it as a Prediction (same shape).
   */
  async createTraining(
    trainer: ModelRef,
    destination: ModelRef,
    input: Json,
    key: string,
    signal?: AbortSignal,
  ): Promise<Prediction> {
    if (!trainer.version) {
      throw new ProviderError(PROVIDER, `the trainer ${trainer.id} needs a pinned version.`);
    }
    const url = `${API}/models/${encodeId(trainer.id)}/versions/${trainer.version}/trainings`;
    const res = await this.fetch(url, {
      method: "POST",
      headers: { ...auth(key), "content-type": "application/json" },
      body: JSON.stringify({ destination: destination.id, input }),
      signal,
    });
    if (res.status === 404) {
      await res.body?.cancel().catch(() => {});
      throw new ProviderError(
        PROVIDER,
        `Replicate found no trainer ${trainer.id} at that version, or no destination model ${destination.id}. Create the destination model first (private is fine) at https://replicate.com/create, then try again.`,
        404,
      );
    }
    if (!res.ok) throw await replicateError(res, `Replicate training of ${trainer.id}`, true);
    const created = await readJson(res, 4 * 1024 * 1024);
    const id = typeof created?.id === "string" && OBJECT_ID.test(created.id) ? created.id : null;
    if (!id) {
      throw new ProviderError(
        PROVIDER,
        `Replicate accepted the training of ${trainer.id} but returned no usable id. Check https://replicate.com/trainings before starting it again.`,
      );
    }
    const getUrl = `${API}/trainings/${id}`;
    return toPrediction({ ...created, urls: { get: getUrl, cancel: `${getUrl}/cancel` } });
  }

  /** A training by id (to collect one that an earlier call started). */
  async getTrainingById(id: string, key: string, signal?: AbortSignal): Promise<Prediction> {
    const res = await this.fetch(`${API}/trainings/${checkPredictionId(id)}`, {
      headers: auth(key),
      signal,
    });
    if (!res.ok) throw await replicateError(res, `Replicate status check for training ${id}`);
    // Trainings are only ever reached through their documented paths.
    const getUrl = `${API}/trainings/${checkPredictionId(id)}`;
    return toPrediction({
      ...(await readJson(res)),
      urls: { get: getUrl, cancel: `${getUrl}/cancel` },
    });
  }

  async get(p: Prediction, key: string, signal?: AbortSignal): Promise<Prediction> {
    const res = await this.fetch(p.getUrl, { headers: auth(key), signal });
    if (!res.ok) throw await replicateError(res, "Replicate status check");
    // Keep the links already checked when the job was created: a later
    // response cannot redirect where we poll or cancel.
    return toPrediction({ ...(await readJson(res)), urls: { get: p.getUrl, cancel: p.cancelUrl } });
  }

  /** A prediction by id (to collect one that an earlier call submitted). */
  async getById(id: string, key: string, signal?: AbortSignal): Promise<Prediction> {
    const res = await this.fetch(`${API}/predictions/${checkPredictionId(id)}`, {
      headers: auth(key),
      signal,
    });
    if (!res.ok) throw await replicateError(res, `Replicate status check for prediction ${id}`);
    return toPrediction(await readJson(res));
  }

  async cancel(p: Prediction, key: string): Promise<CancelOutcome> {
    const res = await this.fetch(p.cancelUrl, {
      method: "POST",
      headers: auth(key),
      signal: AbortSignal.timeout(10_000),
    });
    await res.body?.cancel().catch(() => {});
    return res.ok ? "sent" : "failed";
  }

  /** Upload a file for use as a model input; returns its id and API URL. */
  async upload(
    bytes: Uint8Array,
    mime: string,
    key: string,
    signal?: AbortSignal,
  ): Promise<UploadedFile> {
    const form = new FormData();
    const ext = mime.split("/")[1]?.replace(/[^a-z0-9]/g, "") || "bin";
    form.append("content", new Blob([new Uint8Array(bytes)], { type: mime }), `input.${ext}`);
    form.append("type", mime);
    const res = await this.fetch(`${API}/files`, {
      method: "POST",
      headers: auth(key),
      body: form,
      signal,
      timeoutMs: LONG_CALL_MS,
    });
    if (!res.ok) throw await replicateError(res, "Replicate file upload");
    const body = await readJson(res, 1024 * 1024);
    const get = body?.urls?.get;
    const id = typeof body?.id === "string" && OBJECT_ID.test(body.id) ? body.id : null;
    if (typeof get === "string") {
      try {
        const u = new URL(get);
        if (u.protocol === "https:" && u.host === API_HOST) {
          const fromUrl = u.pathname.match(/^\/v1\/files\/([A-Za-z0-9_-]{1,128})$/)?.[1] ?? null;
          const fileId = id ?? fromUrl;
          if (fileId) return { id: fileId, url: u.toString() };
        }
      } catch {
        // fall through
      }
    }
    throw new ProviderError(PROVIDER, "Replicate accepted the upload but returned no file URL.");
  }

  /** Delete an uploaded input file. True when Replicate confirmed it. Never throws. */
  async deleteFile(id: string, key: string): Promise<boolean> {
    if (!OBJECT_ID.test(id)) return false;
    try {
      const res = await this.fetch(`${API}/files/${id}`, {
        method: "DELETE",
        headers: auth(key),
        signal: AbortSignal.timeout(10_000),
      });
      await res.body?.cancel().catch(() => {});
      return res.ok || res.status === 404;
    } catch {
      return false;
    }
  }
}

/** Replicate output files: delivery CDN links, API file links and inline data URIs. */
export function isReplicateFile(u: string): boolean {
  if (u.startsWith("data:")) return /^data:[a-z]+\/[A-Za-z0-9.+-]+;base64,/.test(u);
  try {
    const url = new URL(u);
    if (url.protocol !== "https:") return false;
    if (url.hostname === "replicate.delivery" || url.hostname.endsWith(".replicate.delivery"))
      return true;
    return url.host === API_HOST && url.pathname.startsWith("/v1/files/");
  } catch {
    return false;
  }
}
