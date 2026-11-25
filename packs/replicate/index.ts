// packs/replicate/index.ts
//
// Replicate provider pack: model search and schemas, a generic prediction
// runner, and one typed tool per model listed in the `models` setting. Every
// Replicate endpoint needs the API token, including search.
import { type AnyToolDefinition, type PackContext, definePack, defineTool, z } from "plughive/pack";
import {
  type ModelSpec,
  type ModelSummary,
  PROVIDER,
  checkCollection,
  checkPredictionId,
  parseModelRef,
} from "./client.js";
import {
  exampleInput,
  fieldSummary,
  fieldsOf,
  oneLine,
  parseModelList,
  safeMessage,
  sanitizeSchema,
  toolDescription,
  toolNameFor,
} from "./common.js";
import { ReplicateRuntime, SECRET, runtimeOf } from "./runtime.js";

import { providers } from "./capabilities.js";

export { capabilities } from "./capabilities.js";

export const DEFAULT_MODELS = [
  "black-forest-labs/flux-schnell",
  "google/nano-banana",
  "minimax/video-01",
];
const STARTUP_TIMEOUT_MS = 4000;
const FIXED = [
  "replicate_search_models",
  "replicate_describe_model",
  "replicate_run",
  "replicate_get_result",
  "replicate_train_lora",
  "replicate_get_training",
];
/**
 * The default LoRA trainer, pinned to the version on its public page (Nov 2026;
 * its TrainingInput takes input_images, trigger_word, steps, lora_rank, ...).
 */
export const DEFAULT_TRAINER =
  "ostris/flux-dev-lora-trainer:26dce37af90b9d997eeb970d92e47de3064d46c300504ae376c75bef6a9022d2";
/** Run tools spend money but never delete or overwrite anything. */
const RUN_ANNOTATIONS = { openWorldHint: true, destructiveHint: false } as const;
const MODALITIES = ["image", "video", "audio", "text", "3d", "other"] as const;

const ModelId = z
  .string()
  .min(3)
  .max(266)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*(:[a-f0-9]{64})?$/,
    'models look like "owner/name" or "owner/name:<version>"',
  )
  .describe('Replicate model, "owner/name" (latest version) or "owner/name:<64-char version id>"');

const searchModels = defineTool({
  name: "replicate_search_models",
  description:
    "Search Replicate's public models by text, or list a curated collection (for example text-to-image, " +
    "text-to-video or text-to-speech). Needs REPLICATE_API_TOKEN (searching is free). " +
    "Call replicate_describe_model next for a model's inputs.",
  secrets: [SECRET],
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z
    .object({
      query: z
        .string()
        .min(1)
        .max(200)
        .optional()
        .describe('Free text, for example "flux" or "upscale"'),
      collection: z
        .string()
        .max(80)
        .regex(/^[a-z0-9][a-z0-9-]*$/)
        .optional()
        .describe('Collection slug, for example "text-to-image" or "text-to-video"'),
      modality: z
        .enum(MODALITIES)
        .optional()
        .describe(
          "Output modality filter (a best-effort guess from the model's name, description and tags)",
        ),
      limit: z.number().int().min(1).max(50).default(10),
    })
    .refine((v) => v.query || v.collection, { message: "give a query or a collection" }),
  async run(input, ctx) {
    const rt = runtimeOf(ctx);
    const key = await ctx.secrets.get(SECRET);
    const query = input.query?.trim();
    const cacheKey = query
      ? `search:${query}:${input.modality ? 50 : input.limit}`
      : `collection:${input.collection}`;
    const { value, cached } = await rt.cache.through(cacheKey, async () =>
      query
        ? rt.client(ctx.fetch).search(query, input.modality ? 50 : input.limit, key, ctx.signal)
        : rt.client(ctx.fetch).collection(checkCollection(input.collection!), key, ctx.signal),
    );
    let rows = value as ModelSummary[];
    if (query && input.collection) {
      // Both given: search, then keep the collection's members.
      const members = await rt.cache.through(`collection:${input.collection}`, () =>
        rt.client(ctx.fetch).collection(checkCollection(input.collection!), key, ctx.signal),
      );
      const ids = new Set((members.value as ModelSummary[]).map((m) => m.id));
      rows = rows.filter((r) => ids.has(r.id));
    }
    if (input.modality) rows = rows.filter((r) => r.modality === input.modality);
    return {
      provider: PROVIDER,
      cached,
      models: rows.slice(0, input.limit),
      pricing_note:
        "Replicate bills by output unit for official models and by run time for others; see the model page.",
    };
  },
});

const describeModel = defineTool({
  name: "replicate_describe_model",
  description:
    "Show a Replicate model's input JSON Schema, output shape, version and a ready-to-use replicate_run call. " +
    "Needs REPLICATE_API_TOKEN (free).",
  secrets: [SECRET],
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({ model: ModelId }),
  async run(input, ctx) {
    const rt = runtimeOf(ctx);
    const key = await ctx.secrets.get(SECRET);
    const ref = parseModelRef(input.model);
    const spec = await rt.spec(ctx, input.model, key, { fresh: true });
    if (!spec)
      throw new Error(`Replicate has no model "${ref.id}". Find one with replicate_search_models.`);
    const fields = spec.input ? fieldsOf(spec.input) : [];
    const example = spec.input ? exampleInput(spec.input) : {};
    // Model authors write these schemas: show the cleaned copy (no pattern, capped sizes).
    const cleanIn = spec.input ? sanitizeSchema(spec.input) : null;
    const cleanOut = spec.output ? sanitizeSchema(spec.output) : null;
    return {
      provider: PROVIDER,
      id: spec.id,
      version: ref.version ?? spec.version,
      official: spec.official,
      description: spec.description,
      url: spec.url,
      pricing: spec.url
        ? `See ${spec.url} for pricing (Replicate does not expose it in the API).`
        : "See the model page on replicate.com for pricing.",
      input_fields: fields,
      input_schema: cleanIn ? cleanIn.schema : null,
      ...(cleanIn && cleanIn.notes.length > 0 ? { schema_notes: cleanIn.notes } : {}),
      ...(cleanIn && !cleanIn.ok
        ? { schema_warning: `${cleanIn.reason}; the input is not checked locally.` }
        : {}),
      output_schema: cleanOut ? cleanOut.schema : null,
      output_note:
        "replicate_run downloads every output file into the library and replaces it with an artifact_id. " +
        "Replicate deletes outputs after an hour.",
      example_call: { tool: "replicate_run", arguments: { model: input.model, input: example } },
      default_example_input: spec.default_example_input,
      file_inputs:
        'Pass a library artifact as "artifact:<id>" in any file field (uploaded when over 256 KB).',
      per_model_tool: rt.registered.get(spec.id) ?? null,
    };
  },
});

const getResult = defineTool({
  name: "replicate_get_result",
  description:
    "Collect the output of a Replicate prediction that was already created (for example after a timeout " +
    "or a lost connection): {prediction_id}. Never creates or pays for a new prediction. Returns the run " +
    "result, or {status} while it is still starting or processing. Replicate deletes outputs after an hour.",
  secrets: [SECRET],
  longRunning: true,
  annotations: { ...RUN_ANNOTATIONS, idempotentHint: true },
  input: z.object({
    prediction_id: z
      .string()
      .min(1)
      .max(128)
      .describe("The Replicate prediction id quoted by the earlier call"),
  }),
  async run(input, ctx) {
    return runtimeOf(ctx).collect(ctx, checkPredictionId(input.prediction_id));
  },
});

const runModel = defineTool({
  name: "replicate_run",
  description:
    "Run any Replicate model: {model, input}. The input is checked against the model's schema before a " +
    'prediction is created (see replicate_describe_model). Pass library files as "artifact:<id>". ' +
    "Output files are saved to the library; returns {artifacts, output, model, provider}.",
  secrets: [SECRET],
  longRunning: true,
  annotations: RUN_ANNOTATIONS,
  tags: ["paid"],
  input: z.object({
    model: ModelId,
    input: z
      .record(z.string(), z.unknown())
      .describe("Model input, as in replicate_describe_model"),
  }),
  async run(input, ctx) {
    return runtimeOf(ctx).run(ctx, input.model, input.input);
  },
});

const PlainModel = z
  .string()
  .min(3)
  .max(201)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/,
    'models look like "owner/name"',
  );

const trainLora = defineTool({
  name: "replicate_train_lora",
  description: `Train a LoRA on Replicate from a zip of images into a model you own: {images, destination, trigger_word?, steps?}. The trainer defaults to ${DEFAULT_TRAINER.split(":")[0]} (FLUX.1 dev); pass trainer "owner/name:<version>" for another, and any other trainer inputs in options. The destination model must already exist (create it at https://replicate.com/create). Training is paid and slow, so every call asks for approval first, whatever the spend policy. Returns the new version, which replicate_run takes as its model.`,
  secrets: [SECRET],
  longRunning: true,
  annotations: { ...RUN_ANNOTATIONS, title: "Train a LoRA (Replicate)" },
  tags: ["replicate", "paid", "training", "approval"],
  input: z.object({
    images: z
      .string()
      .min(1)
      .max(2048)
      .regex(
        /^(artifact:[A-Za-z0-9_-]{1,128}|https:\/\/\S+)$/,
        'pass "artifact:<id>" or an https URL of a zip',
      )
      .describe(
        'A zip of the training images (10 or more is best; captions as same-name .txt files are optional): "artifact:<id>" or an https URL',
      ),
    destination: PlainModel.describe(
      'Your Replicate model that receives the new version, "owner/name"',
    ),
    trigger_word: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("A made-up word the LoRA is tied to (the trainer's default is TOK)"),
    steps: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe("Training steps (the default trainer takes 3-6000, 1000 by default)"),
    trainer: ModelId.optional().describe('Another trainer, pinned as "owner/name:<version>"'),
    options: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Other trainer inputs, for example {lora_rank: 32, autocaption: false}"),
  }),
  async run(input, ctx) {
    const body: Record<string, unknown> = { ...(input.options ?? {}), input_images: input.images };
    if (input.trigger_word !== undefined) body.trigger_word = input.trigger_word;
    if (input.steps !== undefined) body.steps = input.steps;
    return runtimeOf(ctx).train(ctx, input.trainer ?? DEFAULT_TRAINER, input.destination, body);
  },
});

const getTraining = defineTool({
  name: "replicate_get_training",
  description:
    "Check a Replicate training that was already started (for example after a timeout): {training_id}. " +
    "Never starts or pays for a new one. Returns the new version when it succeeded, or its status.",
  secrets: [SECRET],
  longRunning: true,
  annotations: { ...RUN_ANNOTATIONS, idempotentHint: true },
  input: z.object({
    training_id: z
      .string()
      .min(1)
      .max(128)
      .describe("The Replicate training id quoted by the earlier call"),
  }),
  async run(input, ctx) {
    return runtimeOf(ctx).collectTraining(ctx, checkPredictionId(input.training_id));
  },
});

function generatedName(id: string, taken: Set<string>): string | null {
  const name = toolNameFor(PROVIDER, id);
  return taken.has(name) ? null : name;
}

export function modelTool(
  rt: ReplicateRuntime,
  model: string,
  spec: ModelSpec,
  name: string,
): AnyToolDefinition {
  const converted = rt.schemaFor(spec);
  const title = oneLine(spec.id, 80);
  // The model description is written by the model's author: labelled, cleaned and capped.
  const description = toolDescription(
    `Runs the Replicate model ${spec.id}.`,
    'Pass library files as "artifact:<id>". Output files are saved to the library.',
    converted.exact ? "" : `Input fields: ${fieldSummary(converted.fields)}.`,
    spec.description ? `Model author's description: ${oneLine(spec.description, 240)}` : "",
  );
  return defineTool({
    name,
    description,
    input: converted.zod as z.ZodType<Record<string, unknown>>,
    secrets: [SECRET],
    longRunning: true,
    annotations: { ...RUN_ANNOTATIONS, title },
    tags: ["replicate", "paid"],
    async run(input, ctx) {
      return runtimeOf(ctx).run(ctx, model, input, { skipValidation: converted.exact });
    },
  });
}

/**
 * Typed tools for the `models` setting, from the disk cache or (with a token)
 * one bounded lookup. Never throws and never waits long.
 */
export async function generatedTools(
  ctx: PackContext,
  rt: ReplicateRuntime,
): Promise<AnyToolDefinition[]> {
  const raw = ctx.settings.models;
  const ids = typeof raw === "string" ? parseModelList(raw) : DEFAULT_MODELS;
  const valid: string[] = [];
  for (const id of ids) {
    try {
      parseModelRef(id);
      valid.push(id);
    } catch {
      ctx.logger.warn("replicate: skipping an invalid model in the models setting", {
        model: oneLine(id, 80),
      });
    }
  }
  const specs = new Map<string, ModelSpec>();
  const missing: string[] = [];
  for (const id of valid) {
    const spec = await rt.cachedSpec(id);
    if (spec) specs.set(id, spec);
    else missing.push(id);
  }
  if (missing.length > 0) {
    const hasKey = await ctx.secrets.has(SECRET).catch(() => false);
    if (!hasKey) {
      ctx.logger.info("replicate: set REPLICATE_API_TOKEN to get the per-model tools", {
        models: missing,
      });
    } else {
      const signal = AbortSignal.timeout(STARTUP_TIMEOUT_MS);
      try {
        const key = await ctx.secrets.get(SECRET);
        await Promise.all(
          missing.map(async (id) => {
            try {
              const spec = await rt.spec(ctx, id, key, { signal });
              if (spec) specs.set(id, spec);
            } catch (e) {
              ctx.logger.warn(
                "replicate: could not fetch a model schema at startup; its tool is skipped",
                {
                  model: id,
                  error: safeMessage(e),
                },
              );
            }
          }),
        );
      } catch (e) {
        ctx.logger.warn("replicate: model tools were skipped", { error: safeMessage(e) });
      }
    }
  }
  const taken = new Set(FIXED);
  const tools: AnyToolDefinition[] = [];
  rt.registered.clear();
  for (const id of valid) {
    const spec = specs.get(id);
    if (!spec || rt.registered.has(spec.id)) continue;
    const name = generatedName(spec.id, taken);
    if (!name) {
      ctx.logger.warn(
        "replicate: a configured model's tool name collides with another tool; it is skipped",
        {
          model: spec.id,
        },
      );
      continue;
    }
    try {
      tools.push(modelTool(rt, id, spec, name));
      taken.add(name);
      rt.registered.set(spec.id, name);
    } catch (e) {
      ctx.logger.warn("replicate: could not build a model tool", {
        model: id,
        error: safeMessage(e),
      });
    }
  }
  return tools;
}

export default definePack({
  setup(ctx) {
    return { replicate: new ReplicateRuntime(ctx) };
  },
  providers,
  async tools(ctx) {
    const fixed: AnyToolDefinition[] = [
      searchModels,
      describeModel,
      runModel,
      getResult,
      trainLora,
      getTraining,
    ];
    try {
      return [...fixed, ...(await generatedTools(ctx, ctx.replicate))];
    } catch (e) {
      ctx.logger.warn("replicate: model tools were skipped", { error: safeMessage(e) });
      return fixed;
    }
  },
});
