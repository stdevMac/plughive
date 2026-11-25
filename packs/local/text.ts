// packs/local/text.ts
//
// text.translate, text.embed and text.rerank on a local Ollama server.
// Translation is a chat call with a fixed instruction; embeddings use
// /api/embed with an embedding model; reranking embeds the query and the
// documents with that model and orders them by cosine similarity (Ollama has
// no cross-encoder endpoint).
import type { PackContext } from "plughive/pack";
import { HINTS, LocalBackendError, settingString } from "./lib/util.js";
import { type OllamaModel, listOllamaModels, localChat, localEmbed } from "./ollama.js";

/** /api/embed batch size this pack sends (localEmbed accepts up to 64 strings). */
export const EMBED_BATCH = 64;
const MAX_TRANSLATE_CHARS = 100_000;
const TRANSLATE_CHUNK_CHARS = 6000;

const EMBED_NAME = /embed|bge|minilm|e5-|gte-|arctic|granite-embedding|paraphrase/i;

export function isEmbeddingModel(m: Pick<OllamaModel, "name" | "family">): boolean {
  return EMBED_NAME.test(m.name) || /bert/i.test(m.family ?? "");
}

/** Explicit model, else the ollamaEmbedModel setting, else the first installed embedding model. */
export async function resolveEmbedModel(ctx: PackContext, requested?: string): Promise<string> {
  if (requested) return requested;
  const configured = settingString(ctx, "ollamaEmbedModel");
  if (configured) return configured;
  const found = (await listOllamaModels(ctx)).find(isEmbeddingModel);
  if (!found) {
    throw new LocalBackendError(
      `Ollama has no embedding model installed. Pull one, for example \`ollama pull nomic-embed-text\`, or set the local pack setting ollamaEmbedModel. ${HINTS.ollama}`,
    );
  }
  return found.name;
}

/** Explicit model, else the ollamaModel setting, else the first installed model that is not an embedding model. */
export async function resolveChatModel(ctx: PackContext, requested?: string): Promise<string> {
  if (requested) return requested;
  const configured = settingString(ctx, "ollamaModel");
  if (configured) return configured;
  const found = (await listOllamaModels(ctx)).find((m) => !isEmbeddingModel(m));
  if (!found) {
    throw new LocalBackendError(
      `Ollama has no chat model installed. Pull one, for example \`ollama pull llama3.2\`. ${HINTS.ollama}`,
    );
  }
  return found.name;
}

// ---------------------------------------------------------------------------
// text.embed
// ---------------------------------------------------------------------------

export interface EmbedTextsInput {
  texts: string[];
  model?: string;
}

export async function embedTexts(ctx: PackContext, input: EmbedTextsInput) {
  const model = await resolveEmbedModel(ctx, input.model);
  const embeddings: number[][] = [];
  let used = model;
  for (let i = 0; i < input.texts.length; i += EMBED_BATCH) {
    const r = await localEmbed(ctx, { input: input.texts.slice(i, i + EMBED_BATCH), model });
    used = r.model;
    embeddings.push(...r.embeddings);
  }
  if (embeddings.length !== input.texts.length) {
    throw new Error(
      `Ollama returned ${embeddings.length} embeddings for ${input.texts.length} texts`,
    );
  }
  const dimensions = embeddings[0]?.length ?? 0;
  if (dimensions === 0 || embeddings.some((e) => e.length !== dimensions)) {
    throw new Error("Ollama returned embeddings of inconsistent length");
  }
  return { embeddings, model: used, dimensions };
}

// ---------------------------------------------------------------------------
// text.rerank
// ---------------------------------------------------------------------------

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] as number;
    const y = b[i] as number;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

export interface RerankInput {
  query: string;
  documents: string[];
  top_n?: number;
  model?: string;
}

export async function rerankTexts(ctx: PackContext, input: RerankInput) {
  const { embeddings, model } = await embedTexts(ctx, {
    texts: [input.query, ...input.documents],
    ...(input.model ? { model: input.model } : {}),
  });
  const [q, ...docs] = embeddings;
  const results = docs
    .map((d, index) => ({ index, score: Math.round(cosine(q as number[], d) * 1e6) / 1e6 }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, input.top_n ?? docs.length);
  return { results, model };
}

// ---------------------------------------------------------------------------
// text.translate
// ---------------------------------------------------------------------------

export interface TranslateInput {
  text: string;
  target_language: string;
  source_language?: string;
  formality?: "default" | "more" | "less";
  model?: string;
}

/** Split on paragraph, then line, then sentence boundaries into chunks of at most `max` characters. */
export function chunkText(text: string, max = TRANSLATE_CHUNK_CHARS): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > max) {
    const window = rest.slice(0, max);
    // `cut` is the last character kept in this chunk.
    let cut = window.lastIndexOf("\n\n") + 1;
    if (cut < max / 3) cut = window.lastIndexOf("\n");
    if (cut < max / 3) cut = Math.max(window.lastIndexOf(". ") + 1, window.lastIndexOf("。"));
    if (cut < max / 3) cut = window.lastIndexOf(" ");
    if (cut < max / 3) cut = max - 1;
    out.push(rest.slice(0, cut + 1));
    rest = rest.slice(cut + 1);
  }
  if (rest) out.push(rest);
  return out;
}

export function translatePrompt(input: Omit<TranslateInput, "text" | "model">): string {
  const tone =
    input.formality === "more"
      ? " Use a formal register."
      : input.formality === "less"
        ? " Use an informal register."
        : "";
  const from = input.source_language ? ` from the language with code ${input.source_language}` : "";
  return `You are a translation engine. Translate the user's text${from} into the language with code ${input.target_language}.${tone} Keep the meaning, formatting, line breaks, markdown, numbers, names and code unchanged. Reply with the translation only: no notes, no quotes, no preamble.`;
}

export async function translateText(ctx: PackContext, input: TranslateInput) {
  if (input.text.length > MAX_TRANSLATE_CHARS) {
    throw new Error(`text is over ${MAX_TRANSLATE_CHARS} characters`);
  }
  const model = await resolveChatModel(ctx, input.model);
  const system = translatePrompt(input);
  const parts: string[] = [];
  let used = model;
  const chunks = chunkText(input.text);
  for (const [i, chunk] of chunks.entries()) {
    ctx.progress?.(i / chunks.length, `translating part ${i + 1} of ${chunks.length}`);
    const r = await localChat(ctx, {
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: chunk },
      ],
      max_tokens: Math.min(8192, Math.ceil(chunk.length * 1.5) + 64),
      temperature: 0.2,
    });
    used = r.model;
    // Keep the whitespace between chunks that the model trims.
    const lead = /^\s*/.exec(chunk)?.[0] ?? "";
    const trail = /\s*$/.exec(chunk)?.[0] ?? "";
    parts.push(`${lead}${r.text.trim()}${trail}`);
  }
  return { text: parts.join(""), model: used };
}
