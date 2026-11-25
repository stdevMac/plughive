// packs/fal/capabilities.ts
//
// Normalised capability functions over fal models. Each maps the shared input
// shape onto whatever fields the chosen model's schema has, then runs it
// through the queue runner (which validates against the real schema).
import {
  type AnyProviderDefinition,
  CapabilityError,
  type PackContext,
  defineProvider,
} from "plughive/pack";
import { PROVIDER, checkFalId } from "./client.js";
import {
  type ArtifactOut,
  type Json,
  ProviderError,
  type RunResult,
  artifactToUrl,
  checkArtifactId,
  resolvedProps,
} from "./common.js";
import { type Estimate, type Quantity, estimateFor } from "./estimate.js";
import { MAX_INLINE_BYTES, SECRET, runtimeOf, seeds } from "./runtime.js";

export const CAPABILITY_DEFAULTS = {
  image: "fal-ai/nano-banana-pro",
  image_edit: "fal-ai/nano-banana-pro/edit",
  video: "fal-ai/kling-video/v3/pro/text-to-video",
  video_from_image: "fal-ai/kling-video/v3/pro/image-to-video",
  speech: "fal-ai/minimax/speech-2.8-hd",
  music: "fal-ai/elevenlabs/music",
  transcribe: "fal-ai/wizper",
  image_upscale: "fal-ai/seedvr/upscale/image",
  remove_background: "fal-ai/bria/background/remove",
  lipsync: "fal-ai/sync-lipsync/v2",
  video_upscale: "fal-ai/seedvr/upscale/video",
  stems: "fal-ai/demucs",
  three_d: "fal-ai/hunyuan-3d/v3.1/pro/text-to-3d",
  three_d_from_image: "fal-ai/hunyuan-3d/v3.1/pro/image-to-3d",
  sound_effect: "fal-ai/elevenlabs/sound-effects/v2",
} as const;

/**
 * Verified fal model ids for each editing task (checked against fal's model
 * catalog, https://fal.ai/models). The first of each list is seeded.
 */
export const TASK_MODELS = {
  image_upscale: [CAPABILITY_DEFAULTS.image_upscale, "fal-ai/esrgan"],
  remove_background: [CAPABILITY_DEFAULTS.remove_background, "fal-ai/birefnet/v2"],
  lipsync: [CAPABILITY_DEFAULTS.lipsync],
  video_upscale: [CAPABILITY_DEFAULTS.video_upscale, "topaz/upscale/video/precision"],
  stems: [CAPABILITY_DEFAULTS.stems],
  three_d: [
    CAPABILITY_DEFAULTS.three_d,
    CAPABILITY_DEFAULTS.three_d_from_image,
    "tripo3d/h3.1/text-to-3d",
    "tripo3d/h3.1/image-to-3d",
  ],
  sound_effect: [
    CAPABILITY_DEFAULTS.sound_effect,
    "elevenlabs/sound-effects/v3",
    "fal-ai/stable-audio-3/small/sfx/text-to-audio",
  ],
} as const;

/** Seeded task models that must not show up as generators (upscalers are "image-to-image" too). */
const NOT_GENERATORS = new Set<string>(Object.values(TASK_MODELS).flat());

export interface MediaResult {
  artifacts: ArtifactOut[];
  model: string;
  provider: string;
  cost_usd?: number;
}

export interface ImageGenerateInput {
  prompt: string;
  model?: string;
  aspect_ratio?: string;
  n?: number;
  image_inputs?: string[];
  seed?: number;
}

export interface VideoGenerateInput {
  prompt: string;
  model?: string;
  aspect_ratio?: string;
  duration_seconds?: number;
  image_input?: string;
  resolution?: string;
  end_image_input?: string;
}

export interface SpeechGenerateInput {
  text: string;
  voice?: string;
  model?: string;
  format?: string;
  language?: string;
}

export interface MusicGenerateInput {
  prompt: string;
  duration_seconds?: number;
  model?: string;
  instrumental?: boolean;
  format?: string;
}

export interface TranscribeInput {
  artifact_id: string;
  language?: string;
  model?: string;
  timestamps?: boolean;
  speakers?: boolean;
}

interface Segment {
  start?: number;
  end?: number;
  text: string;
}

type Props = Record<string, Json>;

/**
 * An input this pack cannot honour for the chosen model. Thrown before any
 * request; the capability providers turn it into a retryable CapabilityError
 * so the router falls back to the next provider.
 */
export class UnsupportedInput extends ProviderError {
  constructor(message: string) {
    super(PROVIDER, message);
    this.name = "UnsupportedInput";
  }
}

async function propsOf(ctx: PackContext, model: string): Promise<Props> {
  const spec = await runtimeOf(ctx).spec(ctx, checkFalId(model), { preferSeed: true });
  if (!spec) throw new UnsupportedInput(`fal has no model "${model}".`);
  return resolvedProps(spec.input);
}

function enumOf(p: Json): Json[] | null {
  if (Array.isArray(p?.enum)) return p.enum;
  const one = Array.isArray(p?.allOf) && p.allOf.length === 1 ? p.allOf[0] : null;
  if (Array.isArray(one?.enum)) return one.enum;
  const alt = p?.anyOf ?? p?.oneOf;
  if (Array.isArray(alt)) for (const a of alt) if (Array.isArray(a?.enum)) return a.enum;
  return null;
}

/** Closest allowed value for a number, keeping the enum's type (fal often uses "5" strings). */
function nearest(allowed: Json[], want: number): Json {
  let best = allowed[0];
  let dist = Number.POSITIVE_INFINITY;
  for (const v of allowed) {
    const n = Number.parseFloat(String(v));
    if (Number.isFinite(n) && Math.abs(n - want) < dist) {
      dist = Math.abs(n - want);
      best = v;
    }
  }
  return best;
}

const IMAGE_SIZE: Record<string, string> = {
  "1:1": "square_hd",
  "4:3": "landscape_4_3",
  "16:9": "landscape_16_9",
  "3:4": "portrait_4_3",
  "9:16": "portrait_16_9",
};

function setAspect(props: Props, out: Json, aspect: string | undefined): void {
  if (!aspect) return;
  if ("aspect_ratio" in props) {
    const allowed = enumOf(props.aspect_ratio);
    if (allowed && !allowed.includes(aspect)) {
      throw new UnsupportedInput(
        `aspect_ratio ${aspect} is not supported; use one of ${allowed.join(", ")}`,
      );
    }
    out.aspect_ratio = aspect;
  } else if ("image_size" in props && IMAGE_SIZE[aspect]) {
    out.image_size = IMAGE_SIZE[aspect];
  }
}

async function fileUrl(ctx: PackContext, id: string): Promise<string> {
  return artifactToUrl(ctx, checkArtifactId(id), { maxInlineBytes: MAX_INLINE_BYTES });
}

function media(r: {
  artifacts: ArtifactOut[];
  model: string;
  provider: string;
  cost_usd?: number;
}): MediaResult {
  return {
    artifacts: r.artifacts,
    model: r.model,
    provider: r.provider,
    ...(typeof r.cost_usd === "number" ? { cost_usd: r.cost_usd } : {}),
  };
}

export async function imageGenerate(
  input: ImageGenerateInput,
  ctx: PackContext,
): Promise<MediaResult> {
  const refs = input.image_inputs ?? [];
  const model =
    input.model ?? (refs.length > 0 ? CAPABILITY_DEFAULTS.image_edit : CAPABILITY_DEFAULTS.image);
  const props = await propsOf(ctx, model);
  const body: Json = { prompt: input.prompt };
  setAspect(props, body, input.aspect_ratio);
  if (input.n !== undefined) {
    if ("num_images" in props) body.num_images = input.n;
    else if (input.n > 1)
      throw new UnsupportedInput(
        `${model} makes one image per call; n=${input.n} is not supported.`,
      );
  }
  if (input.seed !== undefined && "seed" in props) body.seed = input.seed;
  if (refs.length > 0) {
    const urls = await Promise.all(refs.map((id) => fileUrl(ctx, id)));
    if ("image_urls" in props) body.image_urls = urls;
    else if ("image_url" in props) body.image_url = urls[0];
    else
      throw new UnsupportedInput(
        `${model} does not take input images; pick an image-to-image model.`,
      );
  }
  return media(await runtimeOf(ctx).run(ctx, model, body, { prompt: input.prompt }));
}

export async function videoGenerate(
  input: VideoGenerateInput,
  ctx: PackContext,
): Promise<MediaResult> {
  const model =
    input.model ??
    (input.image_input ? CAPABILITY_DEFAULTS.video_from_image : CAPABILITY_DEFAULTS.video);
  const props = await propsOf(ctx, model);
  const body: Json = { prompt: input.prompt };
  setAspect(props, body, input.aspect_ratio);
  if (input.duration_seconds !== undefined && "duration" in props) {
    const allowed = enumOf(props.duration);
    body.duration = allowed ? nearest(allowed, input.duration_seconds) : input.duration_seconds;
  }
  if (input.resolution && "resolution" in props) body.resolution = input.resolution;
  if (input.image_input) {
    const url = await fileUrl(ctx, input.image_input);
    const field = ["start_image_url", "image_url", "first_frame_url"].find((f) => f in props);
    if (!field)
      throw new UnsupportedInput(
        `${model} does not take a start image; pick an image-to-video model.`,
      );
    body[field] = url;
  }
  if (input.end_image_input) {
    const field = ["end_image_url", "tail_image_url", "last_frame_url", "last_image_url"].find(
      (f) => f in props,
    );
    if (!field)
      throw new UnsupportedInput(
        `${model} does not take an end image; pick a model with first and last frames.`,
      );
    body[field] = await fileUrl(ctx, input.end_image_input);
  }
  return media(await runtimeOf(ctx).run(ctx, model, body, { prompt: input.prompt }));
}

/**
 * Put an audio container ("mp3", "wav", ...) where the model takes one. Some
 * models use `output_format` for something else (minimax: "url" or "hex"), so
 * a field is only used when its enum lists the value.
 */
function setAudioFormat(model: string, props: Props, body: Json, format: string): void {
  const setting = props.audio_setting;
  const settingProps = setting?.properties ?? {};
  const settingFormats = enumOf(settingProps.format);
  if (settingFormats?.includes(format)) {
    const base = setting?.default;
    body.audio_setting = {
      ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}),
      format,
    };
    return;
  }
  const outFormats = enumOf(props.output_format);
  if (outFormats?.includes(format) || ("output_format" in props && !outFormats)) {
    body.output_format = format;
    return;
  }
  const allowed = settingFormats ?? outFormats;
  throw new UnsupportedInput(
    allowed
      ? `${model} cannot produce ${format} audio; use one of ${allowed.join(", ")}.`
      : `${model} has no audio format option; leave format out.`,
  );
}

export async function speechGenerate(
  input: SpeechGenerateInput,
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.speech;
  const props = await propsOf(ctx, model);
  const body: Json = {};
  body["text" in props ? "text" : "prompt"] = input.text;
  if (input.voice) {
    if ("voice" in props) body.voice = input.voice;
    else if ("voice_setting" in props) {
      // Keep the model's other voice defaults (speed, volume, pitch); a bare
      // {voice_id} would reset them.
      const base = props.voice_setting?.default;
      body.voice_setting = {
        ...(base && typeof base === "object" && !Array.isArray(base) ? base : {}),
        voice_id: input.voice,
      };
    } else throw new UnsupportedInput(`${model} has no voice option; leave voice out.`);
  }
  if (input.language) {
    const field = ["language", "language_code"].find((f) => f in props);
    if (!field) throw new UnsupportedInput(`${model} has no language option; leave language out.`);
    const allowed = enumOf(props[field]!);
    if (allowed && !allowed.includes(input.language)) {
      throw new UnsupportedInput(
        `${model} does not support language ${input.language}; use one of ${allowed.join(", ")}.`,
      );
    }
    body[field] = input.language;
  }
  if (input.format) setAudioFormat(model, props, body, input.format);
  return media(await runtimeOf(ctx).run(ctx, model, body, { prompt: input.text }));
}

export async function musicGenerate(
  input: MusicGenerateInput,
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.music;
  const props = await propsOf(ctx, model);
  const body: Json = { prompt: input.prompt };
  if (input.instrumental) {
    if ("force_instrumental" in props) body.force_instrumental = true;
    else body.prompt = `${input.prompt}\n\nInstrumental only, no vocals.`;
  }
  if (input.format) {
    const allowed = enumOf(props.output_format ?? {});
    if (!allowed?.includes(input.format))
      throw new UnsupportedInput(`${model} cannot produce ${input.format} music.`);
    body.output_format = input.format;
  }
  if (input.duration_seconds !== undefined) {
    if ("music_length_ms" in props)
      body.music_length_ms = Math.round(input.duration_seconds * 1000);
    else if ("duration" in props) body.duration = input.duration_seconds;
    else if ("seconds_total" in props) body.seconds_total = input.duration_seconds;
  }
  return media(await runtimeOf(ctx).run(ctx, model, body, { prompt: input.prompt }));
}

export async function audioTranscribe(
  input: TranscribeInput,
  ctx: PackContext,
): Promise<{ text: string; segments?: Segment[]; model: string; provider: string }> {
  if (input.speakers)
    throw new UnsupportedInput("fal speech-to-text models do not label speakers.");
  const model = input.model ?? CAPABILITY_DEFAULTS.transcribe;
  const body: Json = { audio_url: await fileUrl(ctx, input.artifact_id) };
  if (input.language) body.language = input.language;
  const r = await runtimeOf(ctx).run(ctx, model, body);
  const out = r.output ?? {};
  const chunks: Json[] = Array.isArray(out.chunks) ? out.chunks : [];
  const segments = chunks.map((c): Segment => {
    const [start, end] = Array.isArray(c?.timestamp) ? c.timestamp : [];
    return {
      ...(typeof start === "number" ? { start } : {}),
      ...(typeof end === "number" ? { end } : {}),
      text: typeof c?.text === "string" ? c.text : "",
    };
  });
  return {
    text: typeof out.text === "string" ? out.text : "",
    ...(segments.length ? { segments } : {}),
    model,
    provider: PROVIDER,
  };
}

// ---------------------------------------------------------------------------
// Editing and other media tasks
// ---------------------------------------------------------------------------

export interface ImageEditInput {
  artifact_id: string;
  prompt: string;
  reference_ids?: string[] | undefined;
  mask_id?: string | undefined;
  model?: string | undefined;
  n?: number | undefined;
  seed?: number | undefined;
  aspect_ratio?: string | undefined;
}

export interface UpscaleInput {
  artifact_id: string;
  scale?: number | undefined;
  model?: string | undefined;
}

export interface RemoveBackgroundInput {
  artifact_id: string;
  model?: string | undefined;
}

export interface LipsyncInput {
  artifact_id: string;
  audio_id: string;
  model?: string | undefined;
}

export interface SeparateStemsInput {
  artifact_id: string;
  two_stems?: string | undefined;
  model?: string | undefined;
  format?: string | undefined;
}

export interface ThreeDInput {
  prompt?: string | undefined;
  artifact_id?: string | undefined;
  model?: string | undefined;
  format?: string | undefined;
}

export interface SoundEffectInput {
  prompt: string;
  duration_seconds?: number | undefined;
  model?: string | undefined;
  format?: string | undefined;
}

const STEMS = ["vocals", "drums", "bass", "other", "piano", "guitar"] as const;
const MESH_FORMATS = ["glb", "obj", "fbx", "usdz"];

/** The artifact a run put at `output[key]`, as the only result artifact. */
function only(r: RunResult, file: Json, what: string): MediaResult {
  const id = file?.artifact_id;
  const hit = typeof id === "string" ? r.artifacts.find((a) => a.id === id) : undefined;
  if (!hit) throw new ProviderError(PROVIDER, `${r.model} finished but returned no ${what}.`);
  return media({ ...r, artifacts: [hit] });
}

/** Set the upscale factor on whichever field the model has, inside its range. */
function setScale(model: string, props: Props, body: Json, scale: number): void {
  const field = ["upscale_factor", "scale"].find((f) => f in props);
  if (!field) throw new UnsupportedInput(`${model} has no upscale factor; pick another upscaler.`);
  const p = props[field];
  const allowed = enumOf(p);
  const tooBig = typeof p?.maximum === "number" && scale > p.maximum;
  const tooSmall = typeof p?.minimum === "number" && scale < p.minimum;
  if ((allowed && !allowed.includes(scale)) || tooBig || tooSmall) {
    throw new UnsupportedInput(`${model} cannot upscale ${scale}x.`);
  }
  body[field] = scale;
  if ("upscale_mode" in props) body.upscale_mode = "factor";
}

export async function imageEdit(input: ImageEditInput, ctx: PackContext): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.image_edit;
  const props = await propsOf(ctx, model);
  const ids = [input.artifact_id, ...(input.reference_ids ?? [])];
  if (!("image_urls" in props) && !("image_url" in props)) {
    throw new UnsupportedInput(
      `${model} does not take an input image; pick an image editing model.`,
    );
  }
  if (ids.length > 1 && !("image_urls" in props)) {
    throw new UnsupportedInput(`${model} takes one image; leave reference_ids out.`);
  }
  if (input.mask_id && !("mask_url" in props)) {
    throw new UnsupportedInput(`${model} does not take a mask; leave mask_id out.`);
  }
  const body: Json = { prompt: input.prompt };
  setAspect(props, body, input.aspect_ratio);
  if (input.n !== undefined) {
    if ("num_images" in props) body.num_images = input.n;
    else if (input.n > 1)
      throw new UnsupportedInput(
        `${model} makes one image per call; n=${input.n} is not supported.`,
      );
  }
  if (input.seed !== undefined && "seed" in props) body.seed = input.seed;
  const urls = await Promise.all(ids.map((id) => fileUrl(ctx, id)));
  if ("image_urls" in props) body.image_urls = urls;
  else body.image_url = urls[0];
  if (input.mask_id) body.mask_url = await fileUrl(ctx, input.mask_id);
  return media(await runtimeOf(ctx).run(ctx, model, body, { prompt: input.prompt }));
}

export async function imageUpscale(input: UpscaleInput, ctx: PackContext): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.image_upscale;
  const props = await propsOf(ctx, model);
  if (!("image_url" in props))
    throw new UnsupportedInput(`${model} does not take an image; pick an image upscaler.`);
  const body: Json = {};
  setScale(model, props, body, input.scale ?? 4);
  body.image_url = await fileUrl(ctx, input.artifact_id);
  const r = await runtimeOf(ctx).run(ctx, model, body);
  return only(r, r.output?.image, "image");
}

export async function imageRemoveBackground(
  input: RemoveBackgroundInput,
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.remove_background;
  const props = await propsOf(ctx, model);
  if (!("image_url" in props))
    throw new UnsupportedInput(`${model} does not take an image; pick a background remover.`);
  const r = await runtimeOf(ctx).run(ctx, model, {
    image_url: await fileUrl(ctx, input.artifact_id),
  });
  return only(r, r.output?.image, "image");
}

export async function videoUpscale(input: UpscaleInput, ctx: PackContext): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.video_upscale;
  const props = await propsOf(ctx, model);
  if (!("video_url" in props))
    throw new UnsupportedInput(`${model} does not take a video; pick a video upscaler.`);
  const body: Json = {};
  setScale(model, props, body, input.scale ?? 2);
  body.video_url = await fileUrl(ctx, input.artifact_id);
  const r = await runtimeOf(ctx).run(ctx, model, body);
  return only(r, r.output?.video, "video");
}

export async function videoLipsync(input: LipsyncInput, ctx: PackContext): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.lipsync;
  const props = await propsOf(ctx, model);
  if (!("video_url" in props) || !("audio_url" in props)) {
    throw new UnsupportedInput(
      `${model} does not take a video and an audio track; pick a lip-sync model.`,
    );
  }
  const video = await fileUrl(ctx, input.artifact_id);
  if (video.startsWith("data:image/")) {
    throw new UnsupportedInput(`${model} needs a video, not a still image.`);
  }
  const body: Json = { video_url: video, audio_url: await fileUrl(ctx, input.audio_id) };
  const r = await runtimeOf(ctx).run(ctx, model, body);
  return only(r, r.output?.video, "video");
}

export async function audioSeparateStems(
  input: SeparateStemsInput,
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.stems;
  if (input.two_stems) {
    throw new UnsupportedInput(
      `${model} returns each stem on its own, not "${input.two_stems}" plus the rest; leave two_stems out.`,
    );
  }
  const props = await propsOf(ctx, model);
  if (!("audio_url" in props))
    throw new UnsupportedInput(`${model} does not take audio; pick a stem separator.`);
  const body: Json = {};
  if (input.format) {
    const allowed = enumOf(props.output_format ?? {});
    if (!allowed?.includes(input.format))
      throw new UnsupportedInput(`${model} cannot produce ${input.format} stems.`);
    body.output_format = input.format;
  }
  body.audio_url = await fileUrl(ctx, input.artifact_id);
  const r = await runtimeOf(ctx).run(ctx, model, body);
  const stemOf = new Map<string, string>();
  for (const stem of STEMS) {
    const id = r.output?.[stem]?.artifact_id;
    if (typeof id === "string") stemOf.set(id, stem);
  }
  const artifacts = r.artifacts
    .filter((a) => stemOf.has(a.id))
    .map((a) => ({ ...a, stem: stemOf.get(a.id) as string }));
  if (artifacts.length === 0)
    throw new ProviderError(PROVIDER, `${model} finished but returned no stems.`);
  return media({ ...r, artifacts });
}

export async function threeDGenerate(input: ThreeDInput, ctx: PackContext): Promise<MediaResult> {
  if (!input.prompt && !input.artifact_id) {
    throw new CapabilityError("3d.generate needs a prompt, an image artifact_id, or both.", {
      retryable: true,
      code: "INVALID_INPUT",
    });
  }
  const model =
    input.model ??
    (input.artifact_id ? CAPABILITY_DEFAULTS.three_d_from_image : CAPABILITY_DEFAULTS.three_d);
  const spec = await runtimeOf(ctx).spec(ctx, checkFalId(model), { preferSeed: true });
  if (!spec) throw new UnsupportedInput(`fal has no model "${model}".`);
  const props = resolvedProps(spec.input);
  const imageField = ["input_image_url", "image_url"].find((f) => f in props);
  if (input.artifact_id && !imageField) {
    throw new UnsupportedInput(`${model} does not take an image; pick an image-to-3D model.`);
  }
  if (input.prompt && !("prompt" in props)) {
    throw new UnsupportedInput(
      `${model} builds from the image alone; leave prompt out or pick a text-to-3D model.`,
    );
  }
  if (!input.artifact_id && !("prompt" in props)) {
    throw new UnsupportedInput(
      `${model} needs an image; give artifact_id or pick a text-to-3D model.`,
    );
  }
  const format = input.format ?? "glb";
  const urls = resolvedProps(spec.output).model_urls?.properties ?? {};
  const formats = MESH_FORMATS.filter((f) => f in urls);
  if (formats.length > 0 && !formats.includes(format)) {
    throw new UnsupportedInput(
      `${model} cannot export ${format}; use one of ${formats.join(", ")}.`,
    );
  }
  if (formats.length === 0 && format !== "glb") {
    throw new UnsupportedInput(`${model} exports glb only.`);
  }
  const body: Json = {};
  if (input.prompt) body.prompt = input.prompt;
  if (input.artifact_id && imageField) body[imageField] = await fileUrl(ctx, input.artifact_id);
  const r = await runtimeOf(ctx).run(
    ctx,
    model,
    body,
    input.prompt ? { prompt: input.prompt } : {},
  );
  const out = r.output ?? {};
  const file =
    out.model_urls?.[format] ?? (format === "glb" ? (out.model_glb ?? out.model_mesh) : undefined);
  return only(r, file, `${format} model`);
}

export async function soundEffect(input: SoundEffectInput, ctx: PackContext): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.sound_effect;
  const props = await propsOf(ctx, model);
  const body: Json = {};
  body["text" in props ? "text" : "prompt"] = input.prompt;
  if (input.duration_seconds !== undefined) {
    const field = ["duration_seconds", "duration"].find((f) => f in props);
    if (!field)
      throw new UnsupportedInput(`${model} has no duration option; leave duration_seconds out.`);
    const p = props[field];
    if (
      (typeof p?.minimum === "number" && input.duration_seconds < p.minimum) ||
      (typeof p?.maximum === "number" && input.duration_seconds > p.maximum)
    ) {
      throw new UnsupportedInput(`${model} cannot make a ${input.duration_seconds}s sound.`);
    }
    body[field] = input.duration_seconds;
  }
  if (input.format) {
    const allowed = enumOf(props.output_format ?? {}) ?? [];
    // ElevenLabs-style enums name the container with a rate ("mp3_44100_128").
    const value = allowed.includes(input.format)
      ? input.format
      : input.format === "mp3" && allowed.includes("mp3_44100_128")
        ? "mp3_44100_128"
        : null;
    if (value === null)
      throw new UnsupportedInput(`${model} cannot produce ${input.format} audio.`);
    body.output_format = value;
  }
  const r = await runtimeOf(ctx).run(ctx, model, body, { prompt: input.prompt });
  return only(r, r.output?.audio, "audio");
}

export const capabilities = {
  "image.generate": imageGenerate,
  "video.generate": videoGenerate,
  "speech.generate": speechGenerate,
  "music.generate": musicGenerate,
  "audio.transcribe": audioTranscribe,
} as const;

// ---------------------------------------------------------------------------
// Capability providers (priority 45)
// ---------------------------------------------------------------------------

export const PROVIDER_ID = "fal";
export const PROVIDER_PRIORITY = 45;
const SETUP_HINT = "set FAL_KEY (https://fal.ai/dashboard/keys)";

/** An input fal cannot honour is retryable, so the router tries the next provider. */
async function guard<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (e) {
    if (e instanceof UnsupportedInput) {
      throw new CapabilityError(e.message, { retryable: true, code: "UNSUPPORTED_OPTION" });
    }
    throw e;
  }
}

/** Model ids the pack knows for one task: its default plus the bundled catalog snapshot. */
function known(def: string, categories: readonly string[]): string[] {
  const ids = new Set<string>([def]);
  for (const spec of seeds().values()) {
    if (categories.includes(spec.category) && !NOT_GENERATORS.has(spec.id)) ids.add(spec.id);
  }
  return [...ids];
}

/**
 * Output length in seconds for an estimate, worked out the way the run sets
 * it: the first of `fields` the model has is the one the run fills, with the
 * asked length (snapped to the model's allowed values, as the run does for
 * enums) or, when nothing is asked, that field's default. Unknown when the
 * model has none of the fields (the run then sends no length) or no default.
 */
async function secondsFor(
  ctx: PackContext,
  model: string,
  asked: number | undefined,
  fields: readonly string[],
): Promise<number | undefined> {
  let props: Props;
  try {
    props = await propsOf(ctx, model);
  } catch {
    return undefined;
  }
  const field = fields.find((f) => f in props);
  if (!field) return undefined;
  const p = props[field];
  // Allowed values and the default are in the field's own unit (ms or s).
  const ms = field.endsWith("_ms");
  const allowed = enumOf(p);
  const want = asked !== undefined ? (ms ? asked * 1000 : asked) : undefined;
  const raw = want !== undefined ? (allowed ? nearest(allowed, want) : want) : p?.default;
  const n =
    typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return ms ? n / 1000 : n;
}

/** Duration fields each run fills, in the order it checks them. */
const VIDEO_SECONDS = ["duration"] as const;
const MUSIC_SECONDS = ["music_length_ms", "duration", "seconds_total"] as const;
const SOUND_SECONDS = ["duration_seconds", "duration"] as const;

/** An estimate for `model`, null when fal has no usable price for this call. */
async function estimateCall(
  ctx: PackContext,
  model: string,
  q: Quantity | Promise<Quantity>,
): Promise<Estimate | null> {
  try {
    return await estimateFor(ctx, checkFalId(model), await q);
  } catch {
    return null;
  }
}

const base = {
  id: PROVIDER_ID,
  priority: PROVIDER_PRIORITY,
  setupHint: SETUP_HINT,
  isConfigured: (ctx: PackContext) => ctx.secrets.has(SECRET),
};

export const providers: readonly AnyProviderDefinition[] = [
  defineProvider({
    ...base,
    capability: "image.generate",
    models: () => [
      ...new Set([
        ...known(CAPABILITY_DEFAULTS.image, ["text-to-image", "image-to-image"]),
        CAPABILITY_DEFAULTS.image_edit,
      ]),
    ],
    estimate: (input, ctx) =>
      estimateCall(
        ctx,
        input.model ??
          (input.image_inputs?.length ? CAPABILITY_DEFAULTS.image_edit : CAPABILITY_DEFAULTS.image),
        { outputs: input.n ?? 1 },
      ),
    run: (input, ctx) =>
      guard(() =>
        imageGenerate(
          {
            prompt: input.prompt,
            ...(input.model ? { model: input.model } : {}),
            ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}),
            ...(input.n ? { n: input.n } : {}),
            ...(input.seed !== undefined ? { seed: input.seed } : {}),
            ...(input.image_inputs?.length ? { image_inputs: input.image_inputs } : {}),
          },
          ctx,
        ),
      ),
  }),
  defineProvider({
    ...base,
    capability: "video.generate",
    models: () => known(CAPABILITY_DEFAULTS.video, ["text-to-video", "image-to-video"]),
    estimate: (input, ctx) => {
      const model =
        input.model ??
        (input.image_input ? CAPABILITY_DEFAULTS.video_from_image : CAPABILITY_DEFAULTS.video);
      return estimateCall(
        ctx,
        model,
        secondsFor(ctx, model, input.duration_seconds, VIDEO_SECONDS).then((seconds) =>
          seconds !== undefined ? { seconds } : {},
        ),
      );
    },
    run: (input, ctx) =>
      guard(() =>
        videoGenerate(
          {
            prompt: input.prompt,
            ...(input.model ? { model: input.model } : {}),
            ...(input.aspect_ratio ? { aspect_ratio: input.aspect_ratio } : {}),
            ...(input.duration_seconds ? { duration_seconds: input.duration_seconds } : {}),
            ...(input.resolution ? { resolution: input.resolution } : {}),
            ...(input.image_input ? { image_input: input.image_input } : {}),
            ...(input.end_image_input ? { end_image_input: input.end_image_input } : {}),
          },
          ctx,
        ),
      ),
  }),
  defineProvider({
    ...base,
    capability: "speech.generate",
    models: () => known(CAPABILITY_DEFAULTS.speech, ["text-to-speech"]),
    estimate: (input, ctx) =>
      estimateCall(ctx, input.model ?? CAPABILITY_DEFAULTS.speech, {
        characters: input.text.length,
      }),
    run: (input, ctx) =>
      guard(() =>
        speechGenerate(
          {
            text: input.text,
            ...(input.voice ? { voice: input.voice } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.format ? { format: input.format } : {}),
            ...(input.language ? { language: input.language } : {}),
          },
          ctx,
        ),
      ),
  }),
  defineProvider({
    ...base,
    capability: "music.generate",
    models: () => known(CAPABILITY_DEFAULTS.music, ["text-to-audio"]),
    estimate: (input, ctx) => {
      const model = input.model ?? CAPABILITY_DEFAULTS.music;
      return estimateCall(
        ctx,
        model,
        secondsFor(ctx, model, input.duration_seconds, MUSIC_SECONDS).then((seconds) =>
          seconds !== undefined ? { seconds } : {},
        ),
      );
    },
    run: (input, ctx) =>
      guard(() =>
        musicGenerate(
          {
            prompt: input.prompt,
            ...(input.model ? { model: input.model } : {}),
            ...(input.duration_seconds ? { duration_seconds: input.duration_seconds } : {}),
            ...(input.instrumental ? { instrumental: true } : {}),
            ...(input.format ? { format: input.format } : {}),
          },
          ctx,
        ),
      ),
  }),
  defineProvider({
    ...base,
    capability: "audio.transcribe",
    models: () => known(CAPABILITY_DEFAULTS.transcribe, ["speech-to-text"]),
    estimate: (input, ctx) => estimateCall(ctx, input.model ?? CAPABILITY_DEFAULTS.transcribe, {}),
    run: (input, ctx) =>
      guard(() =>
        audioTranscribe(
          {
            artifact_id: input.artifact_id,
            ...(input.language ? { language: input.language } : {}),
            ...(input.model ? { model: input.model } : {}),
            ...(input.speakers ? { speakers: true } : {}),
            ...(input.timestamps ? { timestamps: true } : {}),
          },
          ctx,
        ),
      ),
  }),
  defineProvider({
    ...base,
    capability: "image.edit",
    models: () => [CAPABILITY_DEFAULTS.image_edit],
    estimate: (input, ctx) =>
      estimateCall(ctx, input.model ?? CAPABILITY_DEFAULTS.image_edit, { outputs: input.n ?? 1 }),
    run: (input, ctx) => guard(() => imageEdit(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "image.upscale",
    models: () => [...TASK_MODELS.image_upscale],
    estimate: (input, ctx) =>
      estimateCall(ctx, input.model ?? CAPABILITY_DEFAULTS.image_upscale, {}),
    run: (input, ctx) => guard(() => imageUpscale(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "image.remove_background",
    models: () => [...TASK_MODELS.remove_background],
    estimate: (input, ctx) =>
      estimateCall(ctx, input.model ?? CAPABILITY_DEFAULTS.remove_background, {}),
    run: (input, ctx) => guard(() => imageRemoveBackground(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "video.upscale",
    models: () => [...TASK_MODELS.video_upscale],
    estimate: (input, ctx) =>
      estimateCall(ctx, input.model ?? CAPABILITY_DEFAULTS.video_upscale, {}),
    run: (input, ctx) => guard(() => videoUpscale(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "video.lipsync",
    models: () => [...TASK_MODELS.lipsync],
    estimate: (input, ctx) => estimateCall(ctx, input.model ?? CAPABILITY_DEFAULTS.lipsync, {}),
    run: (input, ctx) => guard(() => videoLipsync(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "audio.separate_stems",
    models: () => [...TASK_MODELS.stems],
    estimate: (input, ctx) => estimateCall(ctx, input.model ?? CAPABILITY_DEFAULTS.stems, {}),
    run: (input, ctx) => guard(() => audioSeparateStems(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "3d.generate",
    models: () => [...TASK_MODELS.three_d],
    estimate: (input, ctx) =>
      estimateCall(
        ctx,
        input.model ??
          (input.artifact_id
            ? CAPABILITY_DEFAULTS.three_d_from_image
            : CAPABILITY_DEFAULTS.three_d),
        {},
      ),
    run: (input, ctx) => guard(() => threeDGenerate(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "sound.effect",
    models: () => [...TASK_MODELS.sound_effect],
    estimate: (input, ctx) => {
      const model = input.model ?? CAPABILITY_DEFAULTS.sound_effect;
      return estimateCall(
        ctx,
        model,
        secondsFor(ctx, model, input.duration_seconds, SOUND_SECONDS).then((seconds) =>
          seconds !== undefined ? { seconds } : {},
        ),
      );
    },
    run: (input, ctx) => guard(() => soundEffect(input, ctx)),
  }),
];
