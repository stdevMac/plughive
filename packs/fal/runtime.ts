// packs/fal/runtime.ts
//
// Per-load state for the fal pack: the catalog cache, bundled schema seeds and
// the queue runner shared by fal_run, the generated per-model tools, the
// capability functions and fal_get_result.
import { join } from "node:path";
import type { PackContext, PackFetch } from "plughive/pack";
import {
  FalClient,
  type ModelSpec,
  PROVIDER,
  type QueueHandle,
  checkFalId,
  foreignFileHosts,
  handleFor,
  isFalFile,
  parseSpec,
} from "./client.js";
import {
  CancelledError,
  type ConvertedSchema,
  type Json,
  JsonCache,
  ProviderError,
  type RunResult,
  checkInputUrls,
  elapsedFraction,
  finishRun,
  numberSetting,
  poll,
  resolveArtifactRefs,
  safeMessage,
  toZod,
  validateInput,
} from "./common.js";
import seedData from "./seeds.json" with { type: "json" };

export const SECRET = "FAL_KEY";
/** fal accepts data URIs for file inputs; bigger files need fal storage (not wired up). */
export const MAX_INLINE_BYTES = 20 * 1024 * 1024;
/** How long "fal does not know this id" is remembered. */
export const NEGATIVE_TTL_MS = 10 * 60_000;
/** Result fetches that may say "not ready" after the status said COMPLETED. */
export const MAX_NOT_READY_AFTER_COMPLETED = 3;

let seedSpecs: Map<string, ModelSpec> | null = null;
export function seeds(): Map<string, ModelSpec> {
  if (!seedSpecs) {
    seedSpecs = new Map();
    for (const m of (seedData as Json).models ?? []) {
      const spec = parseSpec(m);
      if (spec) seedSpecs.set(spec.id, spec);
    }
  }
  return seedSpecs;
}

export interface SpecOptions {
  /** Allow a catalog call. Default true. */
  network?: boolean;
  /** Prefer any cached or bundled copy over the network (startup). */
  preferOffline?: boolean;
  /** Use a bundled schema before the catalog (runs: validate without a network call). */
  preferSeed?: boolean;
  signal?: AbortSignal;
}

/** How to collect a fal job again without paying for it twice. */
export function recoverHint(model: string, requestId: string): string {
  return `call fal_get_result with {"model":"${model}","request_id":"${requestId}"}`;
}

interface Missing {
  $missing: number;
}
function isMissing(v: Json): v is Missing {
  return !!v && typeof v === "object" && typeof v.$missing === "number";
}

export interface PendingResult {
  status: string;
  model: string;
  request_id: string;
  queue_position?: number;
  message: string;
}

export class FalRuntime {
  readonly cache: JsonCache;
  /** Fetch bound to the pack lifetime, not to a call: used to cancel after the call aborted. */
  readonly lifetimeFetch: PackFetch;
  private readonly converted = new Map<string, ConvertedSchema>();
  /** Model id to the per-model tool registered for it. */
  readonly registered = new Map<string, string>();
  /** First poll delay; tests lower it. */
  pollInitialMs = 1000;

  constructor(ctx: PackContext) {
    const ttlHours = numberSetting(ctx.settings, "cache_ttl_hours", 24, 0, 24 * 30);
    this.cache = new JsonCache(join(ctx.pack.dataDir, "catalog-cache"), ttlHours * 3_600_000);
    this.lifetimeFetch = ctx.fetch;
  }

  client(fetch: PackFetch): FalClient {
    return new FalClient(fetch);
  }

  /** Model spec from the cache, the bundled seeds or the catalog. Null when fal does not know the id. */
  async spec(ctx: PackContext, id: string, opts: SpecOptions = {}): Promise<ModelSpec | null> {
    checkFalId(id);
    const key = `spec:${id}`;
    const raw = await this.cache.get(key);
    // An unknown id is remembered for a short time only: fal may publish it soon.
    const negative = raw && (isMissing(raw.value) || raw.value === null);
    const negativeFresh =
      negative && isMissing(raw.value) && Date.now() - raw.value.$missing < NEGATIVE_TTL_MS;
    const hit = raw && !negative ? raw : null;
    if (hit?.fresh || (hit && opts.preferOffline)) return hit.value as ModelSpec;
    const seed = seeds().get(id) ?? null;
    if (seed && (opts.preferOffline || opts.preferSeed)) return seed;
    if (negativeFresh) return null;
    if (opts.network === false) return (hit?.value as ModelSpec | undefined) ?? seed;
    try {
      const found = await this.client(ctx.fetch).specs([id], opts.signal ?? ctx.signal);
      const spec = found.get(id) ?? null;
      await this.cache.set(key, spec ?? ({ $missing: Date.now() } satisfies Missing));
      return spec;
    } catch (e) {
      if (hit) return hit.value as ModelSpec;
      if (seed) return seed;
      throw e;
    }
  }

  /** Several specs in one catalog call, offline sources first. Never throws. */
  async specsForStartup(
    ctx: PackContext,
    ids: string[],
    timeoutMs: number,
  ): Promise<Map<string, ModelSpec>> {
    const out = new Map<string, ModelSpec>();
    const missing: string[] = [];
    for (const id of ids) {
      const hit = await this.cache.get(`spec:${id}`);
      const cached = hit && !isMissing(hit.value) ? (hit.value as ModelSpec | null) : null;
      const spec = cached ?? seeds().get(id);
      if (spec) out.set(id, spec);
      else missing.push(id);
    }
    if (missing.length === 0) return out;
    try {
      const found = await this.client(ctx.fetch).specs(missing, AbortSignal.timeout(timeoutMs));
      for (const id of missing) {
        const spec = found.get(id);
        if (spec) {
          out.set(id, spec);
          await this.cache.set(`spec:${id}`, spec);
        }
      }
    } catch (e) {
      ctx.logger.warn("fal: could not fetch model schemas at startup; those tools are skipped", {
        models: missing,
        error: safeMessage(e),
      });
    }
    return out;
  }

  schemaFor(spec: ModelSpec): ConvertedSchema {
    let c = this.converted.get(spec.id);
    if (!c) {
      c = spec.input ? toZod(spec.input) : toZod({ type: "object" });
      if (!spec.input) c = { ...c, exact: false };
      this.converted.set(spec.id, c);
    }
    return c;
  }

  /** Validate, submit, poll and download. Used by every tool that runs a model. */
  async run(
    ctx: PackContext,
    model: string,
    input: Json,
    opts: {
      prompt?: string | null;
      skipValidation?: boolean;
      /** Extra result fields read from the raw output (before files become artifacts). */
      extra?: (value: Json) => Record<string, Json>;
    } = {},
  ): Promise<RunResult> {
    checkFalId(model);
    const spec = await this.spec(ctx, model, { preferSeed: true });
    if (!spec) {
      throw new ProviderError(
        PROVIDER,
        `fal has no model "${model}". Find one with fal_search_models.`,
      );
    }
    if (!opts.skipValidation) validateInput(PROVIDER, model, this.schemaFor(spec), input);

    const key = await ctx.secrets.get(SECRET);
    const payload = await resolveArtifactRefs(input, ctx, { maxInlineBytes: MAX_INLINE_BYTES });
    // The provider fetches URL inputs itself, so they are off unless allowed.
    checkInputUrls(payload, ctx.settings.allow_url_inputs === true);
    const signal = ctx.signal;
    const callClient = this.client(ctx.fetch);
    const cancelClient = this.client(this.lifetimeFetch);
    const maxWaitMs = numberSetting(ctx.settings, "max_wait_minutes", 30, 1, 240) * 60_000;

    ctx.progress?.(0.02, `submitting to ${model}`);
    const handle: QueueHandle = await callClient.submit(model, payload, key, signal);
    const hint = recoverHint(model, handle.requestId);
    const started = Date.now();
    let notReady = 0;
    const value = await withJobId(handle.requestId, hint, () =>
      poll<Json>({
        provider: PROVIDER,
        signal,
        maxWaitMs,
        initialDelayMs: this.pollInitialMs,
        maxDelayMs: Math.max(this.pollInitialMs, 10_000),
        progress: ctx.progress,
        jobId: handle.requestId,
        recoverHint: hint,
        cancel: () => cancelClient.cancel(handle, key),
        check: async () => {
          const st = await callClient.status(handle, key, signal);
          const status = String(st?.status ?? "");
          if (status === "IN_QUEUE") {
            const pos =
              typeof st.queue_position === "number" ? ` (position ${st.queue_position})` : "";
            return { done: false, fraction: 0.05, message: `queued${pos}` };
          }
          if (status === "COMPLETED") {
            const r = await callClient.result(handle, key, signal);
            if (r.done) return { done: true, value: r.value };
            if (++notReady > MAX_NOT_READY_AFTER_COMPLETED) {
              throw new ProviderError(
                PROVIDER,
                `fal reported the job COMPLETED but its result stayed unavailable after ${notReady} tries.`,
              );
            }
            return { done: false, fraction: 0.9, message: "finishing" };
          }
          return {
            done: false,
            fraction: elapsedFraction(Date.now() - started),
            message: "running",
          };
        },
      }),
    );
    ctx.progress?.(0.95, "downloading results");
    const result = await this.finish(
      ctx,
      model,
      handle.requestId,
      value,
      opts.prompt ?? (typeof input?.prompt === "string" ? input.prompt : null),
    );
    return opts.extra ? Object.assign(result, opts.extra(value)) : result;
  }

  /**
   * Collect a job submitted earlier (fal_get_result): one status check, then
   * the result when it is COMPLETED. Never submits anything.
   */
  async collect(
    ctx: PackContext,
    model: string,
    requestId: string,
  ): Promise<RunResult | PendingResult> {
    const handle = handleFor(model, requestId);
    const hint = recoverHint(model, requestId);
    const key = await ctx.secrets.get(SECRET);
    const client = this.client(ctx.fetch);
    return withJobId(requestId, hint, async () => {
      const st = await client.status(handle, key, ctx.signal);
      const status = String(st?.status ?? "UNKNOWN");
      const pending = (message: string): PendingResult => {
        const out: PendingResult = { status, model, request_id: requestId, message };
        if (typeof st?.queue_position === "number") out.queue_position = st.queue_position;
        return out;
      };
      if (status !== "COMPLETED") {
        return pending(
          `The job is ${status.toLowerCase().replace(/_/g, " ")}; call fal_get_result again later.`,
        );
      }
      const r = await client.result(handle, key, ctx.signal);
      if (!r.done)
        return pending("The job is complete but its result is not ready yet; try again shortly.");
      return this.finish(ctx, model, requestId, r.value, null);
    });
  }

  private async finish(
    ctx: PackContext,
    model: string,
    requestId: string,
    value: Json,
    prompt: string | null,
  ): Promise<RunResult> {
    const result = await finishRun(
      ctx,
      value,
      {
        provider: PROVIDER,
        model,
        prompt,
        meta: { request_id: requestId },
        recoverHint: recoverHint(model, requestId),
      },
      isFalFile,
    );
    const foreign = foreignFileHosts(value);
    if (foreign.length > 0) {
      result.warnings = [
        ...(result.warnings ?? []),
        `the output links file(s) on ${foreign.join(", ")}, which is not fal's CDN, so they were not downloaded into the library; the links are left in the output as they are.`,
      ];
    }
    return result;
  }
}

/** Adds the request id and recovery hint to provider errors that lack them. */
async function withJobId<T>(requestId: string, hint: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (
      e instanceof CancelledError ||
      !(e instanceof ProviderError) ||
      e.message.includes(requestId)
    ) {
      throw e;
    }
    const err = new ProviderError(
      PROVIDER,
      `${stripPrefix(e.message)} (fal request ${requestId}; do not resubmit, ${hint} to check it again).`,
      e.status,
    );
    throw err;
  }
}

function stripPrefix(msg: string): string {
  return msg.replace(/^fal: /, "").replace(/\.$/, "");
}

/** The pack's runtime from the tool ctx, or a fresh one (capability calls from outside). */
export function runtimeOf(ctx: PackContext): FalRuntime {
  const r = (ctx as PackContext & { fal?: FalRuntime }).fal;
  return r instanceof FalRuntime ? r : new FalRuntime(ctx);
}
