// src/core/workflows/compile.ts
//
// A validated recipe turned into what the runner and the pre-flight walk:
// every template and condition parsed, every reference checked. A step may
// only read steps that come before it (group members do not see each other,
// a fallback sees what its step sees), and only a forEach step (and its
// fallback) has the item variable and `index`.
import type { z } from "zod";
import {
  type Expr,
  FORBIDDEN_SEGMENTS,
  type References,
  emptyReferences,
  parseCondition,
  references,
} from "./expr.js";
import {
  type OnError,
  RESERVED_ROOTS,
  type Recipe,
  type StepSpec,
  WORKFLOW_LIMITS,
  recipeInputZod,
} from "./schema.js";
import { type CompiledValue, TemplateError, compileValue, valueReferences } from "./template.js";

export type StepKind = "tool" | "capability" | "set" | "save" | "group";

export interface CompiledStep {
  id: string;
  title: string;
  kind: StepKind;
  /** Tool name, or the capability for a capability step. */
  target?: string;
  when?: Expr;
  whenRefs: References;
  forEach?: CompiledValue;
  forEachRefs: References;
  /** Item variable name (default "item"). */
  as: string;
  maxItems?: number;
  concurrency: number;
  args?: CompiledValue;
  argsRefs: References;
  value?: CompiledValue;
  save?: { kind: "data" | "document"; mime: string; name?: string; content: CompiledValue };
  children: CompiledStep[];
  onError: "fail" | "continue" | { fallback: CompiledStep; afterUnknownOutcome: boolean };
  parse?: "json";
  paid?: boolean;
  /** The pack that usually provides `target` (pre-flight hint). */
  pack?: string;
  /** Top-level position (0-based) of the step or of the group that holds it. */
  position: number;
  isFallback: boolean;
}

export interface CompiledRecipe {
  recipe: Recipe;
  name: string;
  toolName: string;
  title: string;
  steps: CompiledStep[];
  /** Every step, group members and fallbacks included, in order. */
  all: CompiledStep[];
  output: CompiledValue;
  inputZod: z.ZodObject;
  limits: { maxItems: number; maxConcurrency: number; timeoutSeconds: number };
}

export class RecipeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecipeError";
  }
}

const BASE_ROOTS = new Set(["input", "steps"]);

function kindOf(s: StepSpec): StepKind {
  if (s.parallel) return "group";
  if (s.tool !== undefined) return "tool";
  if (s.capability !== undefined) return "capability";
  if (Object.hasOwn(s, "save")) return "save";
  return "set";
}

export function compileRecipe(recipe: Recipe): CompiledRecipe {
  const seen = new Set<string>();
  const all: CompiledStep[] = [];
  const limits = {
    maxItems: recipe.limits?.maxItems ?? WORKFLOW_LIMITS.maxItems,
    maxConcurrency: recipe.limits?.maxConcurrency ?? WORKFLOW_LIMITS.maxConcurrency,
    timeoutSeconds: recipe.limits?.timeoutSeconds ?? WORKFLOW_LIMITS.defaultTimeoutSeconds,
  };

  const checkRefs = (where: string, refs: References, visible: ReadonlySet<string>) => {
    for (const id of refs.steps) {
      if (!visible.has(id)) {
        throw new RecipeError(
          seen.has(id)
            ? `${where}: steps.${id} is not available here (a step reads only the steps before it, and group members cannot read each other)`
            : `${where}: there is no step "${id}"`,
        );
      }
    }
    if (refs.roots.has("steps") && [...refs.steps].length === 0) {
      throw new RecipeError(`${where}: name a step, as in steps.<id>`);
    }
  };

  const compileStep = (
    s: StepSpec,
    visible: ReadonlySet<string>,
    position: number,
    isFallback: boolean,
    parentLoop?: { as: string },
  ): CompiledStep => {
    if (seen.has(s.id)) throw new RecipeError(`step id "${s.id}" is used twice`);
    if (s.id === "input" || s.id === "steps" || FORBIDDEN_SEGMENTS.has(s.id)) {
      throw new RecipeError(`"${s.id}" is a reserved step id`);
    }
    seen.add(s.id);
    if (seen.size > WORKFLOW_LIMITS.maxSteps) {
      throw new RecipeError(`more than ${WORKFLOW_LIMITS.maxSteps} steps`);
    }
    const kind = kindOf(s);
    const where = `step "${s.id}"`;
    if (isFallback && s.forEach) throw new RecipeError(`${where}: a fallback cannot have forEach`);

    let when: Expr | undefined;
    const whenRefs = emptyReferences();
    if (s.when !== undefined) {
      try {
        when = parseCondition(s.when, BASE_ROOTS);
      } catch (e) {
        throw new RecipeError(`${where} when: ${(e as Error).message}`);
      }
      references(when, whenRefs);
      checkRefs(`${where} when`, whenRefs, visible);
    }

    let forEach: CompiledValue | undefined;
    const forEachRefs = emptyReferences();
    if (s.forEach !== undefined) {
      if (!s.forEach.includes("${")) {
        throw new RecipeError(
          `${where}: forEach is a template, such as "\${steps.plan.json.shots}"`,
        );
      }
      forEach = compile(s.forEach, BASE_ROOTS, `${where} forEach`);
      valueReferences(forEach, forEachRefs);
      checkRefs(`${where} forEach`, forEachRefs, visible);
    }
    const loop = s.forEach ? { as: s.as ?? "item" } : parentLoop;
    const roots = loop ? new Set([...BASE_ROOTS, loop.as, "index"]) : BASE_ROOTS;
    if (
      loop &&
      ((RESERVED_ROOTS.has(loop.as) && loop.as !== "index") || FORBIDDEN_SEGMENTS.has(loop.as))
    ) {
      throw new RecipeError(`${where}: "${loop.as}" is a reserved name`);
    }

    const step: CompiledStep = {
      id: s.id,
      title: s.title ?? s.id.replace(/_/g, " "),
      kind,
      ...(when ? { when } : {}),
      whenRefs,
      ...(forEach ? { forEach } : {}),
      forEachRefs,
      as: loop?.as ?? "item",
      ...(s.maxItems !== undefined ? { maxItems: s.maxItems } : {}),
      concurrency: Math.min(s.concurrency ?? 1, limits.maxConcurrency),
      argsRefs: emptyReferences(),
      children: [],
      onError: "fail",
      ...(s.parse ? { parse: s.parse } : {}),
      ...(s.paid !== undefined ? { paid: s.paid } : {}),
      ...(s.pack ? { pack: s.pack } : {}),
      position,
      isFallback,
    };
    all.push(step);

    switch (kind) {
      case "tool":
      case "capability":
        step.target = (s.tool ?? s.capability) as string;
        step.args = compile(s.args ?? {}, roots, `${where} args`);
        valueReferences(step.args, step.argsRefs);
        break;
      case "set":
        step.value = compile(s.set, roots, `${where} set`);
        valueReferences(step.value, step.argsRefs);
        break;
      case "save": {
        const save = s.save as NonNullable<StepSpec["save"]>;
        const content = compile(save.content, roots, `${where} save.content`);
        valueReferences(content, step.argsRefs);
        step.save = {
          kind: save.kind,
          mime: save.mime,
          ...(save.name ? { name: save.name } : {}),
          content,
        };
        break;
      }
      case "group": {
        step.concurrency = Math.min(s.concurrency ?? limits.maxConcurrency, limits.maxConcurrency);
        for (const child of s.parallel ?? []) {
          step.children.push(compileStep(child, visible, position, false));
        }
        break;
      }
    }
    checkRefs(`${where}`, step.argsRefs, visible);

    const onError = s.onError as OnError | undefined;
    if (onError === "continue") step.onError = "continue";
    else if (typeof onError === "object") {
      step.onError = {
        fallback: compileStep(onError.fallback, visible, position, true, loop),
        afterUnknownOutcome: onError.afterUnknownOutcome === true,
      };
    }
    return step;
  };

  const compile = (v: unknown, roots: ReadonlySet<string>, where: string): CompiledValue => {
    try {
      return compileValue(v, roots, where);
    } catch (e) {
      if (e instanceof TemplateError) throw new RecipeError(e.message);
      throw e;
    }
  };

  const visible = new Set<string>();
  const steps: CompiledStep[] = [];
  recipe.steps.forEach((s, position) => {
    const before = all.length;
    steps.push(compileStep(s, new Set(visible), position, false));
    for (const added of all.slice(before)) visible.add(added.id);
  });

  const output = compile(recipe.output ?? null, BASE_ROOTS, "output");
  checkRefs("output", valueReferences(output, emptyReferences()), visible);

  let inputZod: z.ZodObject;
  try {
    inputZod = recipeInputZod(recipe.input);
  } catch (e) {
    throw new RecipeError((e as Error).message);
  }

  return {
    recipe,
    name: recipe.name,
    toolName: `wf_${recipe.name}`,
    title: recipe.title,
    steps,
    all,
    output,
    inputZod,
    limits,
  };
}

/** Every tool a recipe calls (tool steps, fallbacks and available() checks). */
export function recipeTools(c: CompiledRecipe): { calls: Set<string>; probes: Set<string> } {
  const calls = new Set<string>();
  const probes = new Set<string>();
  for (const s of c.all) {
    if (s.kind === "tool" && s.target) calls.add(s.target);
    for (const t of s.whenRefs.tools) probes.add(t);
  }
  return { calls, probes };
}
