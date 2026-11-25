// packs/local/capabilities.ts
//
// The capability providers this pack serves (priority 10: the free fallback
// after keyed providers), plus plain (input, ctx) functions for direct use.
// Each provider is configured only when its backend answers right now, and an
// option the backend cannot honour throws a retryable CapabilityError before
// any request, so the router moves on.
import {
  type AnyProviderDefinition,
  CapabilityError,
  type PackContext,
  defineProvider,
} from "plughive/pack";
import { editImage, generateImage, listCheckpoints } from "./comfy.js";
import { type DocTarget, convertDocument, parseDocument } from "./documents.js";
import { ENGINES, type TranscriptSegment } from "./engines.js";
import {
  DEMUCS_MODELS,
  REALESRGAN_MODELS,
  removeBackground,
  separateStems,
  upscaleImage,
  upscaleVideo,
} from "./imaging.js";
import { speak } from "./kokoro.js";
import { binaryStatus } from "./lib/probe.js";
import { HINTS, settingString } from "./lib/util.js";
import { listOllamaModels, localChat } from "./ollama.js";
import { comfyStatusBrief, ffmpegStatus, kokoroStatus, ollamaStatus } from "./status.js";
import { embedTexts, isEmbeddingModel, rerankTexts, translateText } from "./text.js";
import { mediaTranscript } from "./transcript.js";
import { engineAvailable, engineFromModel, transcribe } from "./whisper.js";

export const PROVIDER_ID = "local";
export const PROVIDER_PRIORITY = 10;

export interface ImageGenerateInput {
  prompt: string;
  model?: string;
  aspect_ratio?: string;
  n?: number;
  seed?: number;
}

const ASPECTS = new Set(["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"]);

export async function imageGenerate(input: ImageGenerateInput, ctx: PackContext) {
  const r = await generateImage(
    ctx,
    {
      prompt: input.prompt,
      ...(input.model ? { model: input.model } : {}),
      ...(input.aspect_ratio && ASPECTS.has(input.aspect_ratio)
        ? { aspect_ratio: input.aspect_ratio as "1:1" }
        : {}),
      ...(input.n ? { n: Math.min(4, Math.max(1, Math.floor(input.n))) } : {}),
      ...(input.seed !== undefined && input.seed >= 0 && input.seed < 2 ** 32
        ? { seed: input.seed }
        : {}),
    },
    "image.generate",
  );
  return { artifacts: r.artifacts, model: r.model, provider: PROVIDER_ID };
}

export interface SpeechGenerateInput {
  text: string;
  voice?: string;
  model?: string;
  format?: "mp3" | "wav" | "flac" | "opus";
}

export async function speechGenerate(input: SpeechGenerateInput, ctx: PackContext) {
  const r = await speak(
    ctx,
    {
      text: input.text,
      ...(input.voice ? { voice: input.voice } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.format ? { format: input.format } : {}),
    },
    "speech.generate",
  );
  return { artifacts: [r.artifact], voice: r.voice, model: r.model, provider: PROVIDER_ID };
}

export interface AudioTranscribeInput {
  artifact_id: string;
  language?: string;
  model?: string;
  timestamps?: boolean;
  speakers?: boolean;
}

/** The engines write start_s/end_s; the capability output says start/end. */
export function capabilitySegments(segments: readonly TranscriptSegment[]) {
  return segments.map((s) => ({
    start: s.start_s,
    end: s.end_s,
    text: s.text,
    ...(s.speaker ? { speaker: s.speaker } : {}),
  }));
}

export async function audioTranscribe(input: AudioTranscribeInput, ctx: PackContext) {
  const byModel = engineFromModel(input.model);
  const r = await transcribe(
    ctx,
    {
      artifact_id: input.artifact_id,
      ...(input.language ? { language: input.language } : {}),
      ...(byModel ? { engine: byModel } : input.model ? { model: input.model } : {}),
      ...(input.speakers ? { speakers: true } : {}),
    },
    "audio.transcribe",
  );
  return {
    text: r.text,
    ...(input.timestamps === false ? {} : { segments: capabilitySegments(r.segments) }),
    language: r.language,
    srt_artifact: r.srt_artifact,
    model: r.model,
    engine: r.engine,
    provider: PROVIDER_ID,
  };
}

export interface ChatCapabilityInput {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model?: string;
  max_tokens?: number;
  temperature?: number;
  json?: boolean;
}

export async function chat(input: ChatCapabilityInput, ctx: PackContext) {
  const r = await localChat(ctx, {
    messages: input.messages,
    ...(input.model ? { model: input.model } : {}),
    ...(input.max_tokens !== undefined
      ? { max_tokens: Math.min(8192, Math.max(1, Math.floor(input.max_tokens))) }
      : {}),
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
    ...(input.json ? { json: true } : {}),
  });
  return { text: r.text, usage: r.usage, model: r.model, provider: PROVIDER_ID };
}

export interface ImageEditInput {
  artifact_id: string;
  prompt: string;
  model?: string;
  n?: number;
  seed?: number;
}

export async function imageEdit(input: ImageEditInput, ctx: PackContext) {
  const r = await editImage(
    ctx,
    {
      artifact_id: input.artifact_id,
      prompt: input.prompt,
      ...(input.model ? { model: input.model } : {}),
      ...(input.n ? { n: Math.min(4, Math.max(1, Math.floor(input.n))) } : {}),
      ...(input.seed !== undefined && input.seed >= 0 && input.seed < 2 ** 32
        ? { seed: input.seed }
        : {}),
    },
    "image.edit",
  );
  return { artifacts: r.artifacts, model: r.model, provider: PROVIDER_ID };
}

export async function imageUpscale(
  input: { artifact_id: string; scale?: number; model?: string },
  ctx: PackContext,
) {
  const r = await upscaleImage(ctx, input, "image.upscale");
  return { ...r, provider: PROVIDER_ID };
}

export async function imageRemoveBackground(
  input: { artifact_id: string; model?: string },
  ctx: PackContext,
) {
  const r = await removeBackground(ctx, input, "image.remove_background");
  return { ...r, provider: PROVIDER_ID };
}

export async function videoUpscale(
  input: { artifact_id: string; scale?: number },
  ctx: PackContext,
) {
  const r = await upscaleVideo(ctx, input, "video.upscale");
  return { ...r, provider: PROVIDER_ID };
}

export async function audioSeparateStems(
  input: { artifact_id: string; two_stems?: string; model?: string; format?: "mp3" | "wav" },
  ctx: PackContext,
) {
  const r = await separateStems(ctx, input, "audio.separate_stems");
  return { ...r, provider: PROVIDER_ID };
}

export async function documentParse(
  input: { artifact_id: string; format?: "markdown" | "text"; language?: string },
  ctx: PackContext,
) {
  const r = await parseDocument(ctx, input);
  return { ...r, provider: PROVIDER_ID };
}

export async function documentConvert(
  input: { artifact_id: string; to: DocTarget },
  ctx: PackContext,
) {
  const r = await convertDocument(ctx, input, "document.convert");
  return { ...r, provider: PROVIDER_ID };
}

export async function textTranslate(
  input: {
    text: string;
    target_language: string;
    source_language?: string;
    formality?: "default" | "more" | "less";
    model?: string;
  },
  ctx: PackContext,
) {
  const r = await translateText(ctx, input);
  return {
    text: r.text,
    ...(input.source_language ? { detected_source_language: input.source_language } : {}),
    model: r.model,
    provider: PROVIDER_ID,
  };
}

export async function textEmbed(input: { texts: string[]; model?: string }, ctx: PackContext) {
  const r = await embedTexts(ctx, input);
  return { ...r, provider: PROVIDER_ID };
}

export async function textRerank(
  input: { query: string; documents: string[]; top_n?: number; model?: string },
  ctx: PackContext,
) {
  const r = await rerankTexts(ctx, input);
  return { ...r, provider: PROVIDER_ID };
}

export async function mediaTranscriptCapability(
  input: { url: string; language?: string; timestamps?: boolean; model?: string },
  ctx: PackContext,
) {
  const r = await mediaTranscript(ctx, input);
  return {
    text: r.text,
    ...(r.segments ? { segments: capabilitySegments(r.segments) } : {}),
    language: r.language,
    title: r.title,
    model: r.model,
    source: r.source,
    provider: PROVIDER_ID,
  };
}

export const capabilities = {
  "image.generate": imageGenerate,
  "image.edit": imageEdit,
  "image.upscale": imageUpscale,
  "image.remove_background": imageRemoveBackground,
  "video.upscale": videoUpscale,
  "speech.generate": speechGenerate,
  "audio.transcribe": audioTranscribe,
  "audio.separate_stems": audioSeparateStems,
  "document.parse": documentParse,
  "document.convert": documentConvert,
  "text.translate": textTranslate,
  "text.embed": textEmbed,
  "text.rerank": textRerank,
  "media.transcript": mediaTranscriptCapability,
  chat,
};

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

const MODEL_ID = /^[A-Za-z0-9._:/@-]{1,120}$/;
const KOKORO_ID = /^[A-Za-z0-9_+.-]{1,80}$/;
const KOKORO_MAX_CHARS = 5000;

const unsupported = (what: string) =>
  new CapabilityError(`The local backends cannot do ${what}.`, {
    retryable: true,
    code: "UNSUPPORTED_OPTION",
  });

// Runs on this machine: nothing is billed, so a max_cost_usd never skips it.
const FREE = { usd: 0, basis: "local backend (no charge)" };
const base = {
  id: PROVIDER_ID,
  priority: PROVIDER_PRIORITY,
  cost: "local" as const,
  estimate: () => FREE,
};
const ids = (list: readonly string[]) => list.filter((m) => MODEL_ID.test(m)).slice(0, 200);

export const SETUP_HINTS = {
  "image.generate":
    "start ComfyUI with a checkpoint (local pack setting comfyUrl, default http://127.0.0.1:8188)",
  "image.edit":
    "start ComfyUI with a checkpoint for prompt-guided img2img (local pack setting comfyUrl, default http://127.0.0.1:8188)",
  "image.upscale": `install realesrgan-ncnn-vulkan and put it on PATH. ${HINTS.realesrgan}`,
  "image.remove_background": `install rembg with its CLI. ${HINTS.rembg}`,
  "video.upscale": `install ffmpeg (lanczos scaling, no AI model). ${HINTS.ffmpeg}`,
  "speech.generate":
    "start Kokoro-FastAPI (local pack setting kokoroUrl, default http://127.0.0.1:8880)",
  "audio.transcribe":
    "install ffmpeg and a speech engine: parakeet-mlx (Apple silicon), Hex, whisperX or whisper.cpp with a ggml model (local pack settings transcriptionEngine and whisperModelPath)",
  "audio.separate_stems": `install ffmpeg and Demucs. ${HINTS.demucs}`,
  "document.parse": `install Poppler (pdftotext) for PDFs, Tesseract for images, pandoc for office and HTML files, OCRmyPDF for scanned PDFs. ${HINTS.pdftotext}`,
  "document.convert": `install pandoc, or LibreOffice for PDF output and spreadsheets. ${HINTS.pandoc}`,
  "text.translate":
    "start Ollama and pull a chat model (local pack settings ollamaUrl and ollamaModel)",
  "text.embed":
    "start Ollama and pull an embedding model such as nomic-embed-text (local pack setting ollamaEmbedModel)",
  "text.rerank":
    "start Ollama and pull an embedding model such as nomic-embed-text; reranking ranks by embedding similarity",
  "media.transcript": `install yt-dlp; videos without subtitles also need ffmpeg and a speech engine. ${HINTS.ytdlp}`,
  chat: "start Ollama and pull a model (local pack setting ollamaUrl, default http://127.0.0.1:11434)",
} as const;

const installed = async (ctx: PackContext, binary: string, hint: string, args?: string[]) =>
  (await binaryStatus(ctx, binary, hint, args)).available;

async function anyEngine(ctx: PackContext): Promise<boolean> {
  for (const e of ENGINES) if (await engineAvailable(ctx, e)) return true;
  return false;
}

async function ollamaModels(ctx: PackContext) {
  const s = await ollamaStatus(ctx);
  if (!s.available) return null;
  return listOllamaModels(ctx).catch(() => null);
}

async function hasEmbedModel(ctx: PackContext): Promise<boolean> {
  const models = await ollamaModels(ctx);
  if (!models) return false;
  return settingString(ctx, "ollamaEmbedModel") !== undefined || models.some(isEmbeddingModel);
}

const DOC_TARGETS = new Set<string>([
  "pdf",
  "docx",
  "odt",
  "rtf",
  "html",
  "md",
  "txt",
  "epub",
  "pptx",
  "xlsx",
  "csv",
]);

export const providers: readonly AnyProviderDefinition[] = [
  defineProvider({
    ...base,
    capability: "image.generate",
    setupHint: SETUP_HINTS["image.generate"],
    isConfigured: async (ctx) => (await comfyStatusBrief(ctx)).available,
    models: async (ctx) => ids(await listCheckpoints(ctx)),
    run: (input, ctx) => {
      if (input.image_inputs?.length) throw unsupported("image editing or reference images");
      if (input.aspect_ratio && !ASPECTS.has(input.aspect_ratio)) {
        throw unsupported(`the aspect ratio ${input.aspect_ratio}`);
      }
      return imageGenerate(input, ctx);
    },
  }),
  defineProvider({
    ...base,
    capability: "speech.generate",
    setupHint: SETUP_HINTS["speech.generate"],
    isConfigured: async (ctx) => (await kokoroStatus(ctx)).available,
    models: () => ["kokoro"],
    run: (input, ctx) => {
      if (input.text.length > KOKORO_MAX_CHARS) {
        throw unsupported(`more than ${KOKORO_MAX_CHARS} characters in one request`);
      }
      if (input.voice !== undefined && !KOKORO_ID.test(input.voice))
        throw unsupported("that voice name");
      if (input.model !== undefined && !KOKORO_ID.test(input.model))
        throw unsupported("that model name");
      return speechGenerate(input, ctx);
    },
  }),
  defineProvider({
    ...base,
    capability: "image.edit",
    setupHint: SETUP_HINTS["image.edit"],
    isConfigured: async (ctx) => {
      const s = await comfyStatusBrief(ctx);
      return (
        s.available && Array.isArray(s.details.checkpoints) && s.details.checkpoints.length > 0
      );
    },
    models: async (ctx) => ids(await listCheckpoints(ctx)),
    run: (input, ctx) => {
      if (input.mask_id) throw unsupported("masked (inpainting) edits");
      if (input.reference_ids?.length) throw unsupported("edits with reference images");
      if (input.aspect_ratio) throw unsupported("changing the aspect ratio while editing");
      if (input.model !== undefined && !MODEL_ID.test(input.model))
        throw unsupported("that model name");
      return imageEdit(input, ctx);
    },
  }),
  defineProvider({
    ...base,
    capability: "image.upscale",
    setupHint: SETUP_HINTS["image.upscale"],
    isConfigured: (ctx) => installed(ctx, "realesrgan-ncnn-vulkan", HINTS.realesrgan, ["-h"]),
    models: () => [...REALESRGAN_MODELS],
    run: (input, ctx) => imageUpscale(input, ctx),
  }),
  defineProvider({
    ...base,
    capability: "image.remove_background",
    setupHint: SETUP_HINTS["image.remove_background"],
    isConfigured: (ctx) => installed(ctx, "rembg", HINTS.rembg, ["--help"]),
    models: () => [
      "u2net",
      "u2netp",
      "u2net_human_seg",
      "isnet-general-use",
      "isnet-anime",
      "silueta",
      "birefnet-general",
    ],
    run: (input, ctx) => imageRemoveBackground(input, ctx),
  }),
  defineProvider({
    ...base,
    capability: "video.upscale",
    setupHint: SETUP_HINTS["video.upscale"],
    isConfigured: async (ctx) => (await ffmpegStatus(ctx)).available,
    models: () => ["ffmpeg-lanczos"],
    run: (input, ctx) => {
      if (input.model !== undefined && !/^(ffmpeg-)?lanczos$/.test(input.model)) {
        throw unsupported(`the upscale model ${input.model} (only ffmpeg-lanczos)`);
      }
      return videoUpscale(
        { artifact_id: input.artifact_id, ...(input.scale ? { scale: input.scale } : {}) },
        ctx,
      );
    },
  }),
  defineProvider({
    ...base,
    capability: "audio.transcribe",
    setupHint: SETUP_HINTS["audio.transcribe"],
    isConfigured: async (ctx) => (await ffmpegStatus(ctx)).available && (await anyEngine(ctx)),
    models: () => [...ENGINES],
    run: async (input, ctx) => {
      if (input.speakers) {
        if (!(await engineAvailable(ctx, "whisperx")) || !(await ctx.secrets.has("HF_TOKEN"))) {
          throw unsupported("speaker labels without whisperX and the HF_TOKEN secret");
        }
      }
      if (input.model !== undefined && !MODEL_ID.test(input.model))
        throw unsupported("that model name");
      return audioTranscribe(input, ctx);
    },
  }),
  defineProvider({
    ...base,
    capability: "audio.separate_stems",
    setupHint: SETUP_HINTS["audio.separate_stems"],
    isConfigured: async (ctx) =>
      (await ffmpegStatus(ctx)).available &&
      (await installed(ctx, "demucs", HINTS.demucs, ["--help"])),
    models: () => [...DEMUCS_MODELS],
    run: (input, ctx) => audioSeparateStems(input, ctx),
  }),
  defineProvider({
    ...base,
    capability: "document.parse",
    setupHint: SETUP_HINTS["document.parse"],
    isConfigured: async (ctx) =>
      (await installed(ctx, "pdftotext", HINTS.pdftotext, ["-v"])) ||
      (await installed(ctx, "tesseract", HINTS.tesseract)) ||
      (await installed(ctx, "pandoc", HINTS.pandoc)),
    run: (input, ctx) => {
      if (input.model !== undefined) throw unsupported(`the parse model ${input.model}`);
      return documentParse(input, ctx);
    },
  }),
  defineProvider({
    ...base,
    capability: "document.convert",
    setupHint: SETUP_HINTS["document.convert"],
    isConfigured: async (ctx) =>
      (await installed(ctx, "pandoc", HINTS.pandoc)) ||
      (await installed(ctx, "soffice", HINTS.soffice)),
    run: (input, ctx) => {
      if (input.model !== undefined) throw unsupported(`the conversion model ${input.model}`);
      if (!DOC_TARGETS.has(input.to)) throw unsupported(`converting to ${input.to}`);
      return documentConvert({ artifact_id: input.artifact_id, to: input.to as DocTarget }, ctx);
    },
  }),
  defineProvider({
    ...base,
    capability: "text.translate",
    setupHint: SETUP_HINTS["text.translate"],
    isConfigured: async (ctx) =>
      ((await ollamaModels(ctx)) ?? []).some((m) => !isEmbeddingModel(m)),
    models: async (ctx) =>
      ids(((await ollamaModels(ctx)) ?? []).filter((m) => !isEmbeddingModel(m)).map((m) => m.name)),
    run: (input, ctx) => {
      if (input.model !== undefined && !MODEL_ID.test(input.model))
        throw unsupported("that model name");
      return textTranslate(input, ctx);
    },
  }),
  defineProvider({
    ...base,
    capability: "text.embed",
    setupHint: SETUP_HINTS["text.embed"],
    isConfigured: hasEmbedModel,
    models: async (ctx) =>
      ids(((await ollamaModels(ctx)) ?? []).filter(isEmbeddingModel).map((m) => m.name)),
    run: (input, ctx) => {
      if (input.dimensions !== undefined) throw unsupported("a chosen number of dimensions");
      if (input.model !== undefined && !MODEL_ID.test(input.model))
        throw unsupported("that model name");
      return textEmbed({ texts: input.texts, ...(input.model ? { model: input.model } : {}) }, ctx);
    },
  }),
  defineProvider({
    ...base,
    capability: "text.rerank",
    setupHint: SETUP_HINTS["text.rerank"],
    isConfigured: hasEmbedModel,
    models: async (ctx) =>
      ids(((await ollamaModels(ctx)) ?? []).filter(isEmbeddingModel).map((m) => m.name)),
    run: (input, ctx) => {
      if (input.model !== undefined && !MODEL_ID.test(input.model))
        throw unsupported("that model name");
      return textRerank(input, ctx);
    },
  }),
  defineProvider({
    ...base,
    capability: "media.transcript",
    setupHint: SETUP_HINTS["media.transcript"],
    isConfigured: (ctx) => installed(ctx, "yt-dlp", HINTS.ytdlp),
    run: (input, ctx) => {
      if (input.model !== undefined && !MODEL_ID.test(input.model))
        throw unsupported("that model name");
      return mediaTranscriptCapability(input, ctx);
    },
  }),
  defineProvider({
    ...base,
    capability: "chat",
    setupHint: SETUP_HINTS.chat,
    isConfigured: async (ctx) => {
      const s = await ollamaStatus(ctx);
      return s.available && Array.isArray(s.details.models) && s.details.models.length > 0;
    },
    models: async (ctx) => ids((await listOllamaModels(ctx)).map((m) => m.name)),
    run: (input, ctx) => chat(input, ctx),
  }),
];
