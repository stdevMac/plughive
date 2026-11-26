// src/core/workflows/runner.ts
//
// Runs a compiled recipe with one pack context. Every call goes through that
// context (ctx.tools.call / ctx.capabilities.run / ctx.library.save), so the
// pack's permissions.tools, the request's exposure profile, nested-call depth,
// redaction and metering apply exactly as they do to a pack's own code.
//
// Nothing is retried. A fallback (onError.fallback) is the recipe's own choice
// of a second step, with one guard: when the failed step is paid, its fallback
// is paid too, and the failure does not prove that nothing was charged, the
// fallback only runs if the recipe says so with onError.afterUnknownOutcome.
// Otherwise the run stops there, so paying twice for one piece of work is
// never implicit.
//
// A failure stops the run and reports the steps that
// completed, with their outputs (capped) and artifact ids, so the rest can be
// finished by hand. Cancelling the job (or the runtime limit) aborts the
// signal every call runs with.
import { ZodError } from "zod";
import { CapabilityError, type PackContext, PackPermissionError } from "../pack-api.js";
import { MissingSecretError } from "../secrets/errors.js";
import type { CompiledRecipe, CompiledStep } from "./compile.js";
import { type EvalScope, evaluate, isPlainObject, jsonLength, truthy } from "./expr.js";
import { WORKFLOW_LIMITS } from "./schema.js";
import { resolveValue } from "./template.js";

export interface StepRecord {
  id: string;
  title: string;
  status: "ok" | "skipped" | "failed" | "continued" | "fallback";
  ms: number;
  artifacts: string[];
  items?: number;
  note?: string;
  error?: string;
}

export interface WorkflowResult {
  workflow: string;
  ok: true;
  output: unknown;
  artifacts: { id: string; mime?: string; url?: string; step: string }[];
  steps: StepRecord[];
  notes: string[];
}

export class WorkflowError extends Error {
  readonly code = "WORKFLOW_FAILED";
  constructor(
    message: string,
    readonly detail: { completed: StepRecord[]; failed: StepRecord | null },
  ) {
    super(message);
    this.name = "WorkflowError";
  }
}

export interface RunOptions {
  ctx: PackContext;
  /** available("tool") answers, from the pre-flight. */
  available: Map<string, boolean>;
  /** Fires when the runtime limit is reached (to tell it apart from a cancel). */
  timeout?: AbortSignal;
  /**
   * Whether a step can cost money (the planner's rule, which also knows which
   * tools are capability backed). Absent: the recipe's own `paid` flag, else
   * every capability step.
   */
  paid?: (step: CompiledStep) => boolean;
}

/** Error codes of failures that happen before any provider or tool body runs. */
const NOTHING_RAN_CODES = new Set([
  "NO_PROVIDER",
  "NO_PROVIDER_FOR_MODEL",
  "UNKNOWN_PROVIDER",
  "UNKNOWN_TOOL",
  "INVALID_ARGUMENTS",
  "MISSING_SECRET",
  "PACK_PERMISSION_DENIED",
  "WORKFLOW_BLOCKED",
]);

/**
 * Does a failed call prove that nothing was charged? Only a short list does:
 * a missing key, a refused permission, an unknown tool or provider, invalid
 * arguments, or a provider that asserts it (CapabilityError retryable: true).
 * Everything else, a plain tool error included, leaves the outcome unknown;
 * `mayHaveCharged: true` anywhere on the error always does.
 */
export function provesNoCharge(err: unknown): boolean {
  for (let e: unknown = err, i = 0; e && typeof e === "object" && i < 5; i++) {
    if ((e as { mayHaveCharged?: unknown }).mayHaveCharged === true) return false;
    e = (e as { cause?: unknown }).cause;
  }
  if (err instanceof MissingSecretError || err instanceof PackPermissionError) return true;
  if (err instanceof ZodError) return true;
  if (err instanceof CapabilityError) return err.retryable || NOTHING_RAN_CODES.has(err.code);
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && NOTHING_RAN_CODES.has(code);
}

class StepFailure extends Error {
  constructor(
    readonly step: CompiledStep,
    readonly cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause));
  }
}

class Cancelled extends Error {}

const ARTIFACT_ID = /^[a-z]{3}_[A-Za-z0-9]{6,64}$/;

/** Artifact ids inside a value: {id, mime} objects and *_artifact_id / artifact_id strings. */
export function collectArtifacts(
  v: unknown,
  out: Map<string, { id: string; mime?: string; url?: string }> = new Map(),
  depth = 0,
  // Objects already looked at: a value that holds one object in many places
  // is walked once.
  seen: Set<object> = new Set(),
): Map<string, { id: string; mime?: string; url?: string }> {
  if (depth > 12 || v === null || typeof v !== "object" || seen.has(v)) return out;
  seen.add(v);
  if (Array.isArray(v)) {
    for (const x of v) collectArtifacts(x, out, depth + 1, seen);
    return out;
  }
  if (!isPlainObject(v)) return out;
  const id = v.id;
  if (typeof id === "string" && typeof v.mime === "string" && !out.has(id)) {
    out.set(id, {
      id,
      mime: v.mime,
      ...(typeof v.url === "string" ? { url: v.url } : {}),
    });
  }
  for (const [k, x] of Object.entries(v)) {
    if (
      typeof x === "string" &&
      (k === "artifact_id" || k.endsWith("_artifact_id")) &&
      ARTIFACT_ID.test(x)
    ) {
      if (!out.has(x)) out.set(x, { id: x });
    } else if (x !== null && typeof x === "object") collectArtifacts(x, out, depth + 1, seen);
  }
  return out;
}

/** JSON size of `v`, or a number over `max` (found without writing it all) when it is larger. */
function jsonSize(v: unknown, max: number): number {
  const atLeast = jsonLength(v, max);
  if (atLeast > max) return atLeast;
  try {
    return JSON.stringify(v)?.length ?? 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

/** Keep a step output under the cap; a larger one keeps its artifacts and the start of its text. */
export function capOutput(v: unknown, max = WORKFLOW_LIMITS.maxStepOutputBytes): unknown {
  const size = jsonSize(v, max);
  if (size <= max) return v;
  const text =
    isPlainObject(v) && typeof v.text === "string" ? v.text.slice(0, 16 * 1024) : undefined;
  return {
    truncated: true,
    // Counting stopped early for a much larger value: the size is a lower bound.
    bytes: Number.isFinite(size) ? size : null,
    artifacts: [...collectArtifacts(v).values()],
    ...(text !== undefined ? { text } : {}),
  };
}

/** Parse a model's JSON reply: plain JSON, or JSON inside a ``` fence, or the outermost {...}/[...]. */
export function parseJsonReply(text: string): unknown {
  const t = text.trim();
  const attempts: string[] = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) attempts.push(fence[1].trim());
  const first = t.search(/[[{]/);
  if (first >= 0) {
    const close = t[first] === "{" ? "}" : "]";
    const last = t.lastIndexOf(close);
    if (last > first) attempts.push(t.slice(first, last + 1));
  }
  for (const a of attempts) {
    try {
      return JSON.parse(a);
    } catch {
      /* next */
    }
  }
  throw new Error("the reply is not valid JSON");
}

async function pool<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  let failed: { err: unknown } | null = null;
  const worker = async () => {
    while (failed === null && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i] as T, i);
      } catch (err) {
        if (failed === null) failed = { err };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, worker),
  );
  if (failed !== null) throw (failed as { err: unknown }).err;
  return out;
}

export async function runRecipe(
  recipe: CompiledRecipe,
  input: Record<string, unknown>,
  opts: RunOptions,
): Promise<WorkflowResult> {
  const { ctx } = opts;
  const outputs: Record<string, unknown> = {};
  const records: StepRecord[] = [];
  const notes: string[] = [];
  const artifacts = new Map<string, { id: string; mime?: string; url?: string; step: string }>();
  const total = recipe.steps.length;
  const limits = { maxStringChars: WORKFLOW_LIMITS.maxTemplateChars };
  const available = (t: string) => opts.available.get(t) === true;

  const scopeFor = (loop?: { as: string; item: unknown; index: number }): EvalScope => ({
    roots: loop
      ? { input, steps: outputs, [loop.as]: loop.item, index: loop.index }
      : { input, steps: outputs },
    available,
  });

  const checkAlive = () => {
    if (ctx.signal.aborted) throw new Cancelled();
  };

  const isPaid = opts.paid ?? ((s: CompiledStep) => s.kind === "capability" || s.paid === true);

  const callOnce = async (
    step: CompiledStep,
    scope: EvalScope,
    state?: { called: boolean },
  ): Promise<unknown> => {
    checkAlive();
    switch (step.kind) {
      case "set":
        return resolveValue(step.value as never, scope, limits);
      case "save": {
        const save = step.save as NonNullable<CompiledStep["save"]>;
        const content = resolveValue(save.content, scope, limits);
        if (
          typeof content !== "string" &&
          jsonLength(content, WORKFLOW_LIMITS.maxArgsBytes * 4) > WORKFLOW_LIMITS.maxArgsBytes * 4
        ) {
          throw new Error("the content to save is too large");
        }
        const text =
          typeof content === "string" ? content : JSON.stringify(content ?? null, null, 2);
        if (text.length > WORKFLOW_LIMITS.maxArgsBytes * 4) {
          throw new Error("the content to save is too large");
        }
        const ref = await ctx.library.save({
          kind: save.kind,
          mime: save.mime,
          bytes: new TextEncoder().encode(text),
          meta: {
            workflow: recipe.name,
            step: step.id,
            ...(save.name ? { name: save.name } : {}),
          },
        });
        return { id: ref.id, url: ref.url, mime: ref.mime };
      }
      case "tool":
      case "capability": {
        const args = resolveValue(step.args as never, scope, limits);
        if (jsonSize(args, WORKFLOW_LIMITS.maxArgsBytes) > WORKFLOW_LIMITS.maxArgsBytes) {
          throw new Error(`the arguments are larger than ${WORKFLOW_LIMITS.maxArgsBytes} bytes`);
        }
        const target = step.target as string;
        if (state) state.called = true;
        const result =
          step.kind === "tool"
            ? await ctx.tools.call(target, args as Record<string, unknown>)
            : await ctx.capabilities.run(target as never, args as never);
        checkAlive();
        if (step.parse !== "json") return result;
        const text =
          typeof result === "string"
            ? result
            : isPlainObject(result) && typeof result.text === "string"
              ? result.text
              : undefined;
        if (text === undefined) throw new Error("parse: json needs a text reply");
        const json = parseJsonReply(text);
        return isPlainObject(result) ? { ...result, json } : { text, json };
      }
      default:
        throw new Error(`step kind ${step.kind} cannot be called`);
    }
  };

  /** One call with the step's onError. Returns the output, or undefined when it continued. */
  const attempt = async (
    step: CompiledStep,
    scope: EvalScope,
    record: StepRecord,
  ): Promise<unknown> => {
    const state = { called: false };
    try {
      return await callOnce(step, scope, state);
    } catch (err) {
      if (err instanceof Cancelled || ctx.signal.aborted) throw new Cancelled();
      const message = err instanceof Error ? err.message : String(err);
      if (step.onError === "continue") {
        record.status = "continued";
        record.note = appendNote(record.note, `failed and continued: ${message.slice(0, 300)}`);
        return null;
      }
      if (typeof step.onError === "object") {
        const fb = step.onError.fallback;
        if (fb.when && !truthy(evaluate(fb.when, scope))) throw new StepFailure(step, err);
        if (
          state.called &&
          !step.onError.afterUnknownOutcome &&
          isPaid(step) &&
          isPaid(fb) &&
          !provesNoCharge(err)
        ) {
          throw new StepFailure(
            step,
            new Error(
              `${message.slice(0, 600)} The step may have been charged, so its paid fallback "${fb.id}" was not run: check the provider first. (A recipe allows this fallback with onError.afterUnknownOutcome: true.)`,
            ),
          );
        }
        record.status = "fallback";
        record.note = appendNote(record.note, `failed (${message.slice(0, 200)}); used ${fb.id}`);
        try {
          const out = await callOnce(fb, scope);
          return out;
        } catch (e2) {
          if (e2 instanceof Cancelled || ctx.signal.aborted) throw new Cancelled();
          throw new StepFailure(fb, e2);
        }
      }
      throw new StepFailure(step, err);
    }
  };

  const keep = (step: CompiledStep, value: unknown, record: StepRecord) => {
    const capped = capOutput(value);
    if (capped !== value)
      record.note = appendNote(record.note, "output too large: kept its artifact ids");
    outputs[step.id] = capped;
    if (record.status === "fallback" && typeof step.onError === "object" && !step.forEach) {
      outputs[step.onError.fallback.id] = capped;
    }
    for (const a of collectArtifacts(value).values()) {
      record.artifacts.push(a.id);
      if (!artifacts.has(a.id)) artifacts.set(a.id, { ...a, step: step.id });
    }
  };

  const runStep = async (step: CompiledStep, label: string): Promise<void> => {
    checkAlive();
    const started = Date.now();
    const record: StepRecord = {
      id: step.id,
      title: step.title,
      status: "ok",
      ms: 0,
      artifacts: [],
    };
    const scope = scopeFor();
    try {
      if (step.when && !truthy(evaluate(step.when, scope))) {
        record.status = "skipped";
        records.push(record);
        return;
      }
      if (step.kind === "group") {
        ctx.progress(fraction(step.position, total), label);
        let firstFailure: unknown = null;
        await pool(step.children, step.concurrency, async (child) => {
          try {
            await runStep(child, label);
          } catch (e) {
            if (firstFailure === null) firstFailure = e;
          }
        });
        if (firstFailure !== null) throw firstFailure;
        const value: Record<string, unknown> = {};
        for (const c of step.children)
          if (Object.hasOwn(outputs, c.id)) value[c.id] = outputs[c.id];
        outputs[step.id] = value;
        record.ms = Date.now() - started;
        records.push(record);
        return;
      }
      if (step.forEach) {
        const list = resolveValue(step.forEach, scope, limits);
        if (list !== undefined && list !== null && !Array.isArray(list)) {
          throw new StepFailure(step, new Error("forEach did not resolve to a list"));
        }
        const all = (list ?? []) as unknown[];
        const cap = Math.min(recipe.limits.maxItems, step.maxItems ?? WORKFLOW_LIMITS.maxItems);
        const items = all.slice(0, cap);
        if (all.length > cap) {
          const note = `${step.id}: ran the first ${cap} of ${all.length} items (the limit)`;
          notes.push(note);
          record.note = appendNote(record.note, note);
        }
        record.items = items.length;
        let done = 0;
        const values = await pool(items, step.concurrency, async (item, index) => {
          const out = await attempt(step, scopeFor({ as: step.as, item, index }), record);
          done++;
          ctx.progress(
            fraction(step.position + done / Math.max(1, items.length), total),
            `${label} (${done} of ${items.length})`,
          );
          return out;
        });
        keep(step, values, record);
      } else {
        ctx.progress(fraction(step.position, total), label);
        const value = await attempt(step, scope, record);
        if (value !== null || record.status !== "continued") keep(step, value, record);
      }
      record.ms = Date.now() - started;
      records.push(record);
    } catch (e) {
      record.ms = Date.now() - started;
      if (e instanceof Cancelled) throw e;
      record.status = "failed";
      const failure = e instanceof StepFailure ? e : new StepFailure(step, e);
      record.error = failure.message.slice(0, 1000);
      records.push(record);
      throw failure;
    }
  };

  try {
    for (const [i, step] of recipe.steps.entries()) {
      await runStep(step, `step ${i + 1} of ${total}: ${step.title}`);
    }
    checkAlive();
    const output = capOutput(
      resolveValue(recipe.output, scopeFor(), limits),
      WORKFLOW_LIMITS.maxOutputBytes,
    );
    ctx.progress(1, "done");
    return {
      workflow: recipe.toolName,
      ok: true,
      output,
      artifacts: [...artifacts.values()],
      steps: records,
      notes,
    };
  } catch (e) {
    throw failureError(recipe, e, records, opts.timeout);
  }
}

function appendNote(prev: string | undefined, next: string): string {
  return prev ? `${prev}; ${next}` : next;
}

function fraction(done: number, total: number): number {
  return total === 0 ? 0 : Math.min(0.99, done / total);
}

function failureError(
  recipe: CompiledRecipe,
  e: unknown,
  records: StepRecord[],
  timeout?: AbortSignal,
): WorkflowError {
  const completed = records.filter((r) => r.status !== "failed");
  const failed = records.find((r) => r.status === "failed") ?? null;
  let head: string;
  if (e instanceof Cancelled) {
    head = timeout?.aborted
      ? `${recipe.toolName} stopped: it ran past its ${recipe.limits.timeoutSeconds} s limit.`
      : `${recipe.toolName} was cancelled.`;
  } else if (e instanceof StepFailure) {
    const pos = recipe.steps.findIndex((s) => s.position === e.step.position) + 1;
    head = `${recipe.toolName} failed at step ${pos} of ${recipe.steps.length} "${e.step.id}" (${e.step.title}): ${e.message}`;
  } else {
    head = `${recipe.toolName} failed while building its output: ${e instanceof Error ? e.message : String(e)}`;
  }
  const done = completed
    .filter((r) => r.status !== "skipped")
    .map((r) => `${r.id}${r.artifacts.length ? ` [${r.artifacts.join(", ")}]` : ""}`);
  let detail = JSON.stringify({
    completed: completed.map((r) => ({
      id: r.id,
      status: r.status,
      artifacts: r.artifacts,
      ...(r.note ? { note: r.note } : {}),
    })),
    failed: failed ? { id: failed.id, error: failed.error } : null,
  });
  if (detail.length > WORKFLOW_LIMITS.maxFailureDetailChars) {
    detail = `${detail.slice(0, WORKFLOW_LIMITS.maxFailureDetailChars)}...`;
  }
  const message = [
    head,
    "Nothing was retried.",
    done.length ? `Completed: ${done.join("; ")}.` : "No step completed.",
    `Detail: ${detail}`,
  ].join("\n");
  return new WorkflowError(message, { completed, failed });
}
