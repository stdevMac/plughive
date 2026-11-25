// packs/openrouter/index.ts
//
// OpenRouter provider pack: chat completions, model search over OpenRouter's
// public catalogs, a generic runner for video, image, speech and
// transcription models, typed generate tools, and one tool per model listed
// in the `models` setting. Catalog reads need no key; every generation does.
import { type AnyToolDefinition, type PackContext, definePack, defineTool, z } from "plughive/pack";
import {
  audioTranscribe,
  imageGenerate,
  messageText,
  speechGenerate,
  videoGenerate,
} from "./capabilities.js";
import {
  type Kind,
  type ModelEntry,
  type ModelSummary,
  PROVIDER,
  inputSchema,
  parseGeneralRow,
  summarize,
} from "./client.js";
import {
  type Json,
  exampleInput,
  fieldSummary,
  oneLine,
  parseModelList,
  safeMessage,
  toolDescription,
  toolNameFor,
} from "./common.js";
import {
  CHAT_MODEL_PATTERN,
  DEFAULT_CHAT_MODEL,
  MAX_CHAT_MESSAGES,
  OpenRouterRuntime,
  SECRET,
  SNAPSHOT_NOTE,
  runtimeOf,
} from "./runtime.js";

import { providers } from "./capabilities.js";

export { capabilities } from "./capabilities.js";

export const DEFAULT_MODELS = [
  "google/veo-3.1-fast",
  "google/gemini-nano-banana-2.1",
  "openai/gpt-image-2",
  "elevenlabs/eleven-v3",
];
const FIXED = [
  "openrouter_search_models",
  "openrouter_describe_model",
  "openrouter_run",
  "openrouter_chat",
  "openrouter_generate_image",
  "openrouter_generate_video",
  "openrouter_generate_speech",
  "openrouter_transcribe",
  "openrouter_video_result",
];
/** Generation tools spend money but never delete or overwrite anything. */
const RUN_ANNOTATIONS = { openWorldHint: true, destructiveHint: false } as const;
const MODALITIES = ["chat", "image", "video", "speech", "transcription"] as const;

const ModelId = z
  .string()
  .min(3)
  .max(200)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
    'models look like "vendor/name"',
  )
  .describe('OpenRouter model id, "vendor/name", as openrouter_search_models returns it');
const ChatModelId = z
  .string()
  .max(200)
  .regex(CHAT_MODEL_PATTERN, 'models look like "vendor/name", optionally with a ":variant" suffix')
  .describe(
    'OpenRouter model id, for example "openai/gpt-5" or "meta-llama/llama-3.3-70b-instruct:free"',
  );
const ArtifactId = z
  .string()
  .max(140)
  .regex(/^(artifact:)?[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/, "a library artifact id");
const Seed = z.number().int().min(0).max(4_294_967_295);

function bareId(id: string): string {
  return id.startsWith("artifact:") ? id.slice("artifact:".length) : id;
}

// ---------------------------------------------------------------------------
// Search and describe
// ---------------------------------------------------------------------------

const CATALOG_MODALITIES: Partial<Record<Kind, "video" | "image" | "speech">> = {
  video: "video",
  image: "image",
  speech: "speech",
};

function matches(e: ModelEntry, terms: string[]): boolean {
  if (terms.length === 0) return true;
  const hay = `${e.id} ${e.name} ${e.description}`.toLowerCase();
  return terms.every((t) => hay.includes(t));
}

const searchModels = defineTool({
  name: "openrouter_search_models",
  description:
    "Search OpenRouter's models. With modality image, video or speech it filters OpenRouter's media catalogs " +
    "(params and prices included); otherwise it searches the main model list (chat, transcription and more). " +
    "No key needed. Call openrouter_describe_model next for a model's inputs.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z
      .string()
      .max(200)
      .optional()
      .describe('Free text, for example "veo", "flux" or "whisper"'),
    modality: z.enum(MODALITIES).optional().describe("What the model produces"),
    limit: z.number().int().min(1).max(50).default(10),
  }),
  async run(input, ctx) {
    const rt = runtimeOf(ctx);
    const query = input.query?.trim() ?? "";
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const catalogKind = input.modality ? CATALOG_MODALITIES[input.modality] : undefined;
    if (catalogKind) {
      const { entries, source } = await rt.catalog(ctx, catalogKind);
      const rows = entries.filter((e) => matches(e, terms));
      return {
        provider: PROVIDER,
        source,
        ...(source === "snapshot" ? { source_note: SNAPSHOT_NOTE } : {}),
        total: rows.length,
        models: rows.slice(0, input.limit).map(summarize),
      };
    }
    const output =
      input.modality === "transcription"
        ? "transcription"
        : input.modality === "chat"
          ? "text"
          : "all";
    const key = `search:${output}:${query.toLowerCase()}`;
    const { value, cached } = await rt.cache.through(key, async () => {
      const body = await rt
        .client(ctx.fetch)
        .search({ q: query || undefined, output_modalities: output, limit: 50 }, ctx.signal);
      const rows: Json[] = Array.isArray(body?.data) ? body.data : [];
      return rows.slice(0, 50).flatMap((r) => {
        const e = parseGeneralRow(r);
        if (!e) return [];
        const s: ModelSummary & { context_length?: number } = summarize(e);
        if (typeof r?.context_length === "number") s.context_length = r.context_length;
        return [s];
      });
    });
    let rows = value as ModelSummary[];
    if (input.modality === "chat") rows = rows.filter((r) => r.kind === "chat");
    return {
      provider: PROVIDER,
      source: cached ? "cache" : "live",
      models: rows.slice(0, input.limit),
    };
  },
});

function exampleFor(e: ModelEntry): Json {
  const schema = inputSchema(e);
  const overrides: Json =
    e.kind === "speech"
      ? { input: "Hello from plughive." }
      : e.kind === "transcription"
        ? { audio: "artifact:<id>" }
        : {
            prompt:
              e.kind === "video"
                ? "A slow aerial shot over a misty forest at sunrise"
                : "A red fox in fresh snow, studio light",
          };
  const ex = exampleInput(schema, overrides);
  // Optional file fields make a confusing example.
  for (const k of ["first_frame", "last_frame", "input_references"]) delete ex[k];
  return ex;
}

const describeModel = defineTool({
  name: "openrouter_describe_model",
  description:
    "Show an OpenRouter model's kind, input schema (built from OpenRouter's catalog), pricing and a ready " +
    "openrouter_run (or openrouter_chat) call. No key needed.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({ model: ModelId }),
  async run(input, ctx) {
    const rt = runtimeOf(ctx);
    const { entry: e, source } = await rt.lookup(ctx, input.model, { fresh: true });
    if (!e)
      throw new Error(
        `OpenRouter has no model "${input.model}". Find one with openrouter_search_models.`,
      );
    const base = {
      provider: PROVIDER,
      source,
      ...(source === "snapshot" ? { source_note: SNAPSHOT_NOTE } : {}),
      id: e.id,
      name: e.name,
      kind: e.kind,
      description: e.description,
      input_modalities: e.input_modalities,
      pricing: e.pricing,
      pricing_note:
        "Prices are USD strings per unit as OpenRouter lists them (per token, per second or per image).",
    };
    if (e.kind === "chat") {
      return {
        ...base,
        example_call: {
          tool: "openrouter_chat",
          arguments: { model: e.id, messages: [{ role: "user", content: "Hello" }] },
        },
      };
    }
    const schema = inputSchema(e);
    return {
      ...base,
      params: e.params,
      input_schema: schema,
      ...(e.frame_images ? { frame_images: e.frame_images } : {}),
      ...(e.passthrough?.length ? { provider_passthrough_parameters: e.passthrough } : {}),
      output_note:
        e.kind === "transcription"
          ? "Returns {text} (and segments when the model gives them)."
          : "Every output file is saved to the library; the result lists its artifacts.",
      file_inputs:
        'Pass library files as "artifact:<id>" (sent inline, up to 20 MB each). https URLs work only with the allow_url_inputs setting.',
      example_call: { tool: "openrouter_run", arguments: { model: e.id, input: exampleFor(e) } },
      per_model_tool: rt.registered.get(e.id) ?? null,
    };
  },
});

const videoResult = defineTool({
  name: "openrouter_video_result",
  description:
    "Collect the video of an OpenRouter video job that was already submitted (for example after a timeout, " +
    "a cancelled call or a lost connection): {job_id}. Never submits or pays for a new job. Returns the run " +
    "result, or {status} while the job is still pending or in progress.",
  secrets: [SECRET],
  longRunning: true,
  annotations: { ...RUN_ANNOTATIONS, idempotentHint: true },
  input: z.object({
    job_id: z
      .string()
      .min(1)
      .max(200)
      .describe("The OpenRouter video job id quoted by the earlier call"),
  }),
  async run(input, ctx) {
    return runtimeOf(ctx).collectVideo(ctx, input.job_id);
  },
});

const runModel = defineTool({
  name: "openrouter_run",
  description:
    "Run an OpenRouter video, image, speech or transcription model: {model, input}. The input is checked " +
    "against the model's catalog parameters first (see openrouter_describe_model). Pass library files as " +
    '"artifact:<id>". Output files are saved to the library; returns {artifacts, output, model, provider, cost_usd}. ' +
    "Use openrouter_chat for text models. OpenRouter cannot cancel a started video job; if a call stops " +
    "early, collect the job with openrouter_video_result.",
  secrets: [SECRET],
  longRunning: true,
  annotations: RUN_ANNOTATIONS,
  tags: ["paid"],
  input: z.object({
    model: ModelId,
    input: z
      .record(z.string(), z.unknown())
      .describe("Model input, as in openrouter_describe_model"),
  }),
  async run(input, ctx) {
    return runtimeOf(ctx).run(ctx, input.model, input.input);
  },
});

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

const Message = z.looseObject({
  role: z.enum(["system", "user", "assistant", "tool", "developer"]),
  content: z.union([z.string().max(2_000_000), z.array(z.unknown()).max(200), z.null()]),
  name: z.string().max(64).optional(),
  tool_call_id: z.string().max(200).optional(),
  tool_calls: z.array(z.unknown()).max(128).optional(),
});

/** Shallow checks for pass-through objects: known shapes, bounded sizes. */
const SmallObject = z
  .record(z.string().max(64), z.unknown())
  .refine((v) => Object.keys(v).length <= 32 && JSON.stringify(v).length <= 16_384, {
    message: "at most 32 keys and 16 KB",
  });
const ProviderPrefs = z
  .looseObject({
    order: z.array(z.string().max(100)).max(50).optional(),
    only: z.array(z.string().max(100)).max(50).optional(),
    ignore: z.array(z.string().max(100)).max(50).optional(),
    allow_fallbacks: z.boolean().optional(),
    require_parameters: z.boolean().optional(),
    data_collection: z.enum(["allow", "deny"]).optional(),
    sort: z.union([z.string().max(40), SmallObject]).optional(),
  })
  .refine((v) => Object.keys(v).length <= 32 && JSON.stringify(v).length <= 16_384, {
    message: "at most 32 keys and 16 KB",
  });
const Reasoning = z.strictObject({
  effort: z.enum(["minimal", "low", "medium", "high", "xhigh"]).optional(),
  max_tokens: z.number().int().min(1).max(1_000_000).optional(),
  exclude: z.boolean().optional(),
  enabled: z.boolean().optional(),
});
const ChatTool = z.strictObject({
  type: z.literal("function"),
  function: z.strictObject({
    name: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/, "function names are 1-64 letters, digits, _ or -"),
    description: z.string().max(4000).optional(),
    parameters: z
      .record(z.string(), z.unknown())
      .refine((v) => JSON.stringify(v).length <= 65_536, {
        message: "parameters schema over 64 KB",
      })
      .optional(),
    strict: z.boolean().optional(),
  }),
});

const chatTool = defineTool({
  name: "openrouter_chat",
  description:
    "Chat completion through OpenRouter (/chat/completions) with any of its text models. Accepts the usual " +
    "request fields (messages, temperature, response_format, tools, tool_choice, provider routing, reasoning). " +
    'Image parts may use "artifact:<id>" as the url (sent inline); any other URL in a message is passed to ' +
    "OpenRouter and the model provider, which fetch it. max_tokens is capped by the max_chat_tokens setting. " +
    "OpenRouter has no cancel endpoint: a stopped call may still be billed for the tokens generated. " +
    "Returns {text, tool_calls, usage, cost_usd}; set include_raw for the full response or save_artifact to " +
    "keep it in the library.",
  secrets: [SECRET],
  longRunning: true,
  annotations: RUN_ANNOTATIONS,
  tags: ["paid"],
  input: z.object({
    model: ChatModelId.optional().describe("Model id. Default: the chat_model setting"),
    messages: z.array(Message).min(1).max(MAX_CHAT_MESSAGES),
    temperature: z.number().min(0).max(2).optional(),
    max_tokens: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .optional()
      .describe(
        "Output token cap; calls over the max_chat_tokens setting (default 32768) are refused",
      ),
    top_p: z.number().min(0).max(1).optional(),
    frequency_penalty: z.number().min(-2).max(2).optional(),
    presence_penalty: z.number().min(-2).max(2).optional(),
    stop: z.array(z.string().max(200)).max(4).optional(),
    seed: z.number().int().optional(),
    json: z.boolean().optional().describe('Shortcut for response_format {type: "json_object"}'),
    response_format: z.record(z.string(), z.unknown()).optional(),
    tools: z.array(ChatTool).max(128).optional(),
    tool_choice: z.union([z.string().max(100), SmallObject]).optional(),
    provider: ProviderPrefs.optional().describe("OpenRouter provider routing preferences"),
    transforms: z.array(z.string().max(100)).max(10).optional(),
    reasoning: Reasoning.optional(),
    save_artifact: z
      .boolean()
      .default(false)
      .describe("Save the full JSON response in the library"),
    include_raw: z.boolean().default(false).describe("Include the full OpenRouter response"),
  }),
  async run(input, ctx) {
    const { save_artifact, include_raw, json, model: requested, ...rest } = input;
    const setting =
      typeof ctx.settings.chat_model === "string" ? ctx.settings.chat_model.trim() : "";
    const model = requested ?? (setting || DEFAULT_CHAT_MODEL);
    const request: Json = { ...rest, model };
    if (json && !request.response_format) request.response_format = { type: "json_object" };
    const resp = await runtimeOf(ctx).chat(ctx, request);
    const choice = resp?.choices?.[0];
    const usage = resp?.usage && typeof resp.usage === "object" ? resp.usage : null;
    const cost = typeof usage?.cost === "number" ? usage.cost : null;
    const finish = typeof choice?.finish_reason === "string" ? choice.finish_reason : null;
    const used = typeof resp?.model === "string" ? resp.model : model;
    let artifact: { id: string; mime: string; url: string } | null = null;
    if (save_artifact) {
      const last = input.messages[input.messages.length - 1];
      const ref = await ctx.library.save({
        kind: "other",
        mime: "application/json",
        bytes: new Uint8Array(Buffer.from(JSON.stringify(resp, null, 2), "utf8")),
        model: used,
        prompt: (messageText(last?.content) ?? "").slice(0, 500),
        costUsd: cost,
        meta: { provider: PROVIDER, finish_reason: finish },
      });
      artifact = { id: ref.id, mime: ref.mime, url: ref.url };
    }
    return {
      model: used,
      provider: PROVIDER,
      text: messageText(choice?.message?.content),
      finish_reason: finish,
      tool_calls: Array.isArray(choice?.message?.tool_calls) ? choice.message.tool_calls : null,
      ...(typeof choice?.message?.reasoning === "string"
        ? { reasoning: choice.message.reasoning }
        : {}),
      usage,
      cost_usd: cost,
      artifact,
      ...(include_raw ? { raw: resp } : {}),
    };
  },
});

// ---------------------------------------------------------------------------
// Typed generate tools
// ---------------------------------------------------------------------------

const generateImage = defineTool({
  name: "openrouter_generate_image",
  description:
    "Generate or edit images with an OpenRouter image model (default google/gemini-nano-banana-2.1). " +
    "Give image_inputs (library artifact ids) to edit or reference images. Images are saved to the library.",
  secrets: [SECRET],
  longRunning: true,
  annotations: RUN_ANNOTATIONS,
  tags: ["paid"],
  input: z.object({
    prompt: z.string().min(1).max(32_000),
    model: ModelId.optional(),
    aspect_ratio: z
      .string()
      .regex(/^(\d{1,2}:\d{1,2}|auto)$/)
      .optional()
      .describe('For example "16:9"'),
    n: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe("How many images (only some models make more than one)"),
    image_inputs: z
      .array(ArtifactId)
      .max(16)
      .optional()
      .describe("Library artifact ids to edit or use as references"),
    seed: Seed.optional(),
  }),
  async run(input, ctx) {
    return imageGenerate({ ...input, image_inputs: input.image_inputs?.map(bareId) }, ctx);
  },
});

const generateVideo = defineTool({
  name: "openrouter_generate_video",
  description:
    "Generate a video with an OpenRouter video model (default google/veo-3.1-fast). Give image_input to start " +
    "from a library image. Takes minutes; the video is saved to the library. OpenRouter cannot cancel a " +
    "started job, so a cancelled call may still be billed; collect it with openrouter_video_result.",
  secrets: [SECRET],
  longRunning: true,
  annotations: RUN_ANNOTATIONS,
  tags: ["paid"],
  input: z.object({
    prompt: z.string().min(1).max(8000),
    model: ModelId.optional(),
    aspect_ratio: z
      .string()
      .regex(/^\d{1,2}:\d{1,2}$/)
      .optional(),
    duration_seconds: z
      .number()
      .min(1)
      .max(600)
      .optional()
      .describe("Snapped to the nearest length the model allows"),
    resolution: z
      .string()
      .regex(/^[A-Za-z0-9]{1,10}$/)
      .optional()
      .describe('For example "720p" or "1080p"'),
    image_input: ArtifactId.optional().describe("Library image for the first frame"),
    last_frame: ArtifactId.optional().describe("Library image for the last frame"),
    generate_audio: z.boolean().optional(),
    seed: Seed.optional(),
  }),
  async run(input, ctx) {
    return videoGenerate(
      {
        ...input,
        image_input: input.image_input ? bareId(input.image_input) : undefined,
        last_frame: input.last_frame ? bareId(input.last_frame) : undefined,
      },
      ctx,
    );
  },
});

const generateSpeech = defineTool({
  name: "openrouter_generate_speech",
  description:
    "Turn text into speech with an OpenRouter speech model (default elevenlabs/eleven-v3). " +
    "openrouter_describe_model lists a model's voices. The audio is saved to the library.",
  secrets: [SECRET],
  longRunning: true,
  annotations: RUN_ANNOTATIONS,
  tags: ["paid"],
  input: z.object({
    text: z.string().min(1).max(20_000),
    voice: z
      .string()
      .max(100)
      .regex(/^[A-Za-z0-9 ._-]+$/)
      .optional(),
    model: ModelId.optional(),
    format: z.enum(["mp3", "pcm"]).optional(),
    speed: z.number().min(0.25).max(4).optional(),
  }),
  async run(input, ctx) {
    return speechGenerate(input, ctx);
  },
});

const transcribe = defineTool({
  name: "openrouter_transcribe",
  description:
    "Transcribe a library audio file with an OpenRouter speech-to-text model (default elevenlabs/scribe-v2). " +
    "Returns {text}.",
  secrets: [SECRET],
  longRunning: true,
  annotations: RUN_ANNOTATIONS,
  tags: ["paid"],
  input: z.object({
    artifact_id: ArtifactId,
    language: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .describe("ISO-639-1 code, for example en"),
    model: ModelId.optional(),
  }),
  async run(input, ctx) {
    return audioTranscribe({ ...input, artifact_id: bareId(input.artifact_id) }, ctx);
  },
});

// ---------------------------------------------------------------------------
// Per-model tools
// ---------------------------------------------------------------------------

function generatedName(id: string, taken: Set<string>): string | null {
  const name = toolNameFor(PROVIDER, id);
  return taken.has(name) ? null : name;
}

export function modelTool(
  rt: OpenRouterRuntime,
  entry: ModelEntry,
  name: string,
): AnyToolDefinition {
  const converted = rt.schemaFor(entry);
  const what = entry.kind === "transcription" ? "speech-to-text" : entry.kind;
  // Name and description come from OpenRouter's catalog (written by the model provider): labelled and capped.
  const description = toolDescription(
    `Runs the OpenRouter ${what} model ${entry.id}.`,
    entry.kind === "transcription"
      ? 'Pass the audio as "artifact:<id>".'
      : 'Pass library files as "artifact:<id>". Output files are saved to the library.',
    entry.kind === "video"
      ? "OpenRouter cannot cancel a started video job; collect a stopped one with openrouter_video_result."
      : "",
    converted.exact ? "" : `Input fields: ${fieldSummary(converted.fields)}.`,
    entry.description ? `Model provider's description: ${oneLine(entry.description, 240)}` : "",
  );
  const title = oneLine(entry.name || entry.id, 80);
  return defineTool({
    name,
    description,
    input: converted.zod as z.ZodType<Record<string, unknown>>,
    secrets: [SECRET],
    longRunning: true,
    annotations: { ...RUN_ANNOTATIONS, title },
    tags: ["openrouter", "paid", entry.kind],
    async run(input, ctx) {
      return runtimeOf(ctx).run(ctx, entry.id, input, { entry, skipValidation: converted.exact });
    },
  });
}

/**
 * Typed tools for the `models` setting. Built only from the disk cache and
 * the bundled catalog snapshot: no network at startup, never throws.
 */
export async function generatedTools(
  ctx: PackContext,
  rt: OpenRouterRuntime,
): Promise<AnyToolDefinition[]> {
  const raw = ctx.settings.models;
  const ids = typeof raw === "string" ? parseModelList(raw) : DEFAULT_MODELS;
  const taken = new Set(FIXED);
  const tools: AnyToolDefinition[] = [];
  rt.registered.clear();
  for (const id of ids) {
    try {
      const entry = await rt.entry(ctx, id, { offline: true });
      if (!entry) {
        ctx.logger.info(
          "openrouter: no catalog entry for a model in the models setting; its tool is skipped",
          {
            model: oneLine(id, 80),
          },
        );
        continue;
      }
      if (entry.kind === "chat") {
        ctx.logger.info("openrouter: chat models use openrouter_chat; no separate tool", {
          model: entry.id,
        });
        continue;
      }
      if (rt.registered.has(entry.id)) continue;
      const name = generatedName(entry.id, taken);
      if (!name) {
        ctx.logger.warn(
          "openrouter: a configured model's tool name collides with another tool; it is skipped",
          {
            model: entry.id,
          },
        );
        continue;
      }
      tools.push(modelTool(rt, entry, name));
      taken.add(name);
      rt.registered.set(entry.id, name);
    } catch (e) {
      ctx.logger.warn("openrouter: skipping a model in the models setting", {
        model: oneLine(id, 80),
        error: safeMessage(e),
      });
    }
  }
  return tools;
}

export default definePack({
  setup(ctx) {
    return { openrouter: new OpenRouterRuntime(ctx) };
  },
  providers,
  async tools(ctx) {
    const fixed: AnyToolDefinition[] = [
      searchModels,
      describeModel,
      runModel,
      chatTool,
      generateImage,
      generateVideo,
      generateSpeech,
      transcribe,
      videoResult,
    ];
    try {
      return [...fixed, ...(await generatedTools(ctx, ctx.openrouter))];
    } catch (e) {
      ctx.logger.warn("openrouter: model tools were skipped", { error: safeMessage(e) });
      return fixed;
    }
  },
});
