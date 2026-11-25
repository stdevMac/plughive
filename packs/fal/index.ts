// packs/fal/index.ts
//
// fal.ai provider pack: catalog search and model schemas (keyless), a generic
// queue runner, and one typed tool per model listed in the `models` setting.
import { type AnyToolDefinition, type PackContext, definePack, defineTool, z } from "plughive/pack";
import {
  CATEGORIES,
  type ModelSpec,
  PROVIDER,
  type Price,
  checkFalId,
  checkRequestId,
  summarize,
} from "./client.js";
import {
  type Json,
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
import { FalRuntime, SECRET, runtimeOf } from "./runtime.js";

import { providers } from "./capabilities.js";

export { capabilities } from "./capabilities.js";

export const DEFAULT_MODELS = [
  "fal-ai/flux/dev",
  "fal-ai/nano-banana-pro",
  "fal-ai/kling-video/v3/pro/image-to-video",
  "fal-ai/minimax/speech-2.8-hd",
];
const STARTUP_TIMEOUT_MS = 4000;
const FIXED = [
  "fal_search_models",
  "fal_describe_model",
  "fal_run",
  "fal_get_result",
  "fal_train_lora",
];
/** fal's FLUX LoRA trainer (schema checked against the live catalog, Nov 2026). */
export const LORA_TRAINER = "fal-ai/flux-lora-fast-training";
/** Run tools spend money but never delete or overwrite anything. */
const RUN_ANNOTATIONS = { openWorldHint: true, destructiveHint: false } as const;

const ModelId = z
  .string()
  .min(3)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "model ids look like fal-ai/flux/dev")
  .describe('fal endpoint id, for example "fal-ai/flux/dev"');

const MODALITIES = ["image", "video", "audio", "text", "3d"] as const;

async function pricesFor(
  ctx: PackContext,
  rt: FalRuntime,
  ids: string[],
): Promise<Map<string, Price>> {
  if (ids.length === 0 || !(await ctx.secrets.has(SECRET).catch(() => false))) return new Map();
  try {
    const key = await ctx.secrets.get(SECRET);
    const sorted = [...ids].sort();
    const { value } = await rt.cache.through(`price:${sorted.join(",")}`, async () =>
      Object.fromEntries(await rt.client(ctx.fetch).pricing(sorted, key, ctx.signal)),
    );
    return new Map(Object.entries(value as Record<string, Price>));
  } catch {
    return new Map();
  }
}

function priceText(p: Price | undefined): string | null {
  return p ? `${p.unit_price} ${p.currency} per ${p.unit}` : null;
}

const searchModels = defineTool({
  name: "fal_search_models",
  description:
    "Search the fal.ai model catalog (1000+ image, video, audio, speech and 3D models). Keyless. " +
    "Filter by category (text-to-image, image-to-video, ...) or output modality. Returns compact rows; " +
    "call fal_describe_model for a model's input fields, then fal_run to run it.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z.string().max(200).optional().describe('Free text, for example "flux" or "lip sync"'),
    category: z.enum(CATEGORIES).optional(),
    modality: z.enum(MODALITIES).optional().describe("Output modality filter"),
    limit: z.number().int().min(1).max(50).default(10),
    cursor: z
      .string()
      .max(200)
      .regex(/^[A-Za-z0-9+/=_-]*$/)
      .optional()
      .describe("next_cursor from a previous call"),
  }),
  async run(input, ctx) {
    const rt = runtimeOf(ctx);
    const fetchLimit = input.modality && !input.category ? 50 : input.limit;
    const params = {
      query: input.query?.trim() || undefined,
      category: input.category,
      limit: fetchLimit,
      cursor: input.cursor,
    };
    const { value, cached } = await rt.cache.through(`search:${JSON.stringify(params)}`, () =>
      rt.client(ctx.fetch).search(params, ctx.signal),
    );
    let rows = (value.models as Json[]).map(summarize).filter((m) => m !== null);
    if (input.modality) rows = rows.filter((m) => m.modality === input.modality);
    rows = rows.slice(0, input.limit);
    const prices = await pricesFor(
      ctx,
      rt,
      rows.map((r) => r.id),
    );
    // The catalog has no modality filter: it is applied here to one page of
    // up to 50 matches, so more models may exist beyond next_cursor.
    const modalityNote =
      input.modality && !input.category
        ? {
            modality_note: `Filtered by modality from the first ${fetchLimit} catalog matches${
              value.next ? "; more may follow at next_cursor" : ""
            }. Pass a category for a complete list.`,
          }
        : {};
    return {
      provider: PROVIDER,
      cached,
      models: rows.map((r) => ({ ...r, pricing: priceText(prices.get(r.id)) })),
      next_cursor: value.next ?? null,
      ...modalityNote,
      ...(prices.size === 0 ? { pricing_note: "Set FAL_KEY to include prices." } : {}),
    };
  },
});

const describeModel = defineTool({
  name: "fal_describe_model",
  description:
    "Show a fal model's input JSON Schema, output fields, price and a ready-to-use fal_run call. Keyless.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({ model: ModelId }),
  async run(input, ctx) {
    const rt = runtimeOf(ctx);
    const id = checkFalId(input.model);
    const spec = await rt.spec(ctx, id);
    if (!spec) throw new Error(`fal has no model "${id}". Find one with fal_search_models.`);
    const prices = await pricesFor(ctx, rt, [id]);
    const fields = spec.input ? fieldsOf(spec.input) : [];
    const outFields = spec.output ? fieldsOf(spec.output) : [];
    const example = spec.input ? exampleInput(spec.input) : {};
    const clean = spec.input ? sanitizeSchema(spec.input) : null;
    return {
      provider: PROVIDER,
      id: spec.id,
      name: oneLine(spec.name, 120),
      category: spec.category,
      modality: spec.modality,
      description: spec.description,
      status: spec.status,
      pricing: priceText(prices.get(id)) ?? "unknown (set FAL_KEY to see the price)",
      input_fields: fields,
      input_schema: clean ? clean.schema : null,
      ...(clean && clean.notes.length > 0 ? { schema_notes: clean.notes } : {}),
      ...(clean && !clean.ok
        ? { schema_warning: `${clean.reason}; the input is not checked locally.` }
        : {}),
      output_fields: outFields.map((f) => `${f.name}: ${f.type}`),
      output_note:
        "fal_run downloads every output file into the library and replaces it with an artifact_id.",
      example_call: { tool: "fal_run", arguments: { model: id, input: example } },
      file_inputs: 'Pass a library artifact as "artifact:<id>" in any URL field.',
      per_model_tool: rt.registered.get(id) ?? null,
    };
  },
});

const getResult = defineTool({
  name: "fal_get_result",
  description:
    "Collect the output of a fal job that was already submitted (for example after a timeout or a lost " +
    "connection): {model, request_id}. Never submits or pays for a new job. Returns the run result, or " +
    "{status} while the job is still queued or running.",
  secrets: [SECRET],
  longRunning: true,
  annotations: { ...RUN_ANNOTATIONS, idempotentHint: true },
  input: z.object({
    model: ModelId,
    request_id: z
      .string()
      .min(1)
      .max(128)
      .describe("The fal request id quoted by the earlier call"),
  }),
  async run(input, ctx) {
    return runtimeOf(ctx).collect(ctx, checkFalId(input.model), checkRequestId(input.request_id));
  },
});

const runModel = defineTool({
  name: "fal_run",
  description:
    "Run any fal model through the queue: {model, input}. The input is checked against the model's " +
    'schema first (see fal_describe_model). Pass library files as "artifact:<id>" in URL fields. ' +
    "Output files are saved to the library; returns {artifacts, output, model, provider}.",
  secrets: [SECRET],
  longRunning: true,
  annotations: RUN_ANNOTATIONS,
  tags: ["paid"],
  input: z.object({
    model: ModelId,
    input: z.record(z.string(), z.unknown()).describe("Model input, as in fal_describe_model"),
  }),
  async run(input, ctx) {
    return runtimeOf(ctx).run(ctx, input.model, input.input);
  },
});

/** A zip given as a library artifact or an https link. */
const TrainingImages = z
  .string()
  .min(1)
  .max(2048)
  .regex(
    /^(artifact:[A-Za-z0-9_-]{1,128}|https:\/\/\S+)$/,
    'pass "artifact:<id>" or an https URL of a zip',
  )
  .describe(
    'A zip of the training images (at least 4; captions as same-name .txt files are optional): "artifact:<id>" or an https URL',
  );

/** The https link of a fal File object in the raw output, or null. */
function fileUrl(v: Json): string | null {
  const u = v?.url;
  return typeof u === "string" && /^https:\/\/\S+$/.test(u) && u.length <= 2048 ? u : null;
}

const trainLora = defineTool({
  name: "fal_train_lora",
  description: `Train a FLUX LoRA on fal (${LORA_TRAINER}) from a zip of images: {images, trigger_word?, steps?, is_style?}. Training is paid and takes minutes, so every call asks for approval first, whatever the spend policy. Returns the weights (saved to the library when they fit) and lora_url, which fal-ai/flux-lora takes as loras: [{path: lora_url}]. Use the trigger word in prompts to activate the LoRA.`,
  secrets: [SECRET],
  longRunning: true,
  annotations: { ...RUN_ANNOTATIONS, title: "Train a FLUX LoRA (fal)" },
  tags: ["fal", "paid", "training", "approval"],
  input: z.object({
    images: TrainingImages,
    trigger_word: z
      .string()
      .min(1)
      .max(64)
      .optional()
      .describe("A made-up word the LoRA is tied to, for example TOK"),
    steps: z
      .number()
      .int()
      .min(1)
      .max(10000)
      .optional()
      .describe("Training steps (fal suggests about 1000)"),
    is_style: z
      .boolean()
      .optional()
      .describe("Train a style rather than a subject (turns off masks and captions)"),
    create_masks: z
      .boolean()
      .optional()
      .describe("Weight the loss with segmentation masks (faces for people); fal's default is on"),
  }),
  async run(input, ctx) {
    const body: Record<string, Json> = { images_data_url: input.images };
    if (input.trigger_word !== undefined) body.trigger_word = input.trigger_word;
    if (input.steps !== undefined) body.steps = input.steps;
    if (input.is_style !== undefined) body.is_style = input.is_style;
    if (input.create_masks !== undefined) body.create_masks = input.create_masks;
    return runtimeOf(ctx).run(ctx, LORA_TRAINER, body, {
      prompt: input.trigger_word ?? null,
      extra: (value) => ({
        lora_url: fileUrl(value?.diffusers_lora_file),
        config_url: fileUrl(value?.config_file),
        trigger_word: input.trigger_word ?? null,
      }),
    });
  },
});

function stripOwner(id: string): string {
  return id.startsWith("fal-ai/") ? id.slice("fal-ai/".length) : id;
}

function generatedName(id: string, taken: Set<string>): string | null {
  for (const slug of [stripOwner(id), id]) {
    const name = toolNameFor(PROVIDER, slug);
    if (!taken.has(name)) return name;
  }
  return null;
}

export function modelTool(rt: FalRuntime, spec: ModelSpec, name: string): AnyToolDefinition {
  const converted = rt.schemaFor(spec);
  const fieldList = fieldSummary(converted.fields);
  const title = oneLine(spec.name, 80) || spec.id;
  // Catalog text is remote and untrusted: it is labelled, cleaned and capped.
  const description = toolDescription(
    `Runs the fal model ${spec.id} (${oneLine(spec.category, 40) || "uncategorised"}).`,
    'Pass library files as "artifact:<id>" in URL fields. Output files are saved to the library.',
    converted.exact ? "" : `Input fields: ${fieldList}.`,
    `Provider title: ${title}.`,
    spec.description ? `Provider description: ${oneLine(spec.description, 240)}` : "",
  );
  return defineTool({
    name,
    description,
    input: converted.zod as z.ZodType<Record<string, unknown>>,
    secrets: [SECRET],
    longRunning: true,
    annotations: { ...RUN_ANNOTATIONS, title },
    tags: ["fal", "paid", spec.category].filter(Boolean),
    async run(input, ctx) {
      return runtimeOf(ctx).run(ctx, spec.id, input, { skipValidation: converted.exact });
    },
  });
}

/** Typed tools for the `models` setting. Never throws and never waits long. */
export async function generatedTools(
  ctx: PackContext,
  rt: FalRuntime,
): Promise<AnyToolDefinition[]> {
  const raw = ctx.settings.models;
  const ids = typeof raw === "string" ? parseModelList(raw) : DEFAULT_MODELS;
  const valid: string[] = [];
  for (const id of ids) {
    try {
      valid.push(checkFalId(id));
    } catch {
      ctx.logger.warn("fal: skipping an invalid model id in the models setting", {
        model: oneLine(id, 80),
      });
    }
  }
  const specs = await rt.specsForStartup(ctx, valid, STARTUP_TIMEOUT_MS);
  const taken = new Set(FIXED);
  const tools: AnyToolDefinition[] = [];
  rt.registered.clear();
  for (const id of valid) {
    if (rt.registered.has(id)) continue;
    const spec = specs.get(id);
    if (!spec) {
      ctx.logger.warn("fal: no schema for a configured model; its tool is skipped", { model: id });
      continue;
    }
    const name = generatedName(id, taken);
    if (!name) {
      ctx.logger.warn(
        "fal: a configured model's tool name collides with another tool; it is skipped",
        {
          model: id,
        },
      );
      continue;
    }
    try {
      tools.push(modelTool(rt, spec, name));
      taken.add(name);
      rt.registered.set(id, name);
    } catch (e) {
      ctx.logger.warn("fal: could not build a model tool", { model: id, error: safeMessage(e) });
    }
  }
  return tools;
}

export default definePack({
  setup(ctx) {
    return { fal: new FalRuntime(ctx) };
  },
  providers,
  async tools(ctx) {
    const fixed: AnyToolDefinition[] = [
      searchModels,
      describeModel,
      runModel,
      getResult,
      trainLora,
    ];
    try {
      return [...fixed, ...(await generatedTools(ctx, ctx.fal))];
    } catch (e) {
      ctx.logger.warn("fal: model tools were skipped", { error: safeMessage(e) });
      return fixed;
    }
  },
});
