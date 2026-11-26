// src/core/workflows/planner.ts
//
// Pre-flight: what a run needs, before anything runs. A dry run returns this
// plan; a real run computes it first and stops with an actionable message
// when a step that will run cannot (missing tool, disabled pack, missing key,
// no configured provider, not in this profile, not permitted).
//
// A step's `when` is decided here when it reads only the input and
// available(): such a step is "yes" or "no". One that reads step outputs is
// "maybe": its needs are reported as warnings, not blockers. A step with
// onError "continue", or a fallback that is ready, never blocks.
import { type CapabilityName, isCapabilityName } from "../capabilities/schemas.js";
import { PAID_TAG } from "../policy/gate.js";
import type { CompiledRecipe, CompiledStep } from "./compile.js";
import { evaluate, truthy } from "./expr.js";
import { WORKFLOW_LIMITS } from "./schema.js";
import { inputOnly, resolveValue } from "./template.js";

export interface PlanTool {
  packId: string;
  capability?: string;
  tags?: readonly string[];
  requiresSecrets: readonly string[];
}

export interface PlanPackState {
  /** "loaded" | "disabled" | "failed" | "needs-review" | "invalid" | ... */
  state: string;
  enabled: boolean;
  error: string | null;
}

export interface PlannerDeps {
  /** The workflow's own pack. */
  packId: string;
  tool(name: string): PlanTool | undefined;
  /** Exposure profile of the current request or job. */
  inScope(name: string): boolean;
  /** The workflow's pack may call it (permissions.tools). */
  permitted(name: string): boolean;
  hasSecret(name: string): boolean | Promise<boolean>;
  pack(id: string): PlanPackState | undefined;
  /** The installed pack that declares a tool (enabled or not), when the step gives no `pack` hint. */
  ownerOf?(tool: string): string | undefined;
  /** Capability providers (configured or not). Absent: routing is off. */
  providers?(
    capability: CapabilityName,
  ): Promise<{ pack: string; configured: boolean; autoRoute: boolean }[]>;
}

export type Need =
  | { type: "missing_tool"; tool: string; pack: string | null; pack_state: string | null }
  | { type: "missing_secret"; tool: string; pack: string; secret: string }
  /** `packs`: the loaded packs that provide the capability but are not set up yet. */
  | { type: "no_provider"; capability: string; packs?: string[] }
  | { type: "not_in_profile"; tool: string }
  | { type: "not_permitted"; tool: string };

export interface PlanStep {
  id: string;
  title: string;
  kind: CompiledStep["kind"];
  uses: string | null;
  /** "yes": runs; "no": skipped by its condition; "maybe": depends on an earlier step's output. */
  runs: "yes" | "no" | "maybe";
  /** Calls this step makes at most (forEach items). */
  calls: number;
  paid: boolean;
  /** Paid steps: the most one call may cost (its `max_cost_usd` arg), or null when unbounded. */
  max_cost_usd_per_call?: number | null;
  for_each: { max_items: number; known_items: number | null } | null;
  on_error: "fail" | "continue" | "fallback";
  needs: (Need & { message: string })[];
  ready: boolean;
  /** Group members and the fallback. */
  steps?: PlanStep[];
  fallback?: PlanStep;
  /**
   * Only on a paid step with a paid fallback. "never": the fallback is skipped
   * (and the run fails) when the step may have been charged. "explicit": the
   * recipe sets onError.afterUnknownOutcome, so the fallback runs even then.
   */
  fallback_after_unknown_outcome?: "never" | "explicit";
}

export interface Plan {
  workflow: string;
  ok: boolean;
  steps: PlanStep[];
  /** Upper bound of calls to paid providers (forEach steps counted at their item cap). */
  paid_calls_max: number;
  /**
   * What the run may cost. `max` adds up each paid step's calls times its
   * `max_cost_usd` argument; it is null (unknown) when a paid step that may
   * run sets none. `min` is 0: a paid step can be served by a free (local)
   * provider, skipped, or fail before it is charged.
   */
  estimated_cost_usd: { min: number; max: number | null; basis: string };
  blocking: { step: string; message: string }[];
  warnings: { step: string; message: string }[];
  notes: string[];
}

export function needMessage(n: Need): string {
  switch (n.type) {
    case "missing_tool": {
      if (!n.pack)
        return `the tool ${n.tool} is not available: install or enable the pack that provides it`;
      if (n.pack_state === null)
        return `the tool ${n.tool} needs the ${n.pack} pack, which is not installed`;
      if (n.pack_state === "disabled")
        return `the tool ${n.tool} needs the ${n.pack} pack, which is disabled: enable it`;
      if (n.pack_state === "needs-review")
        return `the tool ${n.tool} needs the ${n.pack} pack, which waits for your review: review and enable it`;
      if (n.pack_state === "failed")
        return `the tool ${n.tool} needs the ${n.pack} pack, which failed to load: check it in the packs list`;
      return `the tool ${n.tool} is not provided by the ${n.pack} pack (state ${n.pack_state})`;
    }
    case "missing_secret":
      return `the tool ${n.tool} needs the key ${n.secret} of the ${n.pack} pack: set it`;
    case "no_provider":
      return n.packs?.length
        ? `no configured provider for ${n.capability}: set up one of the packs that provide it (${n.packs.join(", ")})`
        : `no configured provider for ${n.capability}: no installed pack provides it; run setup_plan to see what would`;
    case "not_in_profile":
      return `the tool ${n.tool} is not in this profile`;
    case "not_permitted":
      return `the workflow pack does not declare ${n.tool} in permissions.tools`;
  }
}

function noProvider(capability: string, providers: { pack: string }[]): Need {
  const packs = [...new Set(providers.map((p) => p.pack))].sort();
  return packs.length
    ? { type: "no_provider", capability, packs }
    : { type: "no_provider", capability };
}

/**
 * Is a step paid? Capability steps and tools tagged "paid" always count as
 * paid (recipes cannot downgrade them with `paid: false`). Other capability-
 * backed tools default to paid unless the recipe marks them `paid: false`
 * (for local tools such as `local_transcribe`).
 */
export function isPaid(step: CompiledStep, deps: Pick<PlannerDeps, "tool">): boolean {
  if (step.kind === "capability") return true;
  if (step.kind === "tool" && step.target) {
    const t = deps.tool(step.target);
    if (t?.tags?.includes(PAID_TAG)) return true;
    if (step.paid !== undefined) return step.paid;
    return t?.capability !== undefined && isCapabilityName(t.capability);
  }
  return step.paid === true;
}

export class Planner {
  private availability = new Map<string, Promise<Need[]>>();

  constructor(
    private readonly recipe: CompiledRecipe,
    private readonly deps: PlannerDeps,
  ) {}

  /** Needs of calling one tool from this workflow. Cached per run. */
  toolNeeds(name: string, hint?: string): Promise<Need[]> {
    let p = this.availability.get(name);
    if (!p) {
      p = this.computeToolNeeds(name, hint);
      this.availability.set(name, p);
    }
    return p;
  }

  private async computeToolNeeds(name: string, hint?: string): Promise<Need[]> {
    const { deps } = this;
    if (!deps.permitted(name)) return [{ type: "not_permitted", tool: name }];
    const t = deps.tool(name);
    if (!t) {
      const pack = hint ?? deps.ownerOf?.(name) ?? null;
      const state = pack ? deps.pack(pack) : undefined;
      return [{ type: "missing_tool", tool: name, pack, pack_state: state ? state.state : null }];
    }
    if (!deps.inScope(name)) return [{ type: "not_in_profile", tool: name }];
    const needs: Need[] = [];
    for (const s of t.requiresSecrets) {
      if (!(await deps.hasSecret(s)))
        needs.push({ type: "missing_secret", tool: name, pack: t.packId, secret: s });
    }
    if (t.capability && isCapabilityName(t.capability) && deps.providers) {
      const providers = await deps.providers(t.capability);
      // A pack that is itself a provider of the capability (local_transcribe)
      // runs it directly; a routing tool (generate_image) needs a provider.
      if (!providers.some((p) => p.pack === t.packId)) {
        if (!providers.some((p) => p.configured && p.autoRoute)) {
          needs.push(noProvider(t.capability, providers));
        }
      }
    }
    return needs;
  }

  private async capabilityNeeds(cap: string): Promise<Need[]> {
    if (!this.deps.permitted(`cap:${cap}`)) return [{ type: "not_permitted", tool: `cap:${cap}` }];
    if (!isCapabilityName(cap) || !this.deps.providers)
      return [{ type: "no_provider", capability: cap }];
    const providers = await this.deps.providers(cap);
    return providers.some((p) => p.configured && p.autoRoute) ? [] : [noProvider(cap, providers)];
  }

  /** available("tool") as conditions see it. */
  async available(name: string): Promise<boolean> {
    return (await this.toolNeeds(name)).length === 0;
  }

  async availableMap(): Promise<Map<string, boolean>> {
    const out = new Map<string, boolean>();
    for (const s of this.recipe.all) {
      for (const t of s.whenRefs.tools) if (!out.has(t)) out.set(t, await this.available(t));
    }
    return out;
  }

  async plan(input: Record<string, unknown>): Promise<Plan> {
    const avail = await this.availableMap();
    const scope = { roots: { input, steps: {} }, available: (t: string) => avail.get(t) === true };
    const blocking: Plan["blocking"] = [];
    const warnings: Plan["warnings"] = [];
    const notes: string[] = [];
    let paid = 0;
    let costMax: number | null = 0;

    // `outerCalls`: how often the step itself may be called (a fallback runs
    // once per item of its step's forEach).
    const planStep = async (
      s: CompiledStep,
      parentRuns: PlanStep["runs"],
      outerCalls = 1,
    ): Promise<PlanStep> => {
      let runs: PlanStep["runs"] = parentRuns;
      if (s.when && runs !== "no") {
        if (s.whenRefs.steps.size === 0) {
          try {
            runs = truthy(evaluate(s.when, scope)) ? runs : "no";
          } catch {
            runs = "maybe";
          }
        } else runs = "maybe";
      }
      let knownItems: number | null = null;
      let maxItems = 1;
      if (s.forEach) {
        maxItems = Math.min(this.recipe.limits.maxItems, s.maxItems ?? WORKFLOW_LIMITS.maxItems);
        if (inputOnly(s.forEachRefs)) {
          try {
            const v = resolveValue(s.forEach, scope, {
              maxStringChars: WORKFLOW_LIMITS.maxTemplateChars,
            });
            if (Array.isArray(v)) knownItems = Math.min(v.length, maxItems);
          } catch {
            /* reported when it runs */
          }
        }
      }
      const calls = s.kind === "group" ? 0 : (knownItems ?? maxItems) * outerCalls;
      const needs: Need[] =
        s.kind === "tool" && s.target
          ? await this.toolNeeds(s.target, s.pack)
          : s.kind === "capability" && s.target
            ? await this.capabilityNeeds(s.target)
            : [];
      const stepPaid = isPaid(s, this.deps);
      const out: PlanStep = {
        id: s.id,
        title: s.title,
        kind: s.kind,
        uses:
          s.kind === "tool"
            ? (s.target ?? null)
            : s.kind === "capability"
              ? `cap:${s.target}`
              : null,
        runs,
        calls,
        paid: stepPaid,
        ...(stepPaid && s.kind !== "group" ? { max_cost_usd_per_call: callCap(s, scope) } : {}),
        for_each: s.forEach ? { max_items: maxItems, known_items: knownItems } : null,
        on_error: typeof s.onError === "object" ? "fallback" : s.onError,
        needs: needs.map((n) => ({ ...n, message: needMessage(n) })),
        ready: needs.length === 0,
      };
      if (s.kind === "group") {
        out.steps = [];
        for (const c of s.children) out.steps.push(await planStep(c, runs));
        out.ready = out.steps.every((c) => c.ready || c.runs === "no");
      }
      if (typeof s.onError === "object") {
        out.fallback = await planStep(s.onError.fallback, runs === "no" ? "no" : "maybe", calls);
        if (stepPaid && isPaid(s.onError.fallback, this.deps)) {
          out.fallback_after_unknown_outcome = s.onError.afterUnknownOutcome ? "explicit" : "never";
        }
      }
      if (runs !== "no" && stepPaid && s.kind !== "group") {
        paid += calls;
        const cap = out.max_cost_usd_per_call ?? null;
        costMax = costMax === null || cap === null ? null : costMax + cap * calls;
      }
      if (runs !== "no" && s.kind !== "group") {
        const covered = s.onError === "continue" || (out.fallback?.ready ?? false);
        for (const n of out.needs) {
          const entry = { step: s.id, message: n.message };
          if (runs === "yes" && !covered) blocking.push(entry);
          else warnings.push(entry);
        }
      } else if (runs === "no" && out.needs.length) {
        for (const n of out.needs)
          notes.push(`step "${s.id}" is skipped for this input; if it ran: ${n.message}`);
      }
      return out;
    };

    const steps: PlanStep[] = [];
    for (const s of this.recipe.steps) steps.push(await planStep(s, "yes"));
    return {
      workflow: this.recipe.toolName,
      ok: blocking.length === 0,
      steps,
      paid_calls_max: paid,
      estimated_cost_usd: {
        min: 0,
        max: costMax === null ? null : Math.round(costMax * 1e6) / 1e6,
        basis:
          paid === 0
            ? "no paid steps"
            : costMax === null
              ? "unbounded: a paid step that may run sets no max_cost_usd"
              : "sum of max_cost_usd over the most paid calls",
      },
      blocking,
      warnings,
      notes,
    };
  }
}

/** One message for a blocked run. */
/** A step's literal (or input-only) `max_cost_usd` argument, or null. */
function callCap(s: CompiledStep, scope: Parameters<typeof resolveValue>[1]): number | null {
  if (s.args?.t !== "obj") return null;
  const entry = s.args.entries.find(([k]) => k === "max_cost_usd");
  if (!entry) return null;
  try {
    const v = resolveValue(entry[1], scope, { maxStringChars: WORKFLOW_LIMITS.maxTemplateChars });
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  } catch {
    return null;
  }
}

export function blockedMessage(plan: Plan): string {
  const lines = plan.blocking.slice(0, 10).map((b) => `- step "${b.step}": ${b.message}`);
  return `${plan.workflow} cannot run yet; nothing was started:\n${lines.join("\n")}\nRun it with dry_run: true to see the whole plan.`;
}
