// src/core/workflows/schema.ts
//
// The recipe format: a JSON file in a pack's workflows folder.
//
//   { name, title, description, input, steps, output, tags?, limits? }
//
// `input` is a small JSON Schema subset (an object of string / number /
// integer / boolean / array / object properties) turned into zod by hand.
// A step is one of
//
//   { id, tool: "<tool name>", args }          a registered tool
//   { id, capability: "image.generate", args } a routed capability
//   { id, set: <value> }                        a declarative transform
//   { id, save: { kind, mime, content } }       a data artifact in the library
//   { id, parallel: [steps], concurrency? }     a group run side by side
//
// with the shared fields when, forEach, as, concurrency, maxItems, onError
// ("fail" | "continue" | {fallback: <step>, afterUnknownOutcome?: true}), parse ("json"), paid, pack (the
// pack that usually provides the tool, for pre-flight hints) and title.
import { z } from "zod";
import { CAPABILITY_NAMES } from "../capabilities/schemas.js";
import { PACK_ID_PATTERN, TOOL_NAME_PATTERN } from "../packs/manifest.js";

/** Hard ceilings. A recipe can lower the per-run ones in `limits`, never raise them. */
export const WORKFLOW_LIMITS = Object.freeze({
  /** Steps in one recipe, counting group members and fallbacks. */
  maxSteps: 40,
  /** Items one forEach runs; the rest are dropped with a note. */
  maxItems: 20,
  /** Calls running at once inside a forEach or a parallel group. */
  maxConcurrency: 4,
  /** Members of one parallel group. */
  maxParallel: 8,
  /** Wall-clock limit of one run. */
  maxTimeoutSeconds: 3 * 3600,
  defaultTimeoutSeconds: 3600,
  /** Longest string one template produces. */
  maxTemplateChars: 64 * 1024,
  /** Largest resolved argument object of one call (JSON). */
  maxArgsBytes: 256 * 1024,
  /** Largest output kept for one step (JSON); a larger one keeps its artifact ids only. */
  maxStepOutputBytes: 256 * 1024,
  /** Largest output of a whole run (JSON); a larger one keeps its artifact ids only. */
  maxOutputBytes: 1024 * 1024,
  /** Largest recipe file. */
  maxRecipeBytes: 256 * 1024,
  /** A workflow may run another workflow, this deep. */
  maxWorkflowDepth: 2,
  /** Detail of completed steps carried by a failure message. */
  maxFailureDetailChars: 8 * 1024,
});

export const RECIPE_NAME_PATTERN = /^[a-z][a-z0-9_]{0,40}$/;
const STEP_ID_PATTERN = /^[a-z][a-z0-9_]{0,39}$/;
const VAR_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9_.:-]{0,47}$/;
/** Names templates use for themselves: never a forEach variable. */
export const RESERVED_ROOTS: ReadonlySet<string> = new Set(["input", "steps", "index"]);

// --- input schema (JSON Schema subset) ---------------------------------------------

export interface InputProperty {
  type: "string" | "number" | "integer" | "boolean" | "array" | "object";
  title?: string;
  description?: string;
  enum?: (string | number | boolean)[];
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  format?: "uri";
  items?: InputProperty;
  properties?: Record<string, InputProperty>;
  required?: string[];
}

const PROPERTY_NAME = z.string().regex(/^[a-z][a-z0-9_]{0,39}$/, "input names are snake_case");

const InputPropertySchema: z.ZodType<InputProperty> = z.lazy(() =>
  z
    .object({
      type: z.enum(["string", "number", "integer", "boolean", "array", "object"]),
      title: z.string().max(200).optional(),
      description: z.string().max(2000).optional(),
      enum: z
        .array(z.union([z.string().max(200), z.number(), z.boolean()]))
        .min(1)
        .max(100)
        .optional(),
      default: z.unknown().optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      minLength: z.number().int().min(0).optional(),
      maxLength: z.number().int().min(0).max(200_000).optional(),
      minItems: z.number().int().min(0).optional(),
      maxItems: z.number().int().min(0).max(1000).optional(),
      format: z.literal("uri").optional(),
      items: InputPropertySchema.optional(),
      properties: z.record(PROPERTY_NAME, InputPropertySchema).optional(),
      required: z.array(PROPERTY_NAME).optional(),
    })
    .strict(),
);

export const InputSchemaSchema = z
  .object({
    type: z.literal("object"),
    properties: z.record(PROPERTY_NAME, InputPropertySchema).default({}),
    required: z.array(PROPERTY_NAME).default([]),
    additionalProperties: z.literal(false).optional(),
  })
  .strict();
export type RecipeInputSchema = z.infer<typeof InputSchemaSchema>;

// --- steps ----------------------------------------------------------------------

/**
 * `afterUnknownOutcome: true` lets a paid fallback run even when the failed
 * paid step may have been charged (its outcome is unknown). Without it such a
 * failure stops the run: paying twice is never implicit.
 */
export type OnError = "fail" | "continue" | { fallback: StepSpec; afterUnknownOutcome?: boolean };

export interface StepSpec {
  id: string;
  title?: string;
  when?: string;
  tool?: string;
  capability?: (typeof CAPABILITY_NAMES)[number];
  set?: unknown;
  save?: { kind: "data" | "document"; mime: string; content: unknown; name?: string };
  parallel?: StepSpec[];
  args?: Record<string, unknown>;
  forEach?: string;
  as?: string;
  concurrency?: number;
  maxItems?: number;
  onError?: OnError;
  parse?: "json";
  paid?: boolean;
  pack?: string;
}

const SaveSchema = z
  .object({
    kind: z.enum(["data", "document"]),
    mime: z.enum(["application/json", "text/markdown", "text/plain"]),
    content: z.unknown(),
    name: z.string().max(200).optional(),
  })
  .strict();

const StepSchema: z.ZodType<StepSpec> = z.lazy(() =>
  z
    .object({
      id: z.string().regex(STEP_ID_PATTERN, "step ids are snake_case, at most 40 characters"),
      title: z.string().min(1).max(120).optional(),
      when: z.string().min(1).max(2000).optional(),
      tool: z.string().regex(TOOL_NAME_PATTERN, "not a valid tool name").optional(),
      capability: z.enum(CAPABILITY_NAMES).optional(),
      set: z.unknown().optional(),
      save: SaveSchema.optional(),
      parallel: z.array(StepSchema).min(1).max(WORKFLOW_LIMITS.maxParallel).optional(),
      args: z.record(z.string(), z.unknown()).optional(),
      forEach: z.string().min(1).max(2000).optional(),
      as: z.string().regex(VAR_PATTERN).optional(),
      concurrency: z.number().int().min(1).max(WORKFLOW_LIMITS.maxConcurrency).optional(),
      maxItems: z.number().int().min(1).max(WORKFLOW_LIMITS.maxItems).optional(),
      onError: z
        .union([
          z.enum(["fail", "continue"]),
          z.object({ fallback: StepSchema, afterUnknownOutcome: z.boolean().optional() }).strict(),
        ])
        .optional(),
      parse: z.literal("json").optional(),
      paid: z.boolean().optional(),
      pack: z.string().regex(PACK_ID_PATTERN).optional(),
    })
    .strict()
    .superRefine((s, ctx) => {
      const kinds = (["tool", "capability", "set", "save", "parallel"] as const).filter((k) =>
        Object.hasOwn(s, k),
      );
      if (kinds.length !== 1) {
        ctx.addIssue({
          code: "custom",
          message: `step "${s.id}" needs exactly one of tool, capability, set, save or parallel`,
        });
        return;
      }
      const kind = kinds[0];
      if (kind === "parallel") {
        for (const k of [
          "forEach",
          "as",
          "maxItems",
          "onError",
          "parse",
          "paid",
          "args",
        ] as const) {
          if (Object.hasOwn(s, k)) {
            ctx.addIssue({ code: "custom", message: `group step "${s.id}" cannot use ${k}` });
          }
        }
      }
      if ((kind === "set" || kind === "save") && Object.hasOwn(s, "args")) {
        ctx.addIssue({ code: "custom", message: `step "${s.id}": ${kind} steps take no args` });
      }
      if (s.parse && kind !== "tool" && kind !== "capability") {
        ctx.addIssue({
          code: "custom",
          message: `step "${s.id}": parse is for tool and capability steps`,
        });
      }
      if ((s.as || s.concurrency || s.maxItems) && !s.forEach && kind !== "parallel") {
        ctx.addIssue({
          code: "custom",
          message: `step "${s.id}": as, concurrency and maxItems need forEach`,
        });
      }
      if (s.as && RESERVED_ROOTS.has(s.as)) {
        ctx.addIssue({ code: "custom", message: `step "${s.id}": "${s.as}" is a reserved name` });
      }
      const fb = typeof s.onError === "object" ? s.onError.fallback : undefined;
      if (fb && (fb.parallel || typeof fb.onError === "object")) {
        ctx.addIssue({
          code: "custom",
          message: `step "${s.id}": a fallback is a single step without its own fallback`,
        });
      }
    }),
);

export const RecipeSchema = z
  .object({
    $schema: z.string().max(500).optional(),
    name: z.string().regex(RECIPE_NAME_PATTERN, "the name is snake_case, at most 41 characters"),
    title: z.string().min(1).max(120),
    description: z.string().min(1).max(4000),
    input: InputSchemaSchema,
    steps: z.array(StepSchema).min(1).max(WORKFLOW_LIMITS.maxSteps),
    output: z.unknown(),
    tags: z.array(z.string().regex(TAG_PATTERN)).max(12).optional(),
    limits: z
      .object({
        maxItems: z.number().int().min(1).max(WORKFLOW_LIMITS.maxItems).optional(),
        maxConcurrency: z.number().int().min(1).max(WORKFLOW_LIMITS.maxConcurrency).optional(),
        timeoutSeconds: z.number().int().min(10).max(WORKFLOW_LIMITS.maxTimeoutSeconds).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type Recipe = z.infer<typeof RecipeSchema>;

/** A zod issue list as one readable line. */
export function formatIssues(error: z.ZodError): string {
  return error.issues
    .slice(0, 8)
    .map((i) => {
      // A bad record key (an input property name) carries its reason one level down.
      const nested = i.code === "invalid_key" ? i.issues.map((n) => n.message).join(", ") : "";
      return `${i.path.length ? `${i.path.join(".")}: ` : ""}${nested || i.message}`;
    })
    .join("; ");
}

// --- input schema -> zod ------------------------------------------------------------

function propertyZod(p: InputProperty, where: string, depth = 0): z.ZodType {
  if (depth > 6) throw new Error(`${where}: input schema nested too deeply`);
  let t: z.ZodType;
  switch (p.type) {
    case "string": {
      if (p.enum) {
        const values = p.enum.filter((v): v is string => typeof v === "string");
        if (values.length !== p.enum.length)
          throw new Error(`${where}: string enum with non-strings`);
        t = z.enum(values as [string, ...string[]]);
        break;
      }
      let s = z.string();
      if (p.minLength !== undefined) s = s.min(p.minLength);
      s = s.max(p.maxLength ?? 20_000);
      if (p.format === "uri") s = s.regex(/^https?:\/\/\S+$/, "must be an http(s) URL");
      t = s;
      break;
    }
    case "number":
    case "integer": {
      let n = p.type === "integer" ? z.number().int() : z.number();
      if (p.minimum !== undefined) n = n.min(p.minimum);
      if (p.maximum !== undefined) n = n.max(p.maximum);
      t = n;
      break;
    }
    case "boolean":
      t = z.boolean();
      break;
    case "array": {
      if (!p.items) throw new Error(`${where}: an array needs items`);
      let a = z.array(propertyZod(p.items, `${where}[]`, depth + 1));
      if (p.minItems !== undefined) a = a.min(p.minItems);
      a = a.max(p.maxItems ?? 100);
      t = a;
      break;
    }
    case "object":
      t = objectZod(p.properties ?? {}, p.required ?? [], where, depth + 1);
      break;
  }
  if (p.enum && p.type !== "string") {
    const allowed = p.enum;
    t = t.refine((v) => allowed.includes(v as never), {
      message: `must be one of ${allowed.join(", ")}`,
    });
  }
  if (p.description) t = t.describe(p.description);
  return t;
}

function objectZod(
  properties: Record<string, InputProperty>,
  required: readonly string[],
  where: string,
  depth: number,
): z.ZodObject {
  for (const r of required) {
    if (!Object.hasOwn(properties, r))
      throw new Error(`${where}: required "${r}" is not a property`);
  }
  const shape: Record<string, z.ZodType> = {};
  for (const [name, p] of Object.entries(properties)) {
    let t = propertyZod(p, `${where}.${name}`, depth);
    if (p.default !== undefined) {
      const ok = t.safeParse(p.default);
      if (!ok.success) throw new Error(`${where}.${name}: the default does not match the schema`);
      t = t.default(p.default as never);
    } else if (!required.includes(name)) t = t.optional();
    shape[name] = t;
  }
  return z.object(shape);
}

/** The tool input of a workflow: the recipe's input plus the reserved `dry_run`. */
export function recipeInputZod(input: RecipeInputSchema): z.ZodObject {
  if (Object.hasOwn(input.properties, "dry_run")) {
    throw new Error('input.properties: "dry_run" is reserved');
  }
  const withDryRun = objectZod(input.properties, input.required, "input", 0).extend({
    dry_run: z
      .boolean()
      .optional()
      .describe(
        "Plan only: list the steps, what each needs (tools, packs, keys), the most paid calls the run may make and its estimated cost range. Nothing runs.",
      ),
  });
  // additionalProperties: false means unknown keys are refused, not stripped.
  return input.additionalProperties === false ? withDryRun.strict() : withDryRun;
}
