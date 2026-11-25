// packs/replicate/runtime.ts
//
// Per-load state for the Replicate pack: the catalog cache and the prediction
// runner shared by replicate_run, the generated per-model tools and the
// capability functions.
import { join } from "node:path";
import type { PackContext, PackFetch } from "plughive/pack";
import {
  API_HOST,
  type ModelSpec,
  PROVIDER,
  type Prediction,
  ReplicateClient,
  checkPredictionId,
  isReplicateFile,
  logProgress,
  parseModelRef,
} from "./client.js";
import {
  type ConvertedSchema,
  type Json,
  JsonCache,
  MAX_FILE_BYTES,
  ProviderError,
  type RunResult,
  checkInputUrls,
  elapsedFraction,
  finishRun,
  numberSetting,
  oneLine,
  poll,
  resolveArtifactRefs,
  toZod,
  validateInput,
  withJobContext,
} from "./common.js";

export const SECRET = "REPLICATE_API_TOKEN";
/** Replicate accepts data URLs up to 256 KB; bigger inputs are uploaded to /v1/files. */
export const MAX_INLINE_BYTES = 256 * 1024;
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

/** How to collect a prediction later without paying again. */
/** Trainings run far longer than predictions: wait at least this long. */
export const MIN_TRAINING_WAIT_MINUTES = 120;

export function trainingHint(trainingId: string): string {
  return `the training ${trainingId} may still finish; collect it with replicate_get_training {training_id: "${trainingId}"} instead of starting another (see https://replicate.com/trainings)`;
}

/** What a finished training gives back: the new version to run, and where its weights are. */
export interface TrainingResult {
  provider: string;
  trainer: string;
  training_id: string;
  destination: string;
  status: string;
  /** "owner/name:<version>", ready for replicate_run. */
  version: string | null;
  weights_url: string | null;
  message: string;
}

const TRAINED_VERSION = /^[A-Za-z0-9._-]{1,100}\/[A-Za-z0-9._-]{1,100}:[a-f0-9]{64}$/;

function trainingOutput(p: Prediction, trainer: string, destination: string): TrainingResult {
  const out = p.output;
  const version =
    typeof out?.version === "string" && TRAINED_VERSION.test(out.version) ? out.version : null;
  const weights =
    typeof out?.weights === "string" &&
    /^https:\/\/\S+$/.test(out.weights) &&
    out.weights.length <= 2048
      ? out.weights
      : null;
  return {
    provider: PROVIDER,
    trainer,
    training_id: p.id,
    destination,
    status: p.status,
    version,
    weights_url: weights,
    message: version
      ? `Trained. Run it with replicate_run {model: "${version}", input: {prompt: ...}} and put the trigger word in the prompt.`
      : "The training succeeded but Replicate returned no new version; check https://replicate.com/trainings.",
  };
}

export function recoverHint(predictionId: string): string {
  return `call replicate_get_result with {"prediction_id":"${predictionId}"}`;
}

export interface PendingResult {
  status: string;
  prediction_id: string;
  message: string;
}

export class ReplicateRuntime {
  readonly cache: JsonCache;
  /** Model id (owner/name) -> generated tool name, for the models that got one. */
  readonly registered = new Map<string, string>();
  /** Fetch bound to the pack lifetime, not to a call: used to cancel after the call aborted. */
  readonly lifetimeFetch: PackFetch;
  private readonly converted = new Map<string, ConvertedSchema>();
  /** First poll delay; tests lower it. */
  pollInitialMs = 1000;

  constructor(ctx: PackContext) {
    const ttlHours = numberSetting(ctx.settings, "cache_ttl_hours", 24, 0, 24 * 30);
    this.cache = new JsonCache(join(ctx.pack.dataDir, "catalog-cache"), ttlHours * 3_600_000);
    this.lifetimeFetch = ctx.fetch;
  }

  client(fetch: PackFetch): ReplicateClient {
    return new ReplicateClient(fetch);
  }

  /** Spec from the cache or the API. Null when Replicate does not know the model. */
  async spec(
    ctx: PackContext,
    raw: string,
    key: string,
    opts: { fresh?: boolean; signal?: AbortSignal } = {},
  ): Promise<ModelSpec | null> {
    const ref = parseModelRef(raw);
    const cacheKey = `spec:${ref.id}${ref.version ? `:${ref.version}` : ""}`;
    const hit = await this.cache.get(cacheKey);
    // A pinned version never changes, so any cached copy is good; otherwise
    // `fresh` always asks the API (describe must show what run will use).
    if (hit && (ref.version !== null || (!opts.fresh && hit.fresh)))
      return hit.value as ModelSpec | null;
    try {
      const spec = await this.client(ctx.fetch).model(ref, key, opts.signal ?? ctx.signal);
      await this.cache.set(cacheKey, spec);
      return spec;
    } catch (e) {
      if (hit && !(e instanceof ProviderError && (e.status === 401 || e.status === 403))) {
        return hit.value as ModelSpec | null;
      }
      throw e;
    }
  }

  /** A spec from the disk cache only (startup without a token or network). */
  async cachedSpec(raw: string): Promise<ModelSpec | null> {
    const ref = parseModelRef(raw);
    const hit = await this.cache.get(`spec:${ref.id}${ref.version ? `:${ref.version}` : ""}`);
    return (hit?.value as ModelSpec | null | undefined) ?? null;
  }

  schemaFor(spec: ModelSpec): ConvertedSchema {
    const k = `${spec.id}:${spec.version ?? ""}`;
    let c = this.converted.get(k);
    if (!c) {
      c = spec.input ? toZod(spec.input) : { ...toZod({ type: "object" }), exact: false };
      this.converted.set(k, c);
    }
    return c;
  }

  /** Validate, create the prediction, poll and download. */
  async run(
    ctx: PackContext,
    model: string,
    input: Json,
    opts: { prompt?: string | null; skipValidation?: boolean; spec?: ModelSpec } = {},
  ): Promise<RunResult> {
    const ref = parseModelRef(model);
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ProviderError(PROVIDER, `input for ${ref.id} must be a JSON object`);
    }
    const key = await ctx.secrets.get(SECRET);
    const spec = opts.spec ?? (await this.spec(ctx, model, key));
    if (!spec) {
      throw new ProviderError(
        PROVIDER,
        `Replicate has no model "${ref.id}". Find one with replicate_search_models.`,
      );
    }
    if (!opts.skipValidation) validateInput(PROVIDER, ref.id, this.schemaFor(spec), input);

    const signal = ctx.signal;
    const callClient = this.client(ctx.fetch);
    const cancelClient = this.client(this.lifetimeFetch);
    const uploads: string[] = [];
    try {
      const payload = await resolveArtifactRefs(input, ctx, {
        maxInlineBytes: MAX_INLINE_BYTES,
        upload: (a) => this.uploadTracked(callClient, a, key, signal, uploads),
      });
      // The provider fetches URL inputs itself, so they are off unless allowed.
      checkInputUrls(payload, ctx.settings.allow_url_inputs === true);
      const maxWaitMs = numberSetting(ctx.settings, "max_wait_minutes", 30, 1, 240) * 60_000;

      ctx.progress?.(0.02, `starting ${ref.id}`);
      let current: Prediction = await callClient.create(spec, ref, payload, key, {
        cancelAfterSeconds: maxWaitMs / 1000 + 60,
        signal,
      });
      const id = current.id;
      const hint = recoverHint(id);
      const started = Date.now();
      return await withJobContext(PROVIDER, "Replicate prediction", id, hint, async () => {
        const final = await poll<Prediction>({
          provider: PROVIDER,
          signal,
          maxWaitMs,
          initialDelayMs: this.pollInitialMs,
          maxDelayMs: Math.max(this.pollInitialMs, 5_000),
          progress: ctx.progress,
          jobId: id,
          recoverHint: hint,
          cancel: () => cancelClient.cancel(current, key),
          check: async () => {
            if (!isTerminal(current.status)) current = await callClient.get(current, key, signal);
            const p = current;
            if (p.status === "succeeded") return { done: true, value: p };
            terminalError(p);
            if (p.status === "starting")
              return { done: false, fraction: 0.05, message: "starting (cold boot)" };
            const fromLogs = logProgress(p.logs);
            return {
              done: false,
              fraction:
                fromLogs !== null ? 0.1 + 0.8 * fromLogs : elapsedFraction(Date.now() - started),
              message: "running",
            };
          },
        });
        ctx.progress?.(0.95, "downloading results");
        const prompt = opts.prompt ?? (typeof input.prompt === "string" ? input.prompt : null);
        return this.finish(ctx, final, ref.id, key, prompt);
      });
    } finally {
      await this.deleteUploads(uploads, key);
    }
  }

  /**
   * Train `trainer` (owner/name:version) into `destination` (owner/name, must
   * exist) and wait for it. Weights are not downloaded: they stay on Replicate
   * as a new version of the destination model.
   */
  async train(
    ctx: PackContext,
    trainer: string,
    destination: string,
    input: Json,
  ): Promise<TrainingResult> {
    const t = parseModelRef(trainer);
    if (!t.version) {
      throw new ProviderError(
        PROVIDER,
        `the trainer must be pinned as "owner/name:<version>"; "${oneLine(trainer, 80)}" is not.`,
      );
    }
    const dest = parseModelRef(destination);
    if (dest.version) {
      throw new ProviderError(
        PROVIDER,
        `the destination is a model ("owner/name"), not a version.`,
      );
    }
    const key = await ctx.secrets.get(SECRET);
    const signal = ctx.signal;
    const callClient = this.client(ctx.fetch);
    const cancelClient = this.client(this.lifetimeFetch);
    const uploads: string[] = [];
    try {
      const payload = await resolveArtifactRefs(input, ctx, {
        maxInlineBytes: MAX_INLINE_BYTES,
        upload: (a) => this.uploadTracked(callClient, a, key, signal, uploads),
      });
      // The provider fetches URL inputs itself, so they are off unless allowed.
      checkInputUrls(payload, ctx.settings.allow_url_inputs === true);
      const maxWaitMs =
        Math.max(
          MIN_TRAINING_WAIT_MINUTES,
          numberSetting(ctx.settings, "max_wait_minutes", 30, 1, 240),
        ) * 60_000;
      ctx.progress?.(0.02, `starting a training of ${t.id}`);
      let current = await callClient.createTraining(t, dest, payload, key, signal);
      const id = current.id;
      const hint = trainingHint(id);
      const started = Date.now();
      return await withJobContext(PROVIDER, "Replicate training", id, hint, async () => {
        const final = await poll<Prediction>({
          provider: PROVIDER,
          signal,
          maxWaitMs,
          initialDelayMs: this.pollInitialMs,
          maxDelayMs: Math.max(this.pollInitialMs, 15_000),
          progress: ctx.progress,
          jobId: id,
          recoverHint: hint,
          cancel: () => cancelClient.cancel(current, key),
          check: async () => {
            if (!isTerminal(current.status)) current = await callClient.get(current, key, signal);
            const p = current;
            if (p.status === "succeeded") return { done: true, value: p };
            terminalError(p, "training");
            if (p.status === "starting")
              return { done: false, fraction: 0.05, message: "starting (cold boot)" };
            const fromLogs = logProgress(p.logs);
            return {
              done: false,
              fraction:
                fromLogs !== null ? 0.1 + 0.85 * fromLogs : elapsedFraction(Date.now() - started),
              message: "training",
            };
          },
        });
        return trainingOutput(final, t.id, dest.id);
      });
    } finally {
      await this.deleteUploads(uploads, key);
    }
  }

  /** One status check of a training an earlier call started. Never starts one. */
  async collectTraining(ctx: PackContext, trainingId: string): Promise<TrainingResult> {
    const id = checkPredictionId(trainingId);
    const key = await ctx.secrets.get(SECRET);
    return withJobContext(PROVIDER, "Replicate training", id, trainingHint(id), async () => {
      const p = await this.client(ctx.fetch).getTrainingById(id, key, ctx.signal);
      terminalError(p, "training");
      const trainer = p.model ?? "unknown";
      if (p.status === "succeeded") {
        const r = trainingOutput(p, trainer, "");
        // The new version names the destination model.
        r.destination = r.version?.split(":")[0] ?? "";
        return r;
      }
      return {
        provider: PROVIDER,
        trainer,
        training_id: p.id,
        destination: "",
        status: p.status || "unknown",
        version: null,
        weights_url: null,
        message: `The training is ${p.status || "in an unknown state"}; call replicate_get_training again later.`,
      };
    });
  }

  /**
   * Collect a prediction an earlier call created: one status check, then the
   * output if it succeeded. Never creates a prediction.
   */
  async collect(ctx: PackContext, predictionId: string): Promise<RunResult | PendingResult> {
    const id = checkPredictionId(predictionId);
    const key = await ctx.secrets.get(SECRET);
    return withJobContext(PROVIDER, "Replicate prediction", id, recoverHint(id), async () => {
      const p = await this.client(ctx.fetch).getById(id, key, ctx.signal);
      if (p.status === "succeeded") return this.finish(ctx, p, p.model ?? "unknown", key, null);
      terminalError(p);
      return {
        status: p.status || "unknown",
        prediction_id: p.id,
        message: `The prediction is ${p.status || "in an unknown state"}; call replicate_get_result again later.`,
      };
    });
  }

  private finish(
    ctx: PackContext,
    p: Prediction,
    model: string,
    key: string,
    prompt: string | null,
  ): Promise<RunResult> {
    return finishRun(
      ctx,
      p.output,
      {
        provider: PROVIDER,
        model,
        prompt,
        meta: {
          prediction_id: p.id,
          ...(typeof p.metrics?.predict_time === "number"
            ? { predict_time_s: p.metrics.predict_time }
            : {}),
        },
        recoverHint: recoverHint(p.id),
      },
      isReplicateFile,
      {
        maxBytes: MAX_FILE_BYTES,
        // Only API file links carry the token; CDN links are fetched without it.
        headersFor: (u) => (u.host === API_HOST ? { Authorization: `Bearer ${key}` } : undefined),
      },
    );
  }

  private async uploadTracked(
    client: ReplicateClient,
    a: { id: string; mime: string; bytes: Uint8Array },
    key: string,
    signal: AbortSignal | undefined,
    uploads: string[],
  ): Promise<string> {
    if (a.bytes.byteLength > MAX_UPLOAD_BYTES) {
      throw new ProviderError(PROVIDER, `artifact ${a.id} is over Replicate's 100 MB file limit.`);
    }
    const f = await client.upload(a.bytes, a.mime, key, signal);
    uploads.push(f.id);
    return f.url;
  }

  /**
   * Best-effort removal of the input files this run uploaded, through the
   * lifetime fetch so it still works after the call was cancelled.
   */
  private async deleteUploads(ids: string[], key: string): Promise<void> {
    if (ids.length === 0) return;
    const client = this.client(this.lifetimeFetch);
    await Promise.all(ids.map((id) => client.deleteFile(id, key)));
  }
}

/** Throws for a prediction that ended without output. */
function terminalError(p: Prediction, what = "prediction"): void {
  if (p.status === "failed") {
    throw new ProviderError(
      PROVIDER,
      `the ${what} ${p.id} failed on Replicate: ${oneLine(p.error ?? "no error message", 400)}`,
    );
  }
  if (p.status === "canceled" || p.status === "aborted") {
    throw new ProviderError(
      PROVIDER,
      `the ${what} ${p.id} was ${p.status} on Replicate before it finished.`,
    );
  }
}

function isTerminal(status: string): boolean {
  return (
    status === "succeeded" || status === "failed" || status === "canceled" || status === "aborted"
  );
}

export function runtimeOf(ctx: PackContext): ReplicateRuntime {
  const r = (ctx as PackContext & { replicate?: ReplicateRuntime }).replicate;
  return r instanceof ReplicateRuntime ? r : new ReplicateRuntime(ctx);
}
