// packs/local/ollama.ts
//
// Chat and embeddings through a local Ollama server.
import { defineTool, z } from "plughive/pack";
import type { PackContext } from "plughive/pack";
import {
  HINTS,
  LocalBackendError,
  backendFetch,
  baseUrl,
  errorExcerpt,
  readJson,
  settingString,
} from "./lib/util.js";

const BACKEND = "Ollama";
const MAX_TOKENS_CAP = 8192;
const MAX_MESSAGES = 100;
const MAX_CHARS = 400_000;
const CHAT_TIMEOUT_MS = 5 * 60_000;

export interface OllamaModel {
  name: string;
  size_bytes: number | null;
  family: string | null;
  parameter_size: string | null;
  quantization: string | null;
  modified_at: string | null;
}

interface TagsResponse {
  models?: Array<{
    name?: string;
    model?: string;
    size?: number;
    modified_at?: string;
    details?: { family?: string; parameter_size?: string; quantization_level?: string };
  }>;
}

async function call<T>(
  ctx: PackContext,
  path: string,
  json?: unknown,
  timeoutMs = 30_000,
): Promise<T> {
  const base = baseUrl(ctx, "ollamaUrl");
  const res = await backendFetch(ctx, BACKEND, HINTS.ollama, base, path, {
    ...(json !== undefined ? { json } : {}),
    timeoutMs,
  });
  if (!res.ok) {
    const detail = await errorExcerpt(res);
    if (res.status === 404 && /model/i.test(detail)) {
      throw new LocalBackendError(
        `Ollama: ${detail}. Pull it first, for example \`ollama pull <model>\`; local_ollama_models lists what is installed.`,
      );
    }
    throw new Error(`Ollama ${path} returned HTTP ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return readJson<T>(res);
}

export async function listOllamaModels(ctx: PackContext): Promise<OllamaModel[]> {
  const data = await call<TagsResponse>(ctx, "/api/tags");
  return (data.models ?? []).flatMap((m) => {
    const name = m.name ?? m.model;
    if (!name) return [];
    return [
      {
        name,
        size_bytes: m.size ?? null,
        family: m.details?.family ?? null,
        parameter_size: m.details?.parameter_size ?? null,
        quantization: m.details?.quantization_level ?? null,
        modified_at: m.modified_at ?? null,
      },
    ];
  });
}

/** Explicit model, else the ollamaModel setting, else the first installed model. */
export async function resolveOllamaModel(ctx: PackContext, requested?: string): Promise<string> {
  if (requested) return requested;
  const configured = settingString(ctx, "ollamaModel");
  if (configured) return configured;
  const models = await listOllamaModels(ctx);
  const first = models[0];
  if (!first) {
    throw new LocalBackendError(`Ollama is running but has no models installed. ${HINTS.ollama}`);
  }
  return first.name;
}

const message = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().max(200_000),
});

export const ChatInput = z.object({
  messages: z.array(message).min(1).max(MAX_MESSAGES),
  model: z.string().min(1).max(200).optional(),
  max_tokens: z.number().int().min(1).max(MAX_TOKENS_CAP).optional(),
  temperature: z.number().min(0).max(2).optional(),
  json: z
    .boolean()
    .optional()
    .describe(
      "Ask the model for a single JSON value (Ollama JSON mode). Say so in the prompt too.",
    ),
});
export type ChatArgs = z.output<typeof ChatInput>;

interface ChatResponse {
  model?: string;
  message?: { content?: string };
  prompt_eval_count?: number;
  eval_count?: number;
  done_reason?: string;
}

export async function localChat(ctx: PackContext, input: ChatArgs) {
  const chars = input.messages.reduce((n, m) => n + m.content.length, 0);
  if (chars > MAX_CHARS)
    throw new Error(`messages are ${chars} characters, over the ${MAX_CHARS} limit`);
  const model = await resolveOllamaModel(ctx, input.model);
  const data = await call<ChatResponse>(
    ctx,
    "/api/chat",
    {
      model,
      messages: input.messages,
      stream: false,
      ...(input.json ? { format: "json" } : {}),
      options: {
        num_predict: input.max_tokens ?? 1024,
        ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      },
    },
    CHAT_TIMEOUT_MS,
  );
  const text = data.message?.content ?? "";
  const prompt = data.prompt_eval_count ?? 0;
  const completion = data.eval_count ?? 0;
  return {
    text,
    usage: { input_tokens: prompt, output_tokens: completion, total_tokens: prompt + completion },
    model: data.model ?? model,
    finish_reason: data.done_reason ?? null,
  };
}

export const EmbedInput = z.object({
  input: z.union([
    z.string().min(1).max(100_000),
    z.array(z.string().min(1).max(100_000)).min(1).max(64),
  ]),
  model: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("An embedding model such as nomic-embed-text. Defaults to the default Ollama model."),
});

export async function localEmbed(ctx: PackContext, input: z.output<typeof EmbedInput>) {
  const model = await resolveOllamaModel(ctx, input.model);
  const data = await call<{ embeddings?: number[][]; model?: string }>(
    ctx,
    "/api/embed",
    { model, input: input.input },
    120_000,
  );
  const embeddings = data.embeddings ?? [];
  if (embeddings.length === 0)
    throw new Error(`Ollama returned no embeddings; is ${model} an embedding model?`);
  return {
    model: data.model ?? model,
    count: embeddings.length,
    dimensions: embeddings[0]?.length ?? 0,
    embeddings,
  };
}

export const ollamaTools = [
  defineTool({
    name: "local_ollama_models",
    description:
      "List the models installed in the local Ollama server (name, size, family, quantization). No API key.",
    input: z.object({}),
    annotations: { title: "List Ollama models", readOnlyHint: true, openWorldHint: false },
    tags: ["local", "ollama"],
    async run(_input, ctx) {
      const models = await listOllamaModels(ctx);
      return {
        models,
        count: models.length,
        default_model: settingString(ctx, "ollamaModel") ?? models[0]?.name ?? null,
      };
    },
  }),
  defineTool({
    name: "local_chat",
    capability: "chat",
    description:
      "Chat with a model running in local Ollama. Takes role/content messages, an optional model (default: the pack setting, else the first installed), bounded max_tokens and an optional JSON mode. No API key, nothing leaves this machine.",
    input: ChatInput,
    annotations: { title: "Local chat (Ollama)", readOnlyHint: true, openWorldHint: false },
    tags: ["local", "ollama", "llm"],
    run: (input, ctx) => localChat(ctx, input),
  }),
  defineTool({
    name: "local_embed",
    description:
      "Compute text embeddings with a local Ollama embedding model (for example nomic-embed-text). Accepts one string or up to 64.",
    input: EmbedInput,
    annotations: { title: "Local embeddings (Ollama)", readOnlyHint: true, openWorldHint: false },
    tags: ["local", "ollama", "embeddings"],
    run: (input, ctx) => localEmbed(ctx, input),
  }),
];
