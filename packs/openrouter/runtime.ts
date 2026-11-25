// packs/openrouter/runtime.ts
//
// Per-load state for the OpenRouter pack: catalog cache (with a bundled
// snapshot for offline startup), synthesised schemas, and the runners for
// video jobs, images, speech, transcription and chat.
import { join } from "node:path";
import type { PackContext, PackFetch, z } from "plughive/pack";
import seedData from "./catalog-seed.json" with { type: "json" };
import {
  CATALOG_KINDS,
  type CatalogKind,
  LOCAL_PATTERNS,
  type ModelEntry,
  OpenRouterClient,
  PROVIDER,
  type VideoJob,
  checkCallerJobId,
  costOf,
  inputSchema,
  isApiUrl,
  parseCatalog,
  parseGeneralRow,
  videoContentUrl,
} from "./client.js";
import {
  CancelledError,
  type ConvertedSchema,
  type Json,
  JsonCache,
  MAX_FILE_BYTES,
  ProviderError,
  type RunResult,
  artifactToUrl,
  checkArtifactId,
  checkInputUrls,
  checkModelId,
  elapsedFraction,
  finishRun,
  loadArtifact,
  numberSetting,
  oneLine,
  poll,
  resolveArtifactRefs,
  toZod,
  validateInput,
  withJobContext,
} from "./common.js";

export const SECRET = "OPENROUTER_API_KEY";
/** Library files sent inline (as data URLs) are capped at this size. */
export const MAX_INLINE_BYTES = 20 * 1024 * 1024;
export const MAX_TRANSCRIBE_BYTES = 25 * 1024 * 1024;
export const DEFAULT_CHAT_MODEL = "minimax/minimax-m2.7";
/** Chat request caps: message count, serialized size after inlining, default max_tokens ceiling. */
export const MAX_CHAT_MESSAGES = 200;
export const MAX_CHAT_BODY_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_CHAT_TOKENS = 32_768;
/** Date of the bundled catalog snapshot (catalog-seed.json). */
export const SNAPSHOT_DATE = String((seedData as { snapshot?: unknown }).snapshot ?? "unknown");
export const SNAPSHOT_NOTE = `catalog from the bundled snapshot dated ${SNAPSHOT_DATE}; prices and models may have changed`;

/** How to collect a video job later. */
export function recoverHint(jobId: string): string {
  return `call openrouter_video_result with {"job_id":"${jobId}"}`;
}

/** A video job that has not finished yet. */
export interface PendingVideo {
  status: string;
  job_id: string;
  message: string;
}

/** The max_tokens ceiling for chat, from the max_chat_tokens setting. */
export function maxChatTokens(settings: Record<string, unknown>): number {
  return numberSetting(settings, "max_chat_tokens", DEFAULT_MAX_CHAT_TOKENS, 1, 1_000_000);
}

/**
 * Chat model ids also allow a variant suffix (":free", ":thinking") and the
 * "~" latest-alias prefix. They only ever go in a JSON body.
 */
export const CHAT_MODEL_PATTERN =
  /^~?[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}(:[a-z0-9-]{1,40})?$/;

export function checkChatModel(id: unknown): string {
  if (typeof id !== "string" || !CHAT_MODEL_PATTERN.test(id)) {
    throw new ProviderError(
      PROVIDER,
      `"${oneLine(id, 80)}" is not a valid OpenRouter model id. Use an id like "openai/gpt-5" from openrouter_search_models.`,
    );
  }
  return id;
}

let seeds: Record<CatalogKind, ModelEntry[]> | null = null;

/** The bundled catalog snapshot, parsed once. */
export function seedCatalog(kind: CatalogKind): ModelEntry[] {
  if (!seeds) {
    const raw = seedData as unknown as Record<string, Json>;
    seeds = {
      video: parseCatalog("video", { data: raw.video }),
      image: parseCatalog("image", { data: raw.image }),
      speech: parseCatalog("speech", { data: raw.speech }),
    };
  }
  return seeds[kind];
}

export interface CatalogResult {
  entries: ModelEntry[];
  source: "live" | "cache" | "snapshot";
}

const AUDIO_FORMATS: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
  "audio/webm": "webm",
  "video/webm": "webm",
  "video/mp4": "mp4",
  "audio/pcm": "pcm",
};

function isHttpsApiFile(u: string): boolean {
  try {
    return isApiUrl(new URL(u));
  } catch {
    return false;
  }
}

export class OpenRouterRuntime {
  readonly cache: JsonCache;
  /** Fetch bound to the pack lifetime (kept for symmetry with the other providers). */
  readonly lifetimeFetch: PackFetch;
  private readonly converted = new Map<string, ConvertedSchema>();
  /** Model id -> per-model tool name actually registered at load. */
  readonly registered = new Map<string, string>();
  /** First poll delay; tests lower it. */
  pollInitialMs = 2000;

  constructor(ctx: PackContext) {
    const ttlHours = numberSetting(ctx.settings, "cache_ttl_hours", 24, 0, 24 * 30);
    this.cache = new JsonCache(join(ctx.pack.dataDir, "catalog-cache"), ttlHours * 3_600_000);
    this.lifetimeFetch = ctx.fetch;
  }

  client(fetch: PackFetch): OpenRouterClient {
    return new OpenRouterClient(fetch);
  }

  /**
   * One kind's catalog. Offline: the disk cache (any age), else the bundled
   * snapshot. Online: fresh cache, else the live catalog, else stale cache,
   * else the snapshot.
   */
  async catalog(
    ctx: PackContext,
    kind: CatalogKind,
    opts: { offline?: boolean; fresh?: boolean } = {},
  ): Promise<CatalogResult> {
    const key = `catalog:${kind}`;
    if (opts.offline) {
      const hit = await this.cache.get(key);
      if (Array.isArray(hit?.value)) return { entries: hit.value as ModelEntry[], source: "cache" };
      return { entries: seedCatalog(kind), source: "snapshot" };
    }
    try {
      if (opts.fresh) {
        // Bypass a cached copy (describe must show current params and prices).
        const entries = parseCatalog(kind, await this.client(ctx.fetch).catalog(kind, ctx.signal));
        await this.cache.set(key, entries);
        return { entries, source: "live" };
      }
      const { value, cached } = await this.cache.through(key, async () =>
        parseCatalog(kind, await this.client(ctx.fetch).catalog(kind, ctx.signal)),
      );
      return { entries: value as ModelEntry[], source: cached ? "cache" : "live" };
    } catch (e) {
      if (e instanceof CancelledError || ctx.signal?.aborted) throw e;
      ctx.logger.warn("openrouter: catalog fetch failed; using the bundled snapshot", { kind });
      return { entries: seedCatalog(kind), source: "snapshot" };
    }
  }

  /**
   * Find a model: catalogs first (offline, then live), then the general
   * /models list (chat and transcription models). Null when unknown.
   */
  async entry(
    ctx: PackContext,
    id: string,
    opts: { offline?: boolean; fresh?: boolean } = {},
  ): Promise<ModelEntry | null> {
    return (await this.lookup(ctx, id, opts)).entry;
  }

  /** Like entry(), and says where the entry came from. */
  async lookup(
    ctx: PackContext,
    id: string,
    opts: { offline?: boolean; fresh?: boolean } = {},
  ): Promise<{ entry: ModelEntry | null; source: CatalogResult["source"] }> {
    checkModelId(PROVIDER, id, 2, 3);
    if (!opts.fresh) {
      for (const kind of CATALOG_KINDS) {
        const r = await this.catalog(ctx, kind, { offline: true });
        const hit = r.entries.find((e) => e.id === id);
        if (hit) return { entry: hit, source: r.source };
      }
      const general = await this.cache.get(`model:${id}`);
      if (general?.value) return { entry: general.value as ModelEntry, source: "cache" };
    }
    if (opts.offline) return { entry: null, source: "cache" };
    for (const kind of CATALOG_KINDS) {
      const r = await this.catalog(ctx, kind, { fresh: opts.fresh });
      const hit = r.entries.find((e) => e.id === id);
      if (hit) return { entry: hit, source: r.source };
    }
    const search = async (): Promise<Json> => {
      const body = await this.client(ctx.fetch).search({ q: id, limit: 100 }, ctx.signal);
      const rows: Json[] = Array.isArray(body?.data) ? body.data : [];
      const row = rows.find((r) => r?.id === id || r?.canonical_slug === id);
      return row ? parseGeneralRow({ ...row, id }) : null;
    };
    if (opts.fresh) {
      const value = await search();
      if (value) await this.cache.set(`model:${id}`, value);
      return { entry: (value as ModelEntry | null) ?? null, source: "live" };
    }
    const { value, cached } = await this.cache.through(`model:${id}`, search);
    return { entry: (value as ModelEntry | null) ?? null, source: cached ? "cache" : "live" };
  }

  schemaFor(entry: ModelEntry): ConvertedSchema {
    const schema = inputSchema(entry);
    const k = JSON.stringify(schema);
    let c = this.converted.get(k);
    if (!c) {
      c = withLocalPatterns(toZod(schema), schema);
      this.converted.set(k, c);
      while (this.converted.size > 200) {
        const first = this.converted.keys().next().value;
        if (first === undefined) break;
        this.converted.delete(first);
      }
    }
    return c;
  }

  private async fileRef(ctx: PackContext, ref: string): Promise<string> {
    if (ref.startsWith("artifact:")) {
      return artifactToUrl(ctx, checkArtifactId(ref.slice("artifact:".length)), {
        maxInlineBytes: MAX_INLINE_BYTES,
      });
    }
    if (/^https:\/\/\S+$/.test(ref)) {
      // OpenRouter and the model provider fetch URLs themselves: forwarding one
      // hands it (and anything in its query string) to third parties.
      if (ctx.settings.allow_url_inputs === true) return ref;
      throw new ProviderError(
        PROVIDER,
        'URL file inputs are off: pass a library file as "artifact:<id>", or turn on the allow_url_inputs setting to let OpenRouter fetch URLs.',
      );
    }
    throw new ProviderError(PROVIDER, 'file inputs must be "artifact:<id>" or an https URL');
  }

  private imagePart(url: string): Json {
    return { type: "image_url", image_url: { url } };
  }

  /** Validate, then run a video, image, speech or transcription model. */
  async run(
    ctx: PackContext,
    model: string,
    input: Json,
    opts: { entry?: ModelEntry; skipValidation?: boolean } = {},
  ): Promise<RunResult> {
    checkModelId(PROVIDER, model, 2, 3);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ProviderError(PROVIDER, `input for ${model} must be a JSON object`);
    }
    const entry = opts.entry ?? (await this.entry(ctx, model));
    if (!entry) {
      throw new ProviderError(
        PROVIDER,
        `OpenRouter has no model "${model}". Find one with openrouter_search_models.`,
      );
    }
    if (entry.kind === "chat") {
      throw new ProviderError(PROVIDER, `${model} is a text model. Use openrouter_chat for it.`);
    }
    if (!opts.skipValidation) validateInput(PROVIDER, model, this.schemaFor(entry), input);
    // Model inputs are forwarded to OpenRouter: URL file fields are off unless allowed.
    checkInputUrls(input, ctx.settings.allow_url_inputs === true);
    const key = await ctx.secrets.get(SECRET);
    if (entry.kind === "video") return this.runVideo(ctx, entry, input, key);
    if (entry.kind === "image") return this.runImage(ctx, entry, input, key);
    if (entry.kind === "speech") return this.runSpeech(ctx, entry, input, key);
    return this.runTranscription(ctx, entry, input, key);
  }

  private async runVideo(
    ctx: PackContext,
    entry: ModelEntry,
    input: Json,
    key: string,
  ): Promise<RunResult> {
    const signal = ctx.signal;
    const client = this.client(ctx.fetch);
    const body: Json = { model: entry.id, prompt: input.prompt };
    for (const k of ["duration", "resolution", "aspect_ratio", "size", "generate_audio", "seed"]) {
      if (input[k] !== undefined) body[k] = input[k];
    }
    const frames: Json[] = [];
    for (const frame of ["first_frame", "last_frame"] as const) {
      if (typeof input[frame] === "string") {
        frames.push({
          ...this.imagePart(await this.fileRef(ctx, input[frame])),
          frame_type: frame,
        });
      }
    }
    if (frames.length > 0) body.frame_images = frames;
    if (Array.isArray(input.input_references) && input.input_references.length > 0) {
      body.input_references = [];
      for (const r of input.input_references)
        body.input_references.push(this.imagePart(await this.fileRef(ctx, r)));
    }
    const maxWaitMs = numberSetting(ctx.settings, "max_wait_minutes", 20, 1, 120) * 60_000;

    ctx.progress?.(0.02, `submitting to ${entry.id}`);
    // Never retried: a second submit would start (and bill) a second job.
    const job = await client.submitVideo(body, key, signal);
    const hint = recoverHint(job.id);
    const started = Date.now();
    return withJobContext(PROVIDER, "OpenRouter video job", job.id, hint, async () => {
      const final = await poll<VideoJob>({
        provider: PROVIDER,
        signal,
        maxWaitMs,
        initialDelayMs: this.pollInitialMs,
        maxDelayMs: Math.max(this.pollInitialMs, 15_000),
        progress: ctx.progress,
        jobId: job.id,
        recoverHint: hint,
        // OpenRouter has no endpoint to cancel a video job.
        cancel: async () => "unsupported" as const,
        check: async () => {
          const j = await client.getVideo(job.id, key, signal);
          if (j.status === "completed") return { done: true, value: j };
          videoTerminalError(j);
          const p = j.progress === null ? null : j.progress > 1 ? j.progress / 100 : j.progress;
          return {
            done: false,
            fraction:
              p !== null
                ? 0.05 + 0.85 * Math.max(0, Math.min(1, p))
                : elapsedFraction(Date.now() - started, 120_000),
            message: j.status === "pending" ? "queued" : "generating",
          };
        },
      });
      ctx.progress?.(0.95, "downloading the video");
      return this.finishVideo(
        ctx,
        final,
        entry.id,
        key,
        typeof input.prompt === "string" ? input.prompt : null,
      );
    });
  }

  /**
   * Collect a video job an earlier call submitted: one status check, then the
   * video if it completed. Never submits a job.
   */
  async collectVideo(ctx: PackContext, jobId: string): Promise<RunResult | PendingVideo> {
    const id = checkCallerJobId(jobId);
    const key = await ctx.secrets.get(SECRET);
    return withJobContext(PROVIDER, "OpenRouter video job", id, recoverHint(id), async () => {
      const j = await this.client(ctx.fetch).getVideo(id, key, ctx.signal);
      if (j.status === "completed") return this.finishVideo(ctx, j, "unknown", key, null);
      videoTerminalError(j);
      return {
        status: j.status || "unknown",
        job_id: j.id,
        message: `The video job is ${j.status || "in an unknown state"}; call openrouter_video_result again later.`,
      };
    });
  }

  private finishVideo(
    ctx: PackContext,
    final: VideoJob,
    model: string,
    key: string,
    prompt: string | null,
  ): Promise<RunResult> {
    const urls = final.urls.filter(isHttpsApiFile);
    const files = (urls.length > 0 ? urls : [videoContentUrl(final.id, 0)]).map((url) => ({
      url,
      content_type: "video/mp4",
    }));
    return finishRun(
      ctx,
      { job_id: final.id, status: final.status, videos: files },
      {
        provider: PROVIDER,
        model,
        prompt,
        costUsd: final.cost,
        meta: { job_id: final.id },
        recoverHint: recoverHint(final.id),
      },
      isHttpsApiFile,
      {
        maxBytes: MAX_FILE_BYTES,
        // Video content links are on the API host and need the key; nothing else gets it.
        headersFor: (u) => (isApiUrl(u) ? { Authorization: `Bearer ${key}` } : undefined),
      },
    );
  }

  private async runImage(
    ctx: PackContext,
    entry: ModelEntry,
    input: Json,
    key: string,
  ): Promise<RunResult> {
    const body: Json = { ...input, model: entry.id, response_format: "b64_json" };
    if (Array.isArray(input.input_references)) {
      const refs: Json[] = [];
      for (const r of input.input_references) refs.push(this.imagePart(await this.fileRef(ctx, r)));
      if (refs.length > 0) body.input_references = refs;
      else body.input_references = undefined;
    }
    ctx.progress?.(0.05, `generating with ${entry.id}`);
    const resp = await this.client(ctx.fetch).images(body, key, ctx.signal);
    const data: Json[] = Array.isArray(resp?.data) ? resp.data : [];
    const images: Json[] = [];
    let urlOnly = 0;
    for (const d of data.slice(0, 32)) {
      const mime =
        typeof d?.media_type === "string" && /^image\/[a-z0-9.+-]+$/.test(d.media_type)
          ? d.media_type
          : "image/png";
      if (typeof d?.b64_json === "string")
        images.push({ url: `data:${mime};base64,${d.b64_json}`, content_type: mime });
      else if (typeof d?.url === "string") urlOnly++;
    }
    if (images.length === 0) {
      if (urlOnly > 0) {
        // Arbitrary hosts are never fetched (the pack only downloads from known hosts).
        throw new ProviderError(
          PROVIDER,
          `${entry.id} returned ${urlOnly} image link(s) instead of image data, which this pack does not download. The generation was billed; pick a model that returns b64_json.`,
        );
      }
      throw new ProviderError(
        PROVIDER,
        `${entry.id} returned no image. Try a different prompt or model.`,
      );
    }
    ctx.progress?.(0.9, "saving images");
    return finishRun(
      ctx,
      { images, ...(resp?.usage ? { usage: resp.usage } : {}) },
      {
        provider: PROVIDER,
        model: entry.id,
        prompt: typeof input.prompt === "string" ? input.prompt : null,
        costUsd: costOf(resp),
      },
      (u) => u.startsWith("data:image/"),
      { maxBytes: MAX_FILE_BYTES },
    );
  }

  private async runSpeech(
    ctx: PackContext,
    entry: ModelEntry,
    input: Json,
    key: string,
  ): Promise<RunResult> {
    const body: Json = { ...input, model: entry.id };
    ctx.progress?.(0.05, `speaking with ${entry.id}`);
    const { bytes, mime: header } = await this.client(ctx.fetch).speech(body, key, ctx.signal);
    if (bytes.byteLength === 0)
      throw new ProviderError(PROVIDER, `${entry.id} returned no audio. Try again.`);
    // Raw PCM has no container, so a generic header (audio/mpeg, octet-stream) would mislabel it.
    const mime =
      input.response_format === "pcm"
        ? "audio/pcm"
        : header && /^audio\/[a-z0-9.+-]+$/.test(header)
          ? header
          : "audio/mpeg";
    const ref = await ctx.library.save({
      kind: "audio",
      mime,
      bytes,
      model: entry.id,
      prompt: typeof input.input === "string" ? input.input.slice(0, 2000) : null,
      costUsd: null,
      meta: {
        provider: PROVIDER,
        ...(typeof input.voice === "string" ? { voice: input.voice } : {}),
        ...(mime === "audio/pcm" ? { pcm: "16-bit little-endian" } : {}),
      },
    });
    const a = { id: ref.id, url: ref.url, mime: ref.mime };
    return {
      artifacts: [a],
      output: { audio: { artifact_id: a.id }, mime },
      model: entry.id,
      provider: PROVIDER,
    };
  }

  private async runTranscription(
    ctx: PackContext,
    entry: ModelEntry,
    input: Json,
    key: string,
  ): Promise<RunResult> {
    const ref = typeof input.audio === "string" ? input.audio : "";
    if (!ref.startsWith("artifact:")) {
      throw new ProviderError(PROVIDER, 'audio must be a library file given as "artifact:<id>"');
    }
    const a = await loadArtifact(ctx, ref.slice("artifact:".length));
    if (a.bytes.byteLength > MAX_TRANSCRIBE_BYTES) {
      throw new ProviderError(
        PROVIDER,
        `artifact ${a.id} is over the ${MAX_TRANSCRIBE_BYTES / 1024 / 1024} MB transcription limit.`,
      );
    }
    const format = AUDIO_FORMATS[a.mime.split(";")[0]!.trim().toLowerCase()];
    if (!format) {
      throw new ProviderError(
        PROVIDER,
        `artifact ${a.id} is ${a.mime}; transcription needs an audio file (mp3, wav, flac, m4a, ogg, webm).`,
      );
    }
    const body: Json = {
      model: entry.id,
      input_audio: { data: Buffer.from(a.bytes).toString("base64"), format },
    };
    if (typeof input.language === "string") body.language = input.language;
    if (typeof input.prompt === "string") body.prompt = input.prompt;
    ctx.progress?.(0.05, `transcribing with ${entry.id}`);
    const resp = await this.client(ctx.fetch).transcribe(body, key, ctx.signal);
    const output: Json = { text: typeof resp?.text === "string" ? resp.text : "" };
    if (typeof resp?.language === "string") output.language = resp.language;
    if (typeof resp?.duration === "number") output.duration_seconds = resp.duration;
    if (Array.isArray(resp?.segments)) {
      output.segments = resp.segments.slice(0, 5000).map((s: Json) => ({
        start: typeof s?.start === "number" ? s.start : null,
        end: typeof s?.end === "number" ? s.end : null,
        text: typeof s?.text === "string" ? s.text.trim() : "",
      }));
    }
    const cost = costOf(resp);
    return {
      artifacts: [],
      output,
      model: entry.id,
      provider: PROVIDER,
      ...(cost !== null ? { cost_usd: cost } : {}),
    };
  }

  /** POST /chat/completions with `artifact:<id>` refs in messages inlined. */
  async chat(ctx: PackContext, request: Json): Promise<Json> {
    checkChatModel(request.model);
    if (!Array.isArray(request.messages) || request.messages.length === 0) {
      throw new ProviderError(PROVIDER, "messages must be a non-empty list");
    }
    if (request.messages.length > MAX_CHAT_MESSAGES) {
      throw new ProviderError(
        PROVIDER,
        `a chat request takes at most ${MAX_CHAT_MESSAGES} messages`,
      );
    }
    const ceiling = maxChatTokens(ctx.settings);
    if (typeof request.max_tokens === "number" && request.max_tokens > ceiling) {
      throw new ProviderError(
        PROVIDER,
        `max_tokens ${request.max_tokens} is over the ${ceiling} ceiling; raise the max_chat_tokens setting to allow more.`,
      );
    }
    const key = await ctx.secrets.get(SECRET);
    const messages = await resolveArtifactRefs(request.messages, ctx, {
      maxInlineBytes: MAX_INLINE_BYTES,
    });
    // Message part URLs (image_url and friends) are fetched by OpenRouter and the
    // model provider: anything but artifact data is off unless allowed.
    checkInputUrls(messages, ctx.settings.allow_url_inputs === true);
    const body = { ...request, messages };
    const size = Buffer.byteLength(JSON.stringify(body));
    if (size > MAX_CHAT_BODY_BYTES) {
      throw new ProviderError(
        PROVIDER,
        `the chat request is ${(size / 1024 / 1024).toFixed(1)} MB after inlining files; the limit is ${MAX_CHAT_BODY_BYTES / 1024 / 1024} MB. Send fewer or smaller files.`,
      );
    }
    return this.client(ctx.fetch).chat(body, key, ctx.signal);
  }
}

/**
 * Re-apply this pack's own (trusted, constant) field patterns, which the shared
 * sanitiser strips. Patterns not written by inputSchema() are never compiled.
 */
export function withLocalPatterns(c: ConvertedSchema, schema: Json): ConvertedSchema {
  const checks: { field: string; re: RegExp; array: boolean }[] = [];
  for (const [field, p] of Object.entries((schema?.properties ?? {}) as Record<string, Json>)) {
    const own = typeof p?.pattern === "string" ? LOCAL_PATTERNS.get(p.pattern) : undefined;
    const item =
      typeof p?.items?.pattern === "string" ? LOCAL_PATTERNS.get(p.items.pattern) : undefined;
    if (own) checks.push({ field, re: own, array: false });
    else if (item) checks.push({ field, re: item, array: true });
  }
  if (checks.length === 0) return c;
  const zod = (c.zod as z.ZodType<Record<string, unknown>>).superRefine((v, rc) => {
    if (!v || typeof v !== "object") return;
    for (const { field, re, array } of checks) {
      const value = (v as Record<string, unknown>)[field];
      const list = array ? (Array.isArray(value) ? value : []) : value === undefined ? [] : [value];
      list.forEach((s, i) => {
        if (typeof s !== "string" || !re.test(s)) {
          rc.addIssue({
            code: "custom",
            path: array ? [field, i] : [field],
            message:
              field === "voice" || field === "language"
                ? "invalid value"
                : 'expected "artifact:<id>" or an https URL',
          });
        }
      });
    }
  });
  return { ...c, zod };
}

/** Throws for a video job that ended without output. */
function videoTerminalError(j: VideoJob): void {
  if (j.status === "failed" || j.status === "cancelled" || j.status === "expired") {
    throw new ProviderError(
      PROVIDER,
      `the video job ${j.id} ${j.status} on OpenRouter${j.error ? `: ${oneLine(j.error, 300)}` : "."}`,
    );
  }
}

export function runtimeOf(ctx: PackContext): OpenRouterRuntime {
  const r = (ctx as PackContext & { openrouter?: OpenRouterRuntime }).openrouter;
  return r instanceof OpenRouterRuntime ? r : new OpenRouterRuntime(ctx);
}
