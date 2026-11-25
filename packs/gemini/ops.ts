// packs/gemini/ops.ts
// The real work behind the tools and the capability functions.
// Model ids and prices come from the Gemini docs as verified on 2026-11-24
// (see the research notes); they are defaults, every tool accepts any model id.
import type { ArtifactKind, PackContext } from "plughive/pack";
import {
  GeminiClient,
  type Interaction,
  type Json,
  outputParts,
  outputText,
  tokenCounts,
} from "./client.js";
import {
  GeminiError,
  type MediaResult,
  b64decode,
  b64encode,
  isRiff,
  loadArtifact,
  pcmToWav,
  round6,
  sleep,
  throwIfAborted,
} from "./util.js";

export const MODELS = {
  image: [
    "gemini-nano-banana-2.1",
    "gemini-3.1-flash-lite-image",
    "gemini-3.1-flash-image",
    "gemini-3-pro-image",
    "gemini-2.5-flash-image",
  ],
  video: ["gemini-omni-1.2-flash"],
  speech: [
    "gemini-3.8-flash-tts",
    "gemini-3.8-flash-lite-tts",
    "gemini-3.1-flash-tts-preview",
    "gemini-2.5-pro-preview-tts",
    "gemini-2.5-flash-preview-tts",
  ],
  music: ["lyria-3.5", "lyria-3-clip-preview", "lyria-3-pro-preview"],
  transcribe: ["gemini-3.5-transcribe"],
  chat: [
    "gemini-4-hydrogen",
    "gemini-4-carbon",
    "gemini-4-neon",
    "gemini-4-argon",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
  ],
} as const;

export const DEFAULTS = {
  image: "gemini-nano-banana-2.1",
  video: "gemini-omni-1.2-flash",
  speech: "gemini-3.8-flash-tts",
  music: "lyria-3.5",
  musicClip: "lyria-3-clip-preview",
  transcribe: "gemini-3.5-transcribe",
  chat: "gemini-4-hydrogen",
} as const;

// USD per 1M tokens / per item, from the pricing docs.
const IMAGE_OUT_PER_M = 30;
const IMAGE_IN_PER_M = 1.5;
const IMAGE_FLAT: Record<string, number> = { "1K": 0.0336, "2K": 0.0504, "4K": 0.113 };
const VIDEO_OUT_PER_M = 12;
const VIDEO_PER_SECOND: Record<string, number> = {
  "360p": 0.023,
  "720p": 0.07,
  "1080p": 0.104,
  "4k": 0.209,
};
const MUSIC_FLAT: Record<string, number> = { "lyria-3.5": 0.08, "lyria-3-clip-preview": 0.04 };

const report = (ctx: PackContext, f: number, m?: string) => ctx.progress?.(f, m);

// --- estimates (spend policy) ------------------------------------------------
// Before a call runs, from the same tables: an image at its flat per-size price,
// a video at its per-second price, music at its flat price. Speech,
// transcription and chat are priced by tokens the call has not produced yet,
// so they have no estimate (a max_cost_usd skips them).

export interface Estimate {
  usd: number;
  basis: string;
}
const STATIC = "static table (Gemini pricing docs, 2026-11-24)";

export function estimateImage(input: { image_size?: string; n?: number }): Estimate {
  const each = IMAGE_FLAT[input.image_size ?? "1K"] ?? IMAGE_FLAT["4K"] ?? 0;
  return { usd: round6(each * (input.n ?? 1)), basis: STATIC };
}

export function estimateVideo(input: { resolution?: string; duration_seconds?: number }): Estimate {
  const perSecond = VIDEO_PER_SECOND[input.resolution ?? "720p"] ?? VIDEO_PER_SECOND["4k"] ?? 0;
  return { usd: round6(perSecond * (input.duration_seconds ?? 10)), basis: STATIC };
}

export function estimateMusic(input: {
  model?: string;
  duration_seconds?: number;
}): Estimate | null {
  const model =
    input.model ??
    (input.duration_seconds && input.duration_seconds <= 30 ? DEFAULTS.musicClip : DEFAULTS.music);
  const flat = MUSIC_FLAT[model];
  return flat === undefined ? null : { usd: flat, basis: STATIC };
}

async function save(
  ctx: PackContext,
  kind: ArtifactKind,
  mime: string,
  bytes: Uint8Array,
  tool: string,
  model: string,
  prompt: string | null,
  costUsd: number | null,
  meta: Record<string, unknown>,
) {
  const ref = await ctx.library.save({ kind, mime, bytes, tool, model, prompt, costUsd, meta });
  return { id: ref.id, url: ref.url, mime: ref.mime };
}

const stripMime = (m: string | undefined, fallback: string) =>
  (m ?? fallback).split(";")[0]?.trim() || fallback;

// --- image ------------------------------------------------------------------

export interface ImageInput {
  prompt: string;
  model?: string;
  aspect_ratio?: string;
  image_size?: "1K" | "2K" | "4K";
  mime_type?: "image/jpeg" | "image/png";
  n?: number;
  image_inputs?: string[];
  /** Accepted for the common capability shape; the Interactions API has no seed. */
  seed?: number;
}

export async function generateImage(
  input: ImageInput,
  ctx: PackContext,
  tool = "gemini_generate_image",
): Promise<MediaResult> {
  const client = new GeminiClient(ctx);
  const model = input.model ?? DEFAULTS.image;
  const size = input.image_size ?? "1K";
  const n = input.n ?? 1;
  const parts: Json[] = [{ type: "text", text: input.prompt }];
  for (const id of input.image_inputs ?? []) {
    const a = await loadArtifact(ctx, id, "image", 7 * 1024 * 1024);
    parts.push({ type: "image", mime_type: a.mime, data: b64encode(a.bytes) });
  }
  const format: Json = {
    type: "image",
    image_size: size,
    mime_type: input.mime_type ?? "image/jpeg",
  };
  if (input.aspect_ratio) format.aspect_ratio = input.aspect_ratio;
  const body: Json = { model, input: parts, response_format: format };

  const artifacts = [];
  let cost = 0;
  let costKnown = false;
  let failure: string | null = null;
  for (let i = 0; i < n; i++) {
    try {
      throwIfAborted(ctx.signal);
      report(ctx, i / n, `Generating image ${i + 1} of ${n}`);
      const it = await client.interact(body);
      const img = outputParts(it).find((p) => p.type === "image" && p.data);
      if (!img?.data) {
        const note = outputText(it).slice(0, 200);
        throw new GeminiError(
          `Gemini returned no image${note ? ` (it said: ${note})` : ""}. The prompt may have been blocked; rephrase it.`,
        );
      }
      const mime = stripMime(img.mime_type, input.mime_type ?? "image/jpeg");
      const { input: tin, output: tout } = tokenCounts(it);
      const c =
        tout > 0 ? (tout * IMAGE_OUT_PER_M + tin * IMAGE_IN_PER_M) / 1e6 : (IMAGE_FLAT[size] ?? 0);
      if (c > 0) costKnown = true;
      cost += c;
      artifacts.push(
        await save(ctx, "image", mime, b64decode(img.data), tool, model, input.prompt, null, {
          aspect_ratio: input.aspect_ratio ?? null,
          image_size: size,
          ...(c > 0 ? { cost_usd_estimate: round6(c) } : {}),
        }),
      );
    } catch (e) {
      // Images already made were paid for: keep them rather than lose them.
      if (artifacts.length === 0) throw e;
      failure = e instanceof Error ? e.message : String(e);
      break;
    }
  }
  report(ctx, 1, "Done");
  return {
    artifacts,
    model,
    provider: "gemini",
    ...(costKnown ? { cost_usd_estimate: round6(cost) } : {}),
    ...(failure
      ? {
          note: `Only ${artifacts.length} of ${n} images were made; image ${artifacts.length + 1} failed: ${failure}`,
        }
      : {}),
  };
}

// --- video ------------------------------------------------------------------

export interface VideoInput {
  prompt: string;
  model?: string;
  aspect_ratio?: "16:9" | "9:16";
  duration_seconds?: number;
  resolution?: "360p" | "720p" | "1080p" | "4k";
  image_input?: string;
  end_image_input?: string;
}

export async function generateVideo(
  input: VideoInput,
  ctx: PackContext,
  tool = "gemini_generate_video",
  opts: { pollMs?: number } = {},
): Promise<MediaResult> {
  const client = new GeminiClient(ctx);
  const model = input.model ?? DEFAULTS.video;
  const resolution = input.resolution ?? "720p";
  const seconds = input.duration_seconds ?? 10;
  if (input.end_image_input && !input.image_input) {
    throw new GeminiError("end_image_input needs image_input (the first frame).");
  }
  const parts: Json[] = [];
  for (const id of [input.image_input, input.end_image_input]) {
    if (!id) continue;
    const a = await loadArtifact(ctx, id, "image", 7 * 1024 * 1024);
    parts.push({ type: "image", mime_type: a.mime, data: b64encode(a.bytes) });
  }
  parts.push({ type: "text", text: input.prompt });
  const body: Json = {
    model,
    input: parts.length === 1 ? input.prompt : parts,
    response_format: {
      type: "video",
      aspect_ratio: input.aspect_ratio ?? "16:9",
      resolution,
      duration: `${seconds}s`,
      delivery: "uri",
    },
  };
  if (input.image_input) body.generation_config = { video_config: { task: "image_to_video" } };

  report(ctx, 0.05, "Submitting video job");
  const pollMs = opts.pollMs ?? 5000;
  const it = await client.interact(body, {
    background: true,
    pollMs,
    maxWaitMs: 12 * 60_000,
    onProgress: (f, m) => report(ctx, f, m),
  });
  const tokens = tokenCounts(it).output;
  const cost =
    tokens > 0
      ? (tokens * VIDEO_OUT_PER_M) / 1e6
      : seconds * (VIDEO_PER_SECOND[resolution] ?? 0.07);
  const art = await saveVideo(client, it, ctx, tool, model, input.prompt, pollMs, {
    resolution,
    duration_seconds: seconds,
    aspect_ratio: input.aspect_ratio ?? "16:9",
    cost_usd_estimate: round6(cost),
  });
  report(ctx, 1, "Done");
  return {
    artifacts: [art],
    model,
    provider: "gemini",
    interaction_id: it.id ?? null,
    cost_usd_estimate: round6(cost),
  };
}

const hasVideo = (it: Interaction) =>
  outputParts(it).some((p) => p.type === "video" || p.mime_type?.startsWith("video/"));

/** Fetch the video of a finished interaction and save it. Errors name the interaction. */
async function saveVideo(
  client: GeminiClient,
  it: Interaction,
  ctx: PackContext,
  tool: string,
  model: string,
  prompt: string | null,
  pollMs: number,
  meta: Record<string, unknown>,
) {
  const ref = it.id ? ` (interaction ${it.id})` : "";
  const vid = outputParts(it).find((p) => p.type === "video" || p.mime_type?.startsWith("video/"));
  if (!vid)
    throw new GeminiError(
      `Gemini returned no video${ref}. The prompt may have been blocked; rephrase it.`,
      undefined,
      it.id,
    );
  let bytes: Uint8Array;
  const mime = stripMime(vid.mime_type, "video/mp4");
  if (vid.data) {
    bytes = b64decode(vid.data);
  } else if (vid.uri) {
    const fileId = vid.uri.match(/\/files\/([A-Za-z0-9_-]+)/)?.[1];
    if (!fileId) throw new GeminiError(`Gemini returned a video link this pack cannot read${ref}.`);
    report(ctx, 0.92, "Waiting for the video file");
    for (let i = 0; ; i++) {
      const f = await client.json("GET", `/v1beta/files/${fileId}`);
      if (f.state === "ACTIVE") break;
      if (f.state === "FAILED")
        throw new GeminiError(`Gemini could not prepare the video file${ref}. Retry the request.`);
      if (i > 60)
        throw new GeminiError(
          `The video file did not become ready in time${ref}. Collect it later with gemini_get_interaction.`,
          undefined,
          it.id,
        );
      await sleep(pollMs, ctx.signal);
    }
    report(ctx, 0.95, "Downloading video");
    bytes = (await client.bytes(`/v1beta/files/${fileId}:download?alt=media`)).bytes;
  } else {
    throw new GeminiError(`Gemini returned a video with no data${ref}. Retry the request.`);
  }
  return save(ctx, "video", mime, bytes, tool, model, prompt, null, {
    ...meta,
    interaction_id: it.id ?? null,
  });
}

// --- speech -----------------------------------------------------------------

export interface SpeechInput {
  text: string;
  voice?: string;
  model?: string;
  format?: "wav";
  sample_rate?: 24000 | 16000 | 8000;
  style?: string;
  speakers?: { speaker: string; voice: string }[];
}

function sampleRateOf(mime: string | undefined, fallback: number): number {
  const m = (mime ?? "").match(/rate=(\d+)/);
  return m?.[1] ? Number(m[1]) : fallback;
}

export async function generateSpeech(
  input: SpeechInput,
  ctx: PackContext,
  tool = "gemini_generate_speech",
): Promise<MediaResult> {
  const client = new GeminiClient(ctx);
  const model = input.model ?? DEFAULTS.speech;
  const rate = input.sample_rate ?? 24000;
  const annotations: Json[] = [];
  if (input.style) annotations.push({ type: "speech_metadata", style: input.style });
  const body: Json = {
    model,
    input: [
      {
        type: "user_input",
        content: [
          { type: "text", text: input.text, ...(annotations.length ? { annotations } : {}) },
        ],
      },
    ],
    response_format: { type: "audio", mime_type: "audio/wav", sample_rate: rate },
    generation_config: {
      speech_config: input.speakers?.length
        ? { speakers: input.speakers }
        : [{ voice: input.voice ?? "Kore" }],
    },
  };
  const it = await client.interact(body);
  const audio = outputParts(it)
    .filter((p) => p.type === "audio" && p.data)
    .at(-1);
  if (!audio?.data)
    throw new GeminiError("Gemini returned no audio. Shorten the text or try another model.");
  let bytes = b64decode(audio.data);
  const mime = stripMime(audio.mime_type, "audio/wav");
  // Raw output arrives as headerless 16-bit PCM; wrap it so players can open it.
  if (!isRiff(bytes) && (mime.includes("l16") || mime.includes("pcm") || mime === "audio/wav")) {
    bytes = pcmToWav(bytes, sampleRateOf(audio.mime_type, rate));
  }
  const art = await save(
    ctx,
    "audio",
    "audio/wav",
    bytes,
    tool,
    model,
    input.text.slice(0, 500),
    null,
    {
      voice: input.voice ?? null,
      sample_rate: rate,
    },
  );
  return { artifacts: [art], model, provider: "gemini" };
}

// --- music ------------------------------------------------------------------

export interface MusicInput {
  prompt: string;
  model?: string;
  duration_seconds?: number;
  format?: "mp3" | "wav";
}

export async function generateMusic(
  input: MusicInput,
  ctx: PackContext,
  tool = "gemini_generate_music",
  opts: { pollMs?: number } = {},
): Promise<MediaResult & { lyrics?: string }> {
  const client = new GeminiClient(ctx);
  // The API has no length parameter: the model decides (clip ~30 s, song ~2 min).
  // A short request therefore picks the clip model unless the caller chose one.
  const model =
    input.model ??
    (input.duration_seconds && input.duration_seconds <= 30 ? DEFAULTS.musicClip : DEFAULTS.music);
  const prompt = input.duration_seconds
    ? `${input.prompt}\n\nTarget length: about ${input.duration_seconds} seconds.`
    : input.prompt;
  const body: Json = { model, input: prompt };
  if (input.format === "wav") body.response_format = { type: "audio", mime_type: "audio/wav" };
  report(ctx, 0.05, "Submitting music job");
  const it = await client.interact(body, {
    background: true,
    pollMs: opts.pollMs ?? 4000,
    maxWaitMs: 8 * 60_000,
    onProgress: (f, m) => report(ctx, f, m),
  });
  const flat = MUSIC_FLAT[model];
  const { art, lyrics } = await saveMusic(it, ctx, tool, model, input.prompt, input.format, {
    duration_hint_seconds: input.duration_seconds ?? null,
    ...(flat !== undefined ? { cost_usd_estimate: flat } : {}),
  });
  report(ctx, 1, "Done");
  return {
    artifacts: [art],
    model,
    provider: "gemini",
    interaction_id: it.id ?? null,
    ...(flat !== undefined ? { cost_usd_estimate: flat } : {}),
    ...(lyrics ? { lyrics } : {}),
  };
}

const hasAudio = (it: Interaction) => outputParts(it).some((p) => p.type === "audio" && p.data);

async function saveMusic(
  it: Interaction,
  ctx: PackContext,
  tool: string,
  model: string,
  prompt: string | null,
  format: "mp3" | "wav" | undefined,
  meta: Record<string, unknown>,
) {
  const audio = outputParts(it).find((p) => p.type === "audio" && p.data);
  if (!audio?.data)
    throw new GeminiError(
      `Gemini returned no audio${it.id ? ` (interaction ${it.id})` : ""}. Rephrase the prompt or try another model.`,
      undefined,
      it.id,
    );
  const mime = stripMime(audio.mime_type, format === "wav" ? "audio/wav" : "audio/mpeg");
  const lyrics = outputText(it).trim().slice(0, 8000);
  const art = await save(ctx, "audio", mime, b64decode(audio.data), tool, model, prompt, null, {
    ...meta,
    interaction_id: it.id ?? null,
  });
  return { art, lyrics };
}

// --- collect a background job ---------------------------------------------------

export interface CollectInput {
  interaction_id: string;
}

export type CollectResult =
  | (MediaResult & { status: "completed"; lyrics?: string })
  | { status: string; interaction_id: string; message: string };

/**
 * Read a video or music interaction that was submitted earlier (for example
 * one that outlived the wait limit) and save its output. Never resubmits, so
 * it never pays for the job again.
 */
export async function collectInteraction(
  input: CollectInput,
  ctx: PackContext,
  tool = "gemini_get_interaction",
): Promise<CollectResult> {
  const client = new GeminiClient(ctx);
  const id = input.interaction_id;
  const it = await client.get(id);
  if (it.status === "in_progress" || it.status === "requires_continuation") {
    return {
      status: it.status,
      interaction_id: id,
      message: "Gemini is still working on it. Call this tool again in a minute.",
    };
  }
  if (it.status !== "completed") {
    return {
      status: it.status ?? "unknown",
      interaction_id: id,
      message: `The interaction ended with status "${it.status ?? "unknown"}"; there is nothing to collect.`,
    };
  }
  const model = it.model ?? "unknown";
  if (hasVideo(it)) {
    const art = await saveVideo(client, it, ctx, tool, model, null, 5000, { collected: true });
    return { status: "completed", artifacts: [art], model, provider: "gemini", interaction_id: id };
  }
  if (hasAudio(it)) {
    const { art, lyrics } = await saveMusic(it, ctx, tool, model, null, undefined, {
      collected: true,
    });
    return {
      status: "completed",
      artifacts: [art],
      model,
      provider: "gemini",
      interaction_id: id,
      ...(lyrics ? { lyrics } : {}),
    };
  }
  throw new GeminiError(
    `Interaction ${id} finished but holds no video or audio output to collect.`,
    undefined,
    id,
  );
}

// --- transcription ------------------------------------------------------------

export interface TranscribeInput {
  artifact_id: string;
  language?: string;
  model?: string;
  speakers?: boolean;
  timestamps?: boolean;
}

export interface Segment {
  start?: string;
  speaker?: string;
  text: string;
}

export interface TranscribeResult {
  text: string;
  segments?: Segment[];
  model: string;
  provider: "gemini";
  usage: { input_tokens: number; output_tokens: number };
}

const TRANSCRIPT_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string" },
    segments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          speaker: { type: "string" },
          timestamp: { type: "string" },
          content: { type: "string" },
        },
        required: ["content"],
      },
    },
  },
  required: ["text"],
};

// Body shape checked against the Gemini audio docs (aistudio.google.com/docs/audio, 2026-11-24): an
// `input` array of {type:"text"} and {type:"audio", data, mime_type}, plus a JSON `response_format`
// with segments {speaker, timestamp, content}. Not exercised against the live API (no keyed calls);
// listed under "Needs live verification" in the skill.
export async function transcribe(
  input: TranscribeInput,
  ctx: PackContext,
): Promise<TranscribeResult> {
  const client = new GeminiClient(ctx);
  const model = input.model ?? DEFAULTS.transcribe;
  const cap = 15 * 1024 * 1024;
  const media = await loadArtifact(ctx, input.artifact_id, "audio", cap).catch(async (e) => {
    // Video files carry audio too.
    if (e instanceof GeminiError && /needs audio/.test(e.message)) {
      return loadArtifact(ctx, input.artifact_id, "video", cap);
    }
    throw e;
  });
  const wantSegments = Boolean(input.speakers || input.timestamps);
  const ask = [
    "Transcribe the speech verbatim.",
    input.language ? `The language is ${input.language}.` : "Detect the language.",
    input.speakers ? "Label speakers." : "",
    input.timestamps ? "Give an MM:SS timestamp per segment." : "",
    "Return the full transcript in `text`.",
  ]
    .filter(Boolean)
    .join(" ");
  const body: Json = {
    model,
    input: [
      { type: "text", text: ask },
      {
        type: media.mime.startsWith("video/") ? "video" : "audio",
        mime_type: media.mime,
        data: b64encode(media.bytes),
      },
    ],
  };
  if (wantSegments) {
    body.response_format = {
      type: "text",
      mime_type: "application/json",
      schema: TRANSCRIPT_SCHEMA,
    };
  }
  report(ctx, 0.1, "Transcribing");
  const it = await client.interact(body, {
    background: true,
    pollMs: 3000,
    onProgress: (f, m) => report(ctx, f, m),
  });
  const raw = outputText(it).trim();
  const usage = tokenCounts(it);
  const out: TranscribeResult = {
    text: raw,
    model,
    provider: "gemini",
    usage: { input_tokens: usage.input, output_tokens: usage.output },
  };
  if (wantSegments) {
    try {
      const j = JSON.parse(raw) as {
        text?: string;
        segments?: { speaker?: string; timestamp?: string; content?: string }[];
      };
      out.text = j.text ?? (j.segments ?? []).map((s) => s.content ?? "").join(" ");
      out.segments = (j.segments ?? [])
        .filter((s) => typeof s.content === "string")
        .map((s) => ({
          ...(s.timestamp ? { start: s.timestamp } : {}),
          ...(s.speaker ? { speaker: s.speaker } : {}),
          text: s.content as string,
        }));
    } catch {
      // The model ignored the schema: keep the plain text.
    }
  }
  report(ctx, 1, "Done");
  return out;
}

// --- chat -------------------------------------------------------------------

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatInput {
  messages: ChatMessage[];
  model?: string;
  max_tokens?: number;
  temperature?: number;
  json?: boolean;
}

export interface ChatResult {
  text: string;
  usage: { input_tokens: number; output_tokens: number };
  model: string;
  provider: "gemini";
  cost_usd?: number;
}

export async function chat(input: ChatInput, ctx: PackContext): Promise<ChatResult> {
  const client = new GeminiClient(ctx);
  const model = input.model ?? DEFAULTS.chat;
  const system = input.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const turns = input.messages.filter((m) => m.role !== "system");
  const last = turns[turns.length - 1];
  if (!last) throw new GeminiError("Send at least one user message.");
  if (last.role !== "user") throw new GeminiError("The last message must have role user.");
  const body: Json = {
    model,
    input:
      turns.length === 1
        ? last.content
        : turns.map((m) => ({
            type: m.role === "user" ? "user_input" : "model_output",
            content: [{ type: "text", text: m.content }],
          })),
  };
  // system_instruction / generation_config shapes are not confirmed by the API reference;
  // listed under "Needs live verification" in the skill.
  if (system) body.system_instruction = system;
  const gc: Json = {};
  if (input.temperature !== undefined) gc.temperature = input.temperature;
  if (input.max_tokens !== undefined) gc.max_output_tokens = input.max_tokens;
  if (Object.keys(gc).length) body.generation_config = gc;
  if (input.json) body.response_format = { type: "text", mime_type: "application/json" };
  const it: Interaction = await client.interact(body);
  const usage = tokenCounts(it);
  // No verified per-model text pricing is bundled, so cost_usd is omitted.
  return {
    text: outputText(it),
    usage: { input_tokens: usage.input, output_tokens: usage.output },
    model: it.model ?? model,
    provider: "gemini",
  };
}

// --- discovery ----------------------------------------------------------------

export interface LiveModel {
  id: string;
  name: string;
  description: string;
  input_token_limit: number | null;
  output_token_limit: number | null;
  methods: string[];
}

let cache: { at: number; models: LiveModel[] } | null = null;
const CACHE_MS = 10 * 60_000;
export function clearModelCache(): void {
  cache = null;
}

export async function listModels(
  ctx: PackContext,
  refresh = false,
): Promise<{ models: LiveModel[]; cached: boolean }> {
  if (!refresh && cache && Date.now() - cache.at < CACHE_MS)
    return { models: cache.models, cached: true };
  const client = new GeminiClient(ctx);
  const models: LiveModel[] = [];
  let token: string | undefined;
  for (let page = 0; page < 10; page++) {
    const q = new URLSearchParams({ pageSize: "200" });
    if (token) q.set("pageToken", token);
    const j = await client.json("GET", `/v1beta/models?${q.toString()}`);
    for (const m of Array.isArray(j.models) ? j.models : []) {
      models.push({
        id: String(m.baseModelId ?? String(m.name ?? "").replace(/^models\//, "")),
        name: String(m.displayName ?? ""),
        description: String(m.description ?? "").slice(0, 160),
        input_token_limit: typeof m.inputTokenLimit === "number" ? m.inputTokenLimit : null,
        output_token_limit: typeof m.outputTokenLimit === "number" ? m.outputTokenLimit : null,
        methods: Array.isArray(m.supportedGenerationMethods) ? m.supportedGenerationMethods : [],
      });
    }
    token = typeof j.nextPageToken === "string" && j.nextPageToken ? j.nextPageToken : undefined;
    if (!token) break;
  }
  cache = { at: Date.now(), models };
  return { models, cached: false };
}
