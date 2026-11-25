// src/core/capabilities/router.ts
//
// The capability router behind ctx.capabilities (and ctx.llm.chat when a
// chat provider exists). Packs register providers at load; the router picks
// one per call:
//
//   1. An explicit `provider` runs that provider only (no fallback).
//   2. An explicit `model` narrows the candidates to providers whose
//      `models()` list it.
//   3. Otherwise: the user's preference order for the capability, then
//      priority (higher first), then provider id. Providers cooling
//      down after a rate limit go last. User-pack providers are only routed
//      to automatically once the user put them in the preference order.
//
// Fallback to the next candidate happens ONLY on a failure that provably
// happened before the provider accepted anything, so a paid job is never
// submitted twice:
//
//   - nothing non-idempotent was sent yet (only GET/HEAD so far): a network
//     error, HTTP 429, 401/403 or 5xx, or a provider that is not set up;
//   - a non-GET request was sent and was REFUSED: the connection never opened
//     (refused, DNS, TLS, connect timeout) or the answer was 429, 401 or 403;
//   - the provider says so itself by throwing CapabilityError with
//     retryable: true (it asserts that no paid job was accepted).
//
// An error that says the call may have been billed (`mayHaveCharged: true`,
// on the error or on a cause: the paid HTTP helpers of the bundled packs throw
// these) is final whatever else it carries, and so is any error that states
// `retryable: false` itself. Both hold for plain GET requests too, which the
// rules above would otherwise treat as free to repeat.
//
// Everything else after a non-GET request left the daemon is final. A 2xx
// answer means the job was accepted. A timeout, a reset connection or a 5xx
// answer is AMBIGUOUS (the provider may have accepted and billed the job
// without the answer arriving): the call fails and says to check the provider
// before retrying. Cancellation and invalid input never fall back.
//
// A provider bug or a refused request surfaces as is: nothing falls back on
// an arbitrary error.
//
// Every attempt is written to the usage ledger with the calling pack and
// tool, the provider, its pack and the model. A cost the provider reports is
// recorded on that row (`cost_estimated` in meta when the provider says it is
// an estimate) and noted in the cost scope, so the calling tool's own row
// does not count it again.
//
// The calling exposure profile limits the providers (see mcp/scope-for.ts): a
// provider whose pack the profile does not expose is not routed to, is left
// out of list() and has(), and an explicit `provider` naming it gets the same
// answer as an id that does not exist. The default profile and host code
// (no request scope) reach every provider.
//
// Providers run with THEIR pack's context (own secrets, network, library),
// cut per call by the pack's ScopedPackContext. Nothing of the caller's
// context reaches them besides the validated input and the abort signal.
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ZodError } from "zod";
import { atomicReplaceSync, writeFileAtomicSync } from "../../lib/platform.js";
import {
  DEFAULT_PROFILE_ID,
  currentScope,
  currentScopeAllowsProviderPack,
  currentScopeLimitsProviders,
} from "../mcp/scope.js";
import type {
  AnyProviderDefinition,
  CapabilityProviderInfo,
  CapabilityRunOptions,
  PackContext,
  PackServices,
  ProviderCost,
} from "../pack-api.js";
import { CapabilityError } from "../pack-api.js";
import type {
  CapabilityCaller,
  FetchObserver,
  HostCapabilities,
  HostLogger,
} from "../packs/context.js";
import type { PackSource } from "../packs/manifest.js";
import type { PolicyGate } from "../policy/gate.js";
import { splitMaxCost } from "../policy/max-cost.js";
import { MissingSecretError } from "../secrets/errors.js";
import { addAccountedCost } from "../tools/cost-scope.js";
import type { CallContext, UsageSink } from "../tools/registry.js";
import { type PaidCallCache, paidCacheKey, splitCacheFlag } from "./paid-cache.js";
import { CAPABILITY_NAMES, CAPABILITY_SCHEMAS, type CapabilityName } from "./schemas.js";

export const PROVIDER_ID_RE = /^[a-z][a-z0-9_-]{0,39}$/;
/** Cooldown after a rate limit without Retry-After. */
export const DEFAULT_COOLDOWN_MS = 60_000;
/** Longest cooldown a Retry-After header can ask for. */
export const MAX_COOLDOWN_MS = 10 * 60_000;
/** Deadline for one isConfigured() / models() probe. */
/** Probes run at once while listing providers. */
const LIST_CONCURRENCY = 12;
const PROBE_TIMEOUT_MS = 5_000;

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

/** What the router needs from a loaded pack to run one of its providers. */
export interface ProviderBinding {
  def: AnyProviderDefinition;
  /** Context for one provider call (the pack's own ScopedPackContext + services). */
  context(
    callCtx: CallContext,
    toolName: string,
    observer: FetchObserver,
  ): PackContext & PackServices;
}

const PROVIDER_COSTS: readonly ProviderCost[] = ["local", "account", "paid"];

interface Entry {
  capability: CapabilityName;
  id: string;
  pack: string;
  source: PackSource;
  priority: number;
  /** Routed only when named in the preference order (ProviderDefinition.optIn). */
  optIn: boolean;
  cost: ProviderCost;
  setupHint: string | null;
  order: number;
  binding: ProviderBinding;
}

export interface CapabilityPreferences {
  version: 1;
  order: Partial<Record<CapabilityName, string[]>>;
}

function prefsPath(home: string): string {
  return join(home, "capabilities.json");
}

/** The user's provider preference order per capability (`$PLUGHIVE_HOME/capabilities.json`). */
export function getCapabilityPreferences(home: string): CapabilityPreferences {
  const path = prefsPath(home);
  if (!existsSync(path)) return { version: 1, order: {} };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as { order?: unknown };
    const order: CapabilityPreferences["order"] = {};
    if (raw && typeof raw.order === "object" && raw.order) {
      for (const cap of CAPABILITY_NAMES) {
        const list = (raw.order as Record<string, unknown>)[cap];
        if (Array.isArray(list)) {
          order[cap] = list.filter(
            (x): x is string => typeof x === "string" && PROVIDER_ID_RE.test(x),
          );
        }
      }
    }
    return { version: 1, order };
  } catch {
    return { version: 1, order: {} };
  }
}

/** Replace the preference order of one capability (empty list clears it). */
export function setCapabilityPreference(
  home: string,
  capability: CapabilityName,
  order: readonly string[],
): CapabilityPreferences {
  return setCapabilityPreferences(home, { [capability]: order });
}

/**
 * Sets the preference order of several capabilities in one write (a preset).
 * An empty order clears that capability's preference; capabilities left out
 * keep theirs.
 */
export function setCapabilityPreferences(
  home: string,
  orders: Partial<Record<CapabilityName, readonly string[]>>,
): CapabilityPreferences {
  const entries = Object.entries(orders) as Array<[CapabilityName, readonly string[]]>;
  for (const [capability, order] of entries) {
    if (!(CAPABILITY_NAMES as readonly string[]).includes(capability)) {
      throw new TypeError(`unknown capability "${String(capability).slice(0, 40)}"`);
    }
    for (const id of order) {
      if (typeof id !== "string" || !PROVIDER_ID_RE.test(id)) {
        throw new TypeError(`invalid provider id "${String(id).slice(0, 40)}"`);
      }
    }
  }
  const prefs = getCapabilityPreferences(home);
  for (const [capability, order] of entries) {
    const unique = [...new Set(order)];
    if (unique.length === 0) delete prefs.order[capability];
    else prefs.order[capability] = unique;
  }
  mkdirSync(home, { recursive: true });
  const path = prefsPath(home);
  writeFileAtomicSync(path, `${JSON.stringify(prefs, null, 2)}\n`);
  return prefs;
}

export interface CapabilityRouterOptions {
  home: string;
  logger: HostLogger;
  usage?: UsageSink;
  /** Redacts secret values from messages (the secret store's redactor). */
  redact?: (text: string) => string;
  now?: () => number;
  /** The spend policy (src/core/policy): checked before each provider run. */
  gate?: Pick<PolicyGate, "beforeProvider"> &
    Partial<Pick<PolicyGate, "runProvider" | "beforeCachedProvider">>;
  /**
   * The paid-call cache (paid-cache.ts): a repeat of a paid call that saved
   * artifacts returns the saved result. Checked before probes, estimates and
   * approvals. Off when absent.
   */
  paidCache?: PaidCallCache;
}

interface Attempt {
  lastStatus: number | null;
  retryAfterMs: number | null;
  /** A non-GET request was handed to the transport. */
  dispatched: boolean;
  /** A non-GET request was answered 2xx: a job exists upstream. */
  accepted: boolean;
  /** A non-GET request ended without a clear refusal (timeout, reset, 5xx). */
  ambiguous: boolean;
}

/** Failures of a connection that never opened: no request byte was sent. */
const PRE_SEND_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** True when the request provably never left: the connection was not established. */
export function failedBeforeSend(err: unknown, seen = 0): boolean {
  if (!err || typeof err !== "object" || seen > 4) return false;
  const e = err as { code?: unknown; cause?: unknown };
  if (typeof e.code === "string" && PRE_SEND_CODES.has(e.code)) return true;
  return failedBeforeSend(e.cause, seen + 1);
}

const isRead = (method: string): boolean => method === "GET" || method === "HEAD";

export const AMBIGUOUS_NOTE =
  "The request had already been sent, so the provider may have accepted (and billed) it: " +
  "check the provider before retrying. No other provider was tried.";

function withTimeout<T>(p: Promise<T> | T, ms: number, signal: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    Promise.resolve(p),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("probe timed out")), ms);
      timer.unref?.();
      signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
    }),
  ]).finally(() => clearTimeout(timer));
}

function parseRetryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return secs * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function isNetworkError(err: unknown, seen = 0): boolean {
  if (!err || typeof err !== "object" || seen > 4) return false;
  const e = err as { code?: unknown; name?: unknown; cause?: unknown };
  if (e.name === "TimeoutError") return true;
  if (typeof e.code === "string" && (NETWORK_CODES.has(e.code) || e.code.startsWith("UND_ERR_"))) {
    return true;
  }
  // undici: TypeError("fetch failed") with the socket error as the cause.
  return isNetworkError(e.cause, seen + 1);
}

/** The error, or one of its causes, says the call may have been billed. */
export function saysMayHaveCharged(err: unknown, seen = 0): boolean {
  if (!err || typeof err !== "object" || seen > 4) return false;
  const e = err as { mayHaveCharged?: unknown; cause?: unknown };
  if (e.mayHaveCharged === true) return true;
  return saysMayHaveCharged(e.cause, seen + 1);
}

/** The error, or one of its causes, states `retryable: false` itself. */
function saysNotRetryable(err: unknown, seen = 0): boolean {
  if (!err || typeof err !== "object" || seen > 4) return false;
  const e = err as { retryable?: unknown; cause?: unknown };
  if (e.retryable === false) return true;
  return saysNotRetryable(e.cause, seen + 1);
}

function isAbort(err: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  const name = (err as { name?: unknown })?.name;
  return name === "AbortError";
}

/** True when a user pack called `pack` may register the provider id `id`. */
export function ownsProviderId(pack: string, id: string): boolean {
  return id === pack || id.startsWith(`${pack}-`) || id.startsWith(`${pack}_`);
}

export class CapabilityRouter implements HostCapabilities {
  private readonly entries = new Map<CapabilityName, Entry[]>();
  private readonly cooldown = new Map<string, number>();
  private order = 0;
  private prefsCache: { mtimeMs: number; prefs: CapabilityPreferences } | null = null;
  private readonly now: () => number;

  constructor(private readonly opts: CapabilityRouterOptions) {
    this.now = opts.now ?? Date.now;
  }

  /**
   * Replace every provider of `pack` (atomic: on a problem nothing changes).
   * Throws on an invalid definition or an id another pack already uses for
   * the same capability.
   */
  registerPack(pack: string, source: PackSource, bindings: readonly ProviderBinding[]): void {
    const fresh: Entry[] = [];
    const seen = new Set<string>();
    for (const binding of bindings) {
      const def = binding.def as Partial<AnyProviderDefinition> | null;
      if (!def || typeof def !== "object")
        throw new Error("a provider definition must be an object");
      const cap = def.capability;
      if (!(CAPABILITY_NAMES as readonly unknown[]).includes(cap)) {
        throw new Error(`provider: unknown capability "${String(cap).slice(0, 40)}"`);
      }
      const capability = cap as CapabilityName;
      const id = String(def.id);
      if (!PROVIDER_ID_RE.test(id)) {
        throw new Error(
          `provider id "${id.slice(0, 40)}" must start with a lowercase letter and use a-z, 0-9, "_" or "-" (max 40)`,
        );
      }
      // Preferences and explicit requests name a provider by id alone, so a
      // user pack may only use ids under its own pack id. It can then never
      // take an id a bundled pack uses (now, or once that pack is enabled
      // again) and inherit the place the user gave that id.
      if (source !== "builtin" && !ownsProviderId(pack, id)) {
        throw new Error(
          `provider id "${id}" must be "${pack}" or start with "${pack}-" or "${pack}_" (a user pack names its providers after itself)`,
        );
      }
      if (typeof def.run !== "function" || typeof def.isConfigured !== "function") {
        throw new Error(`provider "${id}" (${capability}) needs run() and isConfigured()`);
      }
      if (def.models !== undefined && typeof def.models !== "function") {
        throw new Error(`provider "${id}" (${capability}): models must be a function`);
      }
      const key = `${capability}:${id}`;
      if (seen.has(key)) throw new Error(`provider "${id}" is declared twice for ${capability}`);
      seen.add(key);
      const taken = (this.entries.get(capability) ?? []).find(
        (e) => e.id === id && e.pack !== pack,
      );
      if (taken) {
        throw new Error(
          `provider id "${id}" for ${capability} is already used by the pack "${taken.pack}"`,
        );
      }
      const priority = def.priority ?? 0;
      if (typeof priority !== "number" || !Number.isFinite(priority)) {
        throw new Error(`provider "${id}" (${capability}): priority must be a number`);
      }
      const cost = def.cost ?? "paid";
      if (!PROVIDER_COSTS.includes(cost)) {
        throw new Error(`provider "${id}" (${capability}): cost must be local, account or paid`);
      }
      fresh.push({
        capability,
        id,
        pack,
        source,
        priority,
        optIn: def.optIn === true,
        cost,
        setupHint:
          typeof def.setupHint === "string" && def.setupHint.trim()
            ? def.setupHint.trim().slice(0, 300)
            : null,
        order: this.order++,
        binding,
      });
    }
    this.unregisterPack(pack);
    for (const e of fresh) {
      const list = this.entries.get(e.capability) ?? [];
      list.push(e);
      this.entries.set(e.capability, list);
    }
  }

  unregisterPack(pack: string): void {
    for (const [cap, list] of this.entries) {
      const kept = list.filter((e) => e.pack !== pack);
      if (kept.length) this.entries.set(cap, kept);
      else this.entries.delete(cap);
    }
  }

  has(capability: CapabilityName): boolean {
    const prefs = this.preferences().order[capability] ?? [];
    return this.visible(capability).some((e) => this.autoRoute(e, prefs));
  }

  async list(capability?: CapabilityName): Promise<CapabilityProviderInfo[]> {
    const caps = capability ? [capability] : [...CAPABILITY_NAMES];
    const prefsAll = this.preferences().order;
    const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS * 2);
    const jobs: Array<{ cap: CapabilityName; e: Entry; prefs: readonly string[] }> = [];
    for (const cap of caps) {
      const prefs = prefsAll[cap] ?? [];
      for (const e of this.ordered(cap, prefs)) jobs.push({ cap, e, prefs });
    }
    // Probes are independent (secret lookups, binary checks, model lists), so run
    // them side by side, a few at a time, instead of one after another: the
    // dashboard waits on this list. The order of the result stays the same.
    const out: CapabilityProviderInfo[] = new Array(jobs.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (let i = next++; i < jobs.length; i = next++) {
        const { cap, e, prefs } = jobs[i] as (typeof jobs)[number];
        const ctx = this.contextFor(e, { signal }, "list", {});
        const [configured, models] = await Promise.all([
          this.probeConfigured(e, ctx, signal),
          this.probeModels(e, ctx, signal),
        ]);
        const until = this.cooldown.get(`${cap}:${e.id}`) ?? 0;
        const idx = prefs.indexOf(e.id);
        out[i] = {
          capability: cap,
          id: e.id,
          pack: e.pack,
          priority: e.priority,
          configured,
          models,
          coolingDownUntil: until > this.now() ? new Date(until).toISOString() : null,
          preferred: idx >= 0 ? idx : null,
          autoRoute: this.autoRoute(e, prefs),
          cost: e.cost,
          setupHint: e.setupHint,
        };
      }
    };
    await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, jobs.length) }, worker));
    return out;
  }

  async run(
    capability: CapabilityName,
    rawInput: unknown,
    runOpts: CapabilityRunOptions,
    caller: CapabilityCaller,
  ): Promise<unknown> {
    const schema = CAPABILITY_SCHEMAS[capability];
    if (!schema) throw new TypeError(`unknown capability "${String(capability).slice(0, 40)}"`);
    // Invalid input is the caller's problem: fail before any provider runs.
    const flag = splitCacheFlag(rawInput);
    const call = splitMaxCost(flag.input, runOpts.maxCostUsd);
    const input = schema.input.parse(call.input) as Record<string, unknown>;
    const model =
      typeof runOpts.model === "string" && runOpts.model !== ""
        ? runOpts.model
        : typeof input.model === "string" && input.model !== ""
          ? input.model
          : undefined;
    const signal = caller.signal;
    const prefs = this.preferences().order[capability] ?? [];
    const all = this.visible(capability);

    const profile = currentScope()?.profileId ?? DEFAULT_PROFILE_ID;
    const cache = flag.noCache || runOpts.cache === false ? undefined : this.opts.paidCache;
    const cacheKey = cache
      ? paidCacheKey({ capability, provider: runOpts.provider, model, input, profile })
      : undefined;
    if (cache && cacheKey) {
      const hit = await this.cachedResult(cache, cacheKey, capability, all, input, caller);
      if (hit) return hit;
    }

    let candidates: Entry[];
    if (runOpts.provider !== undefined) {
      const chosen = all.find((e) => e.id === runOpts.provider);
      if (!chosen) {
        throw new CapabilityError(
          `no provider "${String(runOpts.provider).slice(0, 40)}" for ${capability}; list_media_providers shows the ones that exist`,
          { code: "UNKNOWN_PROVIDER" },
        );
      }
      candidates = [chosen];
    } else {
      candidates = this.ordered(capability, prefs).filter((e) => this.autoRoute(e, prefs));
    }

    const callCtx: CallContext = {
      signal,
      depth: caller.depth,
      caller: caller.pack,
      ...(caller.progress ? { progress: caller.progress } : {}),
    };
    const configured: Entry[] = [];
    const unconfigured: Entry[] = [];
    for (const e of candidates) {
      const ctx = this.contextFor(e, callCtx, `provider:${capability}`, {});
      if (await this.probeConfigured(e, ctx, signal)) configured.push(e);
      else unconfigured.push(e);
    }
    if (signal.aborted) throw new Error(`${capability} was cancelled`);

    let ready = configured;
    if (model !== undefined && runOpts.provider === undefined) {
      const serving: Entry[] = [];
      for (const e of configured) {
        const ctx = this.contextFor(e, callCtx, `provider:${capability}`, {});
        const models = await this.probeModels(e, ctx, signal);
        if (models?.includes(model)) serving.push(e);
      }
      if (serving.length === 0) {
        throw new CapabilityError(
          `no configured ${capability} provider serves the model "${model.slice(0, 80)}"`,
          { code: "NO_PROVIDER_FOR_MODEL" },
        );
      }
      ready = serving;
    }
    if (ready.length === 0) {
      throw new CapabilityError(
        this.noProviderMessage(capability, unconfigured, runOpts.provider),
        {
          code: "NO_PROVIDER",
        },
      );
    }

    let lastErr: unknown = null;
    const skipped: string[] = [];
    for (let i = 0; i < ready.length; i++) {
      const e = ready[i] as Entry;
      const attempt: Attempt = {
        lastStatus: null,
        retryAfterMs: null,
        dispatched: false,
        accepted: false,
        ambiguous: false,
      };
      const observer: FetchObserver = {
        onRequest: ({ method }) => {
          if (!isRead(method)) attempt.dispatched = true;
        },
        onResponse: ({ method, status, headers }) => {
          attempt.lastStatus = status;
          if (status === 429 || status === 503) {
            attempt.retryAfterMs = parseRetryAfter(headers.get("retry-after"), this.now());
          }
          if (isRead(method)) return;
          attempt.dispatched = true;
          if (status >= 200 && status < 300) attempt.accepted = true;
          // 429, 401 and 403 are refusals; a 5xx says nothing about the job.
          else if (status >= 500) attempt.ambiguous = true;
        },
        onError: ({ method, error }) => {
          if (isRead(method)) return;
          attempt.dispatched = true;
          if (!failedBeforeSend(error)) attempt.ambiguous = true;
        },
      };
      const ctx = this.contextFor(e, callCtx, `provider:${capability}`, observer);
      // A local backend or the user's own account/subscription charges nothing
      // per call, so without its own estimate it counts as $0 rather than
      // "cost unknown" (which max_cost_usd would skip).
      const estimate =
        e.binding.def.estimate?.bind(e.binding.def) ??
        (e.cost === "local"
          ? () => ({ usd: 0, basis: "local backend (no charge)" })
          : e.cost === "account"
            ? () => ({ usd: 0, basis: "your own account or subscription (no per-call charge)" })
            : undefined);
      const gateCheck = {
        capability,
        provider: e.id,
        input,
        ...(estimate ? { estimate: () => estimate(input as never, ctx as never) } : {}),
        ...(call.maxCostUsd !== undefined ? { maxCostUsd: call.maxCostUsd } : {}),
        more: i < ready.length - 1 && runOpts.provider === undefined,
        signal,
      };
      const execute = async (): Promise<{ retry: boolean; result?: Record<string, unknown> }> => {
        const start = this.now();
        try {
          const out = await e.binding.def.run(input as never, ctx as never);
          const parsed = schema.output.parse({ ...(out as object), provider: e.id }) as Record<
            string,
            unknown
          >;
          this.record(capability, e, caller, start, "ok", null, parsed);
          if (cache && cacheKey && e.cost === "paid") {
            try {
              cache.put({
                key: cacheKey,
                capability,
                provider: e.id,
                pack: e.pack,
                result: parsed,
              });
            } catch (err) {
              this.opts.logger.warn(
                { capability, provider: e.id, error: String(err).slice(0, 200) },
                "could not save the paid result to the cache",
              );
            }
          }
          return { retry: false, result: parsed };
        } catch (err) {
          lastErr = err;
          const message = this.redact(err instanceof Error ? err.message : String(err));
          this.record(capability, e, caller, start, "error", message, { model });
          const verdict = this.classify(err, attempt, signal);
          if (verdict.rateLimited) {
            const ms = Math.min(MAX_COOLDOWN_MS, verdict.retryAfterMs ?? DEFAULT_COOLDOWN_MS);
            this.cooldown.set(`${capability}:${e.id}`, this.now() + ms);
          }
          const more = i < ready.length - 1;
          if (!verdict.retryable || !more || runOpts.provider !== undefined) {
            throw this.finalError(err, e, capability, verdict.ambiguous);
          }
          this.opts.logger.warn(
            { capability, provider: e.id, pack: e.pack, error: message.slice(0, 300) },
            "capability provider failed, trying the next one",
          );
          return { retry: true };
        }
      };
      if (this.opts.gate?.runProvider) {
        const res = await this.opts.gate.runProvider(gateCheck, skipped, execute);
        if (!res.ran) continue;
        if (!res.value.retry) return res.value.result as Record<string, unknown>;
        continue;
      }
      if (this.opts.gate && !(await this.opts.gate.beforeProvider(gateCheck, skipped))) continue;
      const res = await execute();
      if (!res.retry) return res.result as Record<string, unknown>;
    }
    throw this.finalError(lastErr, ready[ready.length - 1] as Entry, capability);
  }

  // -------------------------------------------------------------------------

  /**
   * A saved result for this call, when its provider is still registered and
   * visible to the caller and every artifact is still in the library. It is
   * recorded on the ledger at no cost, with `cached: true` in its meta.
   */
  private async cachedResult(
    cache: PaidCallCache,
    key: string,
    capability: CapabilityName,
    visible: readonly Entry[],
    input: Record<string, unknown>,
    caller: CapabilityCaller,
  ): Promise<Record<string, unknown> | null> {
    let entry: ReturnType<PaidCallCache["get"]>;
    try {
      entry = cache.get(key);
    } catch {
      return null;
    }
    if (!entry || entry.capability !== capability) return null;
    const e = visible.find((v) => v.id === entry.provider && v.pack === entry.pack);
    if (!e) return null;
    const schema = CAPABILITY_SCHEMAS[capability];
    const parsed = schema.output.safeParse({
      ...entry.result,
      provider: e.id,
      cost_usd: 0,
      cached: true,
    });
    if (!parsed.success) return null;
    await this.opts.gate?.beforeCachedProvider?.({
      capability,
      provider: e.id,
      input,
      signal: caller.signal,
    });
    const out = parsed.data as Record<string, unknown>;
    try {
      this.opts.usage?.record({
        tool: `capability:${capability}`,
        vendor: e.id,
        capability,
        provider: e.id,
        costUsd: null,
        latencyMs: 0,
        status: "ok",
        meta: {
          pack: caller.pack,
          caller: caller.pack,
          tool: caller.tool,
          provider: e.id,
          provider_pack: e.pack,
          cached: true,
          ...(typeof out.model === "string" ? { model: out.model.slice(0, 200) } : {}),
        },
      });
    } catch {
      // usage is best effort
    }
    return out;
  }

  private preferences(): CapabilityPreferences {
    const path = prefsPath(this.opts.home);
    let mtimeMs = -1;
    try {
      mtimeMs = statSync(path).mtimeMs;
    } catch {
      mtimeMs = -1;
    }
    if (this.prefsCache && this.prefsCache.mtimeMs === mtimeMs) return this.prefsCache.prefs;
    const prefs =
      mtimeMs < 0 ? { version: 1 as const, order: {} } : getCapabilityPreferences(this.opts.home);
    this.prefsCache = { mtimeMs, prefs };
    return prefs;
  }

  /** The providers of `capability` the running request may reach (a fresh array). */
  private visible(capability: CapabilityName): Entry[] {
    return (this.entries.get(capability) ?? []).filter((e) =>
      currentScopeAllowsProviderPack(e.pack),
    );
  }

  private autoRoute(e: Entry, prefs: readonly string[]): boolean {
    return (e.source === "builtin" && !e.optIn) || prefs.includes(e.id);
  }

  private ordered(capability: CapabilityName, prefs: readonly string[]): Entry[] {
    const now = this.now();
    const rank = (e: Entry) => {
      const idx = prefs.indexOf(e.id);
      return idx >= 0 ? idx : Number.MAX_SAFE_INTEGER;
    };
    const cooling = (e: Entry) => ((this.cooldown.get(`${capability}:${e.id}`) ?? 0) > now ? 1 : 0);
    return this.visible(capability).sort(
      (a, b) =>
        cooling(a) - cooling(b) ||
        rank(a) - rank(b) ||
        b.priority - a.priority ||
        // Not registration order: packs load in no promised order, and the
        // route must not depend on it.
        a.id.localeCompare(b.id) ||
        a.pack.localeCompare(b.pack),
    );
  }

  private contextFor(
    e: Entry,
    callCtx: CallContext,
    toolName: string,
    observer: FetchObserver,
  ): PackContext & PackServices {
    return e.binding.context(callCtx, toolName, observer);
  }

  private async probeConfigured(e: Entry, ctx: PackContext, signal: AbortSignal): Promise<boolean> {
    try {
      return (
        (await withTimeout(e.binding.def.isConfigured(ctx as never), PROBE_TIMEOUT_MS, signal)) ===
        true
      );
    } catch {
      return false;
    }
  }

  private async probeModels(
    e: Entry,
    ctx: PackContext,
    signal: AbortSignal,
  ): Promise<string[] | null> {
    const fn = e.binding.def.models;
    if (!fn) return null;
    try {
      const models = await withTimeout(fn(ctx as never), PROBE_TIMEOUT_MS, signal);
      return Array.isArray(models)
        ? models.filter((m): m is string => typeof m === "string").slice(0, 500)
        : null;
    } catch {
      return null;
    }
  }

  private classify(
    err: unknown,
    attempt: Attempt,
    signal: AbortSignal,
  ): { retryable: boolean; rateLimited: boolean; retryAfterMs: number | null; ambiguous: boolean } {
    if (isAbort(err, signal) || err instanceof ZodError) {
      return { retryable: false, rateLimited: false, retryAfterMs: null, ambiguous: false };
    }
    if (saysMayHaveCharged(err)) {
      // Money may have moved: final, whatever the error says about retrying.
      return {
        retryable: false,
        rateLimited: attempt.lastStatus === 429,
        retryAfterMs: attempt.retryAfterMs,
        ambiguous: true,
      };
    }
    if (err instanceof CapabilityError) {
      const status = err.status ?? attempt.lastStatus;
      return {
        // The provider's own verdict wins: retryable asserts no job was accepted.
        retryable: err.retryable,
        rateLimited: status === 429,
        retryAfterMs: err.retryAfterMs ?? attempt.retryAfterMs,
        ambiguous: false,
      };
    }
    const rateLimited = attempt.lastStatus === 429;
    if (attempt.accepted || attempt.ambiguous) {
      // A job is, or may be, running (and billed) upstream: never submit it elsewhere.
      return {
        retryable: false,
        rateLimited,
        retryAfterMs: attempt.retryAfterMs,
        ambiguous: attempt.ambiguous && !attempt.accepted,
      };
    }
    // The error's own verdict: a helper that knows the call must not be
    // repeated says so, and the status alone never overrules it.
    if (saysNotRetryable(err)) {
      return {
        retryable: false,
        rateLimited,
        retryAfterMs: attempt.retryAfterMs,
        ambiguous: false,
      };
    }
    // From here every non-GET request that was sent was clearly refused (the
    // connection never opened, or a 3xx/4xx answer), so nothing is running.
    const status = attempt.lastStatus;
    const retryable =
      (err instanceof MissingSecretError && !attempt.dispatched) ||
      isNetworkError(err) ||
      failedBeforeSend(err) ||
      status === 429 ||
      status === 401 ||
      status === 403 ||
      (status !== null && status >= 500 && status <= 599);
    return { retryable, rateLimited, retryAfterMs: attempt.retryAfterMs, ambiguous: false };
  }

  private finalError(err: unknown, e: Entry, capability: CapabilityName, ambiguous = false): Error {
    if (err instanceof CapabilityError || err instanceof MissingSecretError) return err;
    const message = this.redact(err instanceof Error ? err.message : String(err));
    const out = new Error(
      `${capability} via ${e.id} failed: ${message}${ambiguous ? ` ${AMBIGUOUS_NOTE}` : ""}`,
    ) as Error & { code?: string };
    const code = (err as { code?: unknown })?.code;
    if (typeof code === "string") out.code = code;
    if (err instanceof ZodError) out.code = "PROVIDER_BAD_OUTPUT";
    if (ambiguous) out.code = "PROVIDER_OUTCOME_UNKNOWN";
    return out;
  }

  private noProviderMessage(
    capability: CapabilityName,
    unconfigured: readonly Entry[],
    explicit: string | undefined,
  ): string {
    if (explicit !== undefined) {
      const e = unconfigured[0];
      const hint = e?.binding.def.setupHint ? ` (${e.binding.def.setupHint})` : "";
      return `the ${capability} provider "${explicit.slice(0, 40)}" is not set up${hint}`;
    }
    const hints = unconfigured.map(
      (e) => `${e.id}: ${e.binding.def.setupHint ?? `configure the "${e.pack}" pack`}`,
    );
    if (hints.length === 0) {
      // The same words whether or not a hidden provider exists: only the fact
      // that the caller is on a limited profile changes the text.
      return currentScopeLimitsProviders()
        ? `no provider for ${capability} is available in this profile. Add a pack that provides it to the profile.`
        : `no provider for ${capability} is installed. Enable a pack that provides it.`;
    }
    return `no ${capability} provider is set up. Any of these enables it: ${hints.join("; ")}`;
  }

  private redact(text: string): string {
    return this.opts.redact ? this.opts.redact(text) : text;
  }

  private record(
    capability: CapabilityName,
    e: Entry,
    caller: CapabilityCaller,
    start: number,
    status: "ok" | "error",
    error: string | null,
    out: Record<string, unknown>,
  ): void {
    const reported = out.cost_usd;
    const cost =
      typeof reported === "number" && Number.isFinite(reported) && reported > 0 ? reported : null;
    const model = typeof out.model === "string" ? out.model.slice(0, 200) : null;
    // A provider that prices a call from a table (not from the upstream's
    // bill) says so with `cost_estimated: true`.
    const estimated = out.cost_estimated === true;
    try {
      this.opts.usage?.record({
        tool: `capability:${capability}`,
        vendor: e.id,
        capability,
        provider: e.id,
        costUsd: cost,
        latencyMs: this.now() - start,
        status,
        ...(error ? { error } : {}),
        meta: {
          pack: caller.pack,
          caller: caller.pack,
          tool: caller.tool,
          provider: e.id,
          provider_pack: e.pack,
          ...(model ? { model } : {}),
          ...(cost !== null ? { cost_estimated: estimated } : {}),
        },
      });
      // Only once it is on the ledger: the calling tool leaves this amount out.
      if (this.opts.usage) addAccountedCost(cost);
    } catch {
      // usage is best effort
    }
  }
}
