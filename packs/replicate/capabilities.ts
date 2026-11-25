// packs/replicate/capabilities.ts
//
// Normalised capability functions over Replicate models. Each maps the shared
// input shape onto the fields the chosen model's schema has, then runs it
// through the prediction runner (which validates against the real schema).
import {
  type AnyProviderDefinition,
  CapabilityError,
  type PackContext,
  defineProvider,
} from "plughive/pack";
import { type ModelSpec, PROVIDER, parseModelRef } from "./client.js";
import {
  type ArtifactOut,
  type Json,
  ProviderError,
  checkArtifactId,
  resolvedProps,
} from "./common.js";
import { estimateFor } from "./estimates.js";
import { SECRET, runtimeOf } from "./runtime.js";

export const CAPABILITY_DEFAULTS = {
  image: "black-forest-labs/flux-schnell",
  image_edit: "google/nano-banana",
  video: "minimax/video-01",
  speech: "minimax/speech-02-hd",
  music: "meta/musicgen",
  transcribe: "openai/whisper",
  image_upscale: "topazlabs/image-upscale",
  remove_background: "recraft-ai/recraft-remove-background",
  lipsync: "sync/lipsync-2",
  video_upscale: "topazlabs/video-upscale",
  stems: "ryan5453/demucs",
  three_d: "firtoz/trellis",
  sound_effect: "zsxkib/mmaudio",
} as const;

export interface MediaResult {
  artifacts: (ArtifactOut & { stem?: string })[];
  model: string;
  provider: string;
  cost_usd?: number;
  warnings?: string[];
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

interface Segment {
  start?: number;
  end?: number;
  text: string;
}

async function load(ctx: PackContext, model: string): Promise<{ spec: ModelSpec; props: Props }> {
  const ref = parseModelRef(model);
  const key = await ctx.secrets.get(SECRET);
  const spec = await runtimeOf(ctx).spec(ctx, model, key);
  if (!spec) throw new UnsupportedInput(`Replicate has no model "${ref.id}".`);
  return { spec, props: resolvedProps(spec.input) };
}

function enumOf(p: Json): Json[] | null {
  if (Array.isArray(p?.enum)) return p.enum;
  const alt = p?.anyOf ?? p?.oneOf;
  if (Array.isArray(alt)) for (const a of alt) if (Array.isArray(a?.enum)) return a.enum;
  return null;
}

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

function first(props: Props, names: string[]): string | undefined {
  return names.find((n) => n in props);
}

/**
 * A library file as an `artifact:<id>` reference. The runner validates the
 * input first and only then inlines or uploads it (and deletes the upload
 * afterwards), so a rejected call never leaves a file on Replicate.
 */
function fileRef(id: string): string {
  return `artifact:${checkArtifactId(id)}`;
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

function setAspect(props: Props, body: Json, model: string, aspect: string | undefined): void {
  if (!aspect) return;
  if (!("aspect_ratio" in props)) return;
  const allowed = enumOf(props.aspect_ratio);
  if (allowed && !allowed.includes(aspect)) {
    throw new UnsupportedInput(
      `${model} does not support aspect_ratio ${aspect}; use one of ${allowed.join(", ")}`,
    );
  }
  body.aspect_ratio = aspect;
}

export async function imageGenerate(
  input: {
    prompt: string;
    model?: string;
    aspect_ratio?: string;
    n?: number;
    image_inputs?: string[];
    seed?: number;
  },
  ctx: PackContext,
): Promise<MediaResult> {
  const refs = input.image_inputs ?? [];
  const model =
    input.model ?? (refs.length > 0 ? CAPABILITY_DEFAULTS.image_edit : CAPABILITY_DEFAULTS.image);
  const { spec, props } = await load(ctx, model);
  const body: Json = { prompt: input.prompt };
  setAspect(props, body, model, input.aspect_ratio);
  const countField = first(props, ["num_outputs", "num_images", "number_of_images"]);
  if (input.n !== undefined) {
    if (countField) body[countField] = input.n;
    else if (input.n > 1)
      throw new UnsupportedInput(
        `${model} makes one image per call; n=${input.n} is not supported.`,
      );
  }
  if (input.seed !== undefined && "seed" in props) body.seed = input.seed;
  if (refs.length > 0) {
    const urls = refs.map(fileRef);
    const listField = first(props, ["image_input", "input_images", "images", "image_urls"]);
    const oneField = first(props, ["image", "input_image", "image_url"]);
    if (listField && props[listField]?.type === "array") body[listField] = urls;
    else if (oneField) body[oneField] = urls[0];
    else
      throw new UnsupportedInput(
        `${model} does not take input images; pick an image editing model.`,
      );
  }
  return media(await runtimeOf(ctx).run(ctx, model, body, { prompt: input.prompt, spec }));
}

export async function videoGenerate(
  input: {
    prompt: string;
    model?: string;
    aspect_ratio?: string;
    duration_seconds?: number;
    image_input?: string;
    end_image_input?: string;
    resolution?: string;
  },
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.video;
  const { spec, props } = await load(ctx, model);
  const body: Json = { prompt: input.prompt };
  setAspect(props, body, model, input.aspect_ratio);
  if (input.duration_seconds !== undefined && "duration" in props) {
    const allowed = enumOf(props.duration);
    body.duration = allowed
      ? nearest(allowed, input.duration_seconds)
      : Math.round(input.duration_seconds);
  }
  if (input.resolution && "resolution" in props) body.resolution = input.resolution;
  if (input.image_input) {
    const field = first(props, ["first_frame_image", "start_image", "image", "input_image"]);
    if (!field)
      throw new UnsupportedInput(
        `${model} does not take a start image; pick an image-to-video model.`,
      );
    body[field] = fileRef(input.image_input);
  }
  if (input.end_image_input) {
    const field = first(props, ["last_frame_image", "last_frame", "end_image", "tail_image"]);
    if (!field)
      throw new UnsupportedInput(
        `${model} does not take an end image; pick a model with first and last frames.`,
      );
    body[field] = fileRef(input.end_image_input);
  }
  return media(await runtimeOf(ctx).run(ctx, model, body, { prompt: input.prompt, spec }));
}

export async function speechGenerate(
  input: { text: string; voice?: string; model?: string; format?: string; language?: string },
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.speech;
  const { spec, props } = await load(ctx, model);
  const body: Json = {};
  body[first(props, ["text", "prompt", "input"]) ?? "text"] = input.text;
  if (input.voice) {
    const field = first(props, ["voice_id", "voice", "speaker"]);
    if (!field) throw new UnsupportedInput(`${model} has no voice option; leave voice out.`);
    body[field] = input.voice;
  }
  if (input.language) {
    const field = first(props, ["language", "language_code", "language_boost"]);
    if (!field) throw new UnsupportedInput(`${model} has no language option; leave language out.`);
    const allowed = enumOf(props[field]!);
    if (allowed && !allowed.includes(input.language)) {
      throw new UnsupportedInput(
        `${model} does not support language ${input.language}; use one of ${allowed.join(", ")}.`,
      );
    }
    body[field] = input.language;
  }
  if (input.format) {
    const field = first(props, ["audio_format", "output_format", "format"]);
    if (!field)
      throw new UnsupportedInput(`${model} has no audio format option; leave format out.`);
    const allowed = enumOf(props[field]!);
    if (allowed && !allowed.includes(input.format)) {
      throw new UnsupportedInput(
        `${model} cannot produce ${input.format} audio; use one of ${allowed.join(", ")}.`,
      );
    }
    body[field] = input.format;
  }
  return media(await runtimeOf(ctx).run(ctx, model, body, { prompt: input.text, spec }));
}

export async function musicGenerate(
  input: {
    prompt: string;
    duration_seconds?: number;
    model?: string;
    instrumental?: boolean;
    format?: string;
  },
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.music;
  const { spec, props } = await load(ctx, model);
  const body: Json = { prompt: input.prompt };
  if (input.instrumental) {
    if ("force_instrumental" in props) body.force_instrumental = true;
    else body.prompt = `${input.prompt}\n\nInstrumental only, no vocals.`;
  }
  if (input.format) {
    const field = first(props, ["output_format", "audio_format"]);
    const allowed = field ? enumOf(props[field]!) : null;
    if (!field || !allowed?.includes(input.format)) {
      throw new UnsupportedInput(`${model} cannot produce ${input.format} music.`);
    }
    body[field] = input.format;
  }
  if (input.duration_seconds !== undefined) {
    const field = first(props, ["duration", "seconds_total", "duration_seconds"]);
    if (field) body[field] = Math.round(input.duration_seconds);
  }
  return media(await runtimeOf(ctx).run(ctx, model, body, { prompt: input.prompt, spec }));
}

export async function audioTranscribe(
  input: {
    artifact_id: string;
    language?: string;
    model?: string;
    timestamps?: boolean;
    speakers?: boolean;
  },
  ctx: PackContext,
): Promise<{ text: string; segments?: Segment[]; model: string; provider: string }> {
  if (input.speakers)
    throw new UnsupportedInput("Replicate transcription models do not label speakers.");
  const model = input.model ?? CAPABILITY_DEFAULTS.transcribe;
  const { spec, props } = await load(ctx, model);
  const field = first(props, ["audio", "audio_file", "file"]);
  if (!field) {
    throw new UnsupportedInput(
      `${model} has no audio file input that this capability knows (expected audio, audio_file or file); run it with replicate_run instead.`,
    );
  }
  const body: Json = { [field]: fileRef(input.artifact_id) };
  if (input.language) {
    if (!("language" in props))
      throw new UnsupportedInput(`${model} has no language option; leave language out.`);
    const allowed = enumOf(props.language!);
    if (allowed && !allowed.includes(input.language)) {
      throw new UnsupportedInput(`${model} does not support language ${input.language}.`);
    }
    body.language = input.language;
  }
  // Validated like every other run, so a schema change fails here, not after a paid prediction.
  const r = await runtimeOf(ctx).run(ctx, model, body, { spec });
  const out = r.output ?? {};
  const text =
    typeof out === "string"
      ? out
      : typeof out.transcription === "string"
        ? out.transcription
        : String(out.text ?? "");
  const raw: Json[] = Array.isArray(out?.segments) ? out.segments : [];
  const segments = raw.map(
    (s): Segment => ({
      ...(typeof s?.start === "number" ? { start: s.start } : {}),
      ...(typeof s?.end === "number" ? { end: s.end } : {}),
      text: typeof s?.text === "string" ? s.text.trim() : "",
    }),
  );
  return { text: text.trim(), ...(segments.length ? { segments } : {}), model, provider: PROVIDER };
}

export async function imageEdit(
  input: {
    artifact_id: string;
    prompt: string;
    reference_ids?: string[] | undefined;
    mask_id?: string | undefined;
    model?: string | undefined;
    n?: number | undefined;
    seed?: number | undefined;
    aspect_ratio?: string | undefined;
  },
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.image_edit;
  const { spec, props } = await load(ctx, model);
  const body: Json = { prompt: input.prompt };
  const urls = [input.artifact_id, ...(input.reference_ids ?? [])].map(fileRef);
  const listField = first(props, ["image_input", "input_images", "images", "image_urls"]);
  const oneField = first(props, ["input_image", "image", "image_url"]);
  if (listField && props[listField]?.type === "array") body[listField] = urls;
  else if (oneField && urls.length === 1) body[oneField] = urls[0];
  else if (oneField)
    throw new UnsupportedInput(`${model} edits one image; leave reference_ids out.`);
  else
    throw new UnsupportedInput(
      `${model} does not take an input image; pick an image editing model.`,
    );
  if (input.mask_id) {
    const field = first(props, ["mask", "mask_image"]);
    if (!field) throw new UnsupportedInput(`${model} does not take a mask; leave mask_id out.`);
    body[field] = fileRef(input.mask_id);
  }
  setAspect(props, body, model, input.aspect_ratio);
  if (input.n !== undefined) {
    const countField = first(props, ["num_outputs", "num_images", "number_of_images"]);
    if (countField) body[countField] = input.n;
    else if (input.n > 1)
      throw new UnsupportedInput(
        `${model} makes one image per call; n=${input.n} is not supported.`,
      );
  }
  if (input.seed !== undefined && "seed" in props) body.seed = input.seed;
  return media(await runtimeOf(ctx).run(ctx, model, body, { prompt: input.prompt, spec }));
}

export async function imageUpscale(
  input: { artifact_id: string; scale?: number | undefined; model?: string | undefined },
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.image_upscale;
  const { spec, props } = await load(ctx, model);
  const field = first(props, ["image", "input_image", "image_url"]);
  if (!field)
    throw new UnsupportedInput(`${model} does not take an input image; pick an upscaler.`);
  const body: Json = { [field]: fileRef(input.artifact_id) };
  const scale = input.scale ?? 4;
  const scaleField = first(props, ["upscale_factor", "scale"]);
  if (!scaleField)
    throw new UnsupportedInput(`${model} has no upscale factor; pick another upscaler.`);
  const allowed = enumOf(props[scaleField]!);
  if (allowed) {
    // Topaz names factors "2x", "4x"; others list plain numbers.
    const hit = allowed.find((v) => v === scale || v === `${scale}x` || v === String(scale));
    if (hit === undefined) {
      throw new UnsupportedInput(
        `${model} cannot upscale ${scale}x; it supports ${allowed.join(", ")}.`,
      );
    }
    body[scaleField] = hit;
  } else {
    const p = props[scaleField]!;
    if (
      (typeof p.minimum === "number" && scale < p.minimum) ||
      (typeof p.maximum === "number" && scale > p.maximum)
    ) {
      throw new UnsupportedInput(`${model} cannot upscale ${scale}x.`);
    }
    body[scaleField] = scale;
  }
  return media(await runtimeOf(ctx).run(ctx, model, body, { spec }));
}

export async function imageRemoveBackground(
  input: { artifact_id: string; model?: string | undefined },
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.remove_background;
  const { spec, props } = await load(ctx, model);
  const field = first(props, ["image", "input_image", "image_url"]);
  if (!field)
    throw new UnsupportedInput(`${model} does not take an input image; pick a background remover.`);
  return media(
    await runtimeOf(ctx).run(ctx, model, { [field]: fileRef(input.artifact_id) }, { spec }),
  );
}

export async function videoLipsync(
  input: { artifact_id: string; audio_id: string; model?: string | undefined },
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.lipsync;
  const { spec, props } = await load(ctx, model);
  const videoField = first(props, ["video", "video_url", "input_video"]);
  const audioField = first(props, ["audio", "audio_url", "audio_file", "input_audio"]);
  if (!videoField || !audioField) {
    throw new UnsupportedInput(
      `${model} does not take a video and an audio track; pick a lip-sync model.`,
    );
  }
  const rec = await ctx.library.get(checkArtifactId(input.artifact_id));
  if (rec?.mime?.startsWith("image/"))
    throw new UnsupportedInput(`${model} needs a video, not a still image.`);
  const body: Json = {
    [videoField]: fileRef(input.artifact_id),
    [audioField]: fileRef(input.audio_id),
  };
  return media(await runtimeOf(ctx).run(ctx, model, body, { spec }));
}

/** Pixel height of a resolution enum value such as "1080p", "4k" or "FHD"; null when unknown. */
export function resolutionHeight(v: Json): number | null {
  const s = String(v).trim().toLowerCase();
  const named: Record<string, number> = {
    sd: 480,
    hd: 720,
    fhd: 1080,
    qhd: 1440,
    "2k": 1440,
    uhd: 2160,
    "4k": 2160,
    "8k": 4320,
  };
  if (s in named) return named[s] as number;
  const m = /^(\d{3,4})p$/.exec(s);
  return m ? Number(m[1]) : null;
}

function sourceHeight(meta: Record<string, unknown> | null | undefined): number | null {
  const h = meta?.height ?? (meta?.video as { height?: unknown } | undefined)?.height;
  return typeof h === "number" && h > 0 ? h : null;
}

/** Map an upscale factor onto a model's scale field (factor or target resolution). */
function setScale(
  props: Props,
  body: Json,
  model: string,
  scale: number,
  srcHeight: number | null,
  warnings: string[],
): void {
  const factorField = first(props, ["upscale_factor", "scale", "upscale"]);
  if (factorField) {
    const allowed = enumOf(props[factorField]!);
    if (allowed) {
      const hit = allowed.find((v) => v === scale || v === `${scale}x` || v === String(scale));
      if (hit === undefined)
        throw new UnsupportedInput(
          `${model} cannot upscale ${scale}x; it supports ${allowed.join(", ")}.`,
        );
      body[factorField] = hit;
    } else {
      const p = props[factorField]!;
      if (
        (typeof p.minimum === "number" && scale < p.minimum) ||
        (typeof p.maximum === "number" && scale > p.maximum)
      )
        throw new UnsupportedInput(`${model} cannot upscale ${scale}x.`);
      body[factorField] = scale;
    }
    return;
  }
  const resField = first(props, ["target_resolution", "resolution", "output_resolution"]);
  const allowed = resField ? enumOf(props[resField]!) : null;
  const sized = (allowed ?? [])
    .map((v) => ({ v, h: resolutionHeight(v) }))
    .filter((x): x is { v: Json; h: number } => x.h !== null)
    .sort((a, b) => a.h - b.h);
  if (!resField || sized.length === 0)
    throw new UnsupportedInput(`${model} has no upscale factor or target resolution.`);
  let target: number;
  if (srcHeight !== null) target = srcHeight * scale;
  else {
    // The library does not know this video's size: assume a 540p source.
    target = 540 * scale;
    warnings.push(
      `the source height is unknown, so ${scale}x was taken as about ${target}p; pass model settings via the Replicate tools for an exact size`,
    );
  }
  const pick = sized.find((x) => x.h >= target) ?? sized[sized.length - 1]!;
  body[resField] = pick.v;
}

export async function videoUpscale(
  input: { artifact_id: string; scale?: number | undefined; model?: string | undefined },
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.video_upscale;
  const { spec, props } = await load(ctx, model);
  const field = first(props, ["video", "video_path", "input_video", "video_url"]);
  if (!field) throw new UnsupportedInput(`${model} does not take a video; pick a video upscaler.`);
  const rec = await ctx.library.get(checkArtifactId(input.artifact_id));
  if (rec && !rec.mime?.startsWith("video/"))
    throw new UnsupportedInput(`${model} needs a video, not ${rec.mime || "this file"}.`);
  const body: Json = { [field]: fileRef(input.artifact_id) };
  const warnings: string[] = [];
  setScale(props, body, model, input.scale ?? 2, sourceHeight(rec?.meta), warnings);
  const r = media(await runtimeOf(ctx).run(ctx, model, body, { spec }));
  return warnings.length > 0 ? { ...r, warnings } : r;
}

function setFormat(props: Props, body: Json, model: string, format: string | undefined): void {
  if (!format) return;
  const field = first(props, ["output_format", "format", "audio_format"]);
  const allowed = field ? enumOf(props[field]!) : null;
  if (!field || (allowed && !allowed.includes(format)))
    throw new UnsupportedInput(`${model} cannot produce ${format}; leave format out.`);
  body[field] = format;
}

export async function audioSeparateStems(
  input: {
    artifact_id: string;
    two_stems?: string | undefined;
    model?: string | undefined;
    format?: "mp3" | "wav" | undefined;
  },
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.stems;
  const { spec, props } = await load(ctx, model);
  const field = first(props, ["audio", "audio_file", "input_audio", "music_input"]);
  if (!field) throw new UnsupportedInput(`${model} does not take audio; pick a stem separator.`);
  const body: Json = { [field]: fileRef(input.artifact_id) };
  if (input.two_stems) {
    const stemField = first(props, ["stem", "two_stems", "stems", "isolate_stem"]);
    const allowed = stemField ? enumOf(props[stemField]!) : null;
    if (!stemField || (allowed && !allowed.includes(input.two_stems)))
      throw new UnsupportedInput(
        `${model} cannot split out "${input.two_stems}" on its own; leave two_stems out.`,
      );
    body[stemField] = input.two_stems;
  }
  setFormat(props, body, model, input.format);
  const r = await runtimeOf(ctx).run(ctx, model, body, { spec });
  // Object outputs name each stem by key ({vocals, drums, ...} or {vocals, no_vocals}).
  const stemOf = new Map<string, string>();
  if (r.output && typeof r.output === "object" && !Array.isArray(r.output)) {
    for (const [k, v] of Object.entries(r.output as Record<string, Json>)) {
      if (typeof v?.artifact_id === "string") stemOf.set(v.artifact_id, k);
    }
  }
  const artifacts = r.artifacts
    .filter((a) => a.mime.startsWith("audio/") || stemOf.has(a.id))
    .map((a) => (stemOf.has(a.id) ? { ...a, stem: stemOf.get(a.id) as string } : a));
  if (artifacts.length === 0)
    throw new ProviderError(PROVIDER, `${model} finished but returned no stems.`);
  return media({ ...r, artifacts });
}

const MODEL_EXT = /\.(glb|gltf|obj|fbx|usdz|ply|stl)(?:$|[?#])/i;

export async function threeDGenerate(
  input: {
    prompt?: string | undefined;
    artifact_id?: string | undefined;
    model?: string | undefined;
    format?: "glb" | "obj" | "fbx" | "usdz" | undefined;
  },
  ctx: PackContext,
): Promise<MediaResult> {
  if (!input.prompt && !input.artifact_id)
    throw new CapabilityError("3d.generate needs a prompt, an image artifact_id, or both.", {
      retryable: true,
      code: "INVALID_INPUT",
    });
  const model = input.model ?? CAPABILITY_DEFAULTS.three_d;
  const { spec, props } = await load(ctx, model);
  const body: Json = {};
  if (input.prompt) {
    const field = first(props, ["prompt", "text", "text_prompt"]);
    if (!field)
      throw new UnsupportedInput(
        `${model} builds 3D models from an image only; give an image artifact_id without a prompt.`,
      );
    body[field] = input.prompt;
  }
  if (input.artifact_id) {
    const list = first(props, ["images", "image_inputs"]);
    const one = first(props, ["image", "input_image", "image_path", "image_url"]);
    const ref = fileRef(input.artifact_id);
    if (one) body[one] = ref;
    else if (list && props[list]?.type === "array") body[list] = [ref];
    else throw new UnsupportedInput(`${model} does not take an image; give a prompt only.`);
  }
  const format = input.format ?? "glb";
  const fmtField = first(props, ["output_format", "format", "file_format"]);
  if (fmtField) {
    const allowed = enumOf(props[fmtField]!);
    if (allowed && !allowed.includes(format))
      throw new UnsupportedInput(
        `${model} cannot export ${format}; it makes ${allowed.join(", ")}.`,
      );
    body[fmtField] = format;
  } else if (format !== "glb") {
    throw new UnsupportedInput(`${model} exports GLB only; leave format out.`);
  }
  // TRELLIS-style models only write the mesh when asked to.
  if (props.generate_model?.type === "boolean") body.generate_model = true;
  const r = await runtimeOf(ctx).run(ctx, model, body, {
    prompt: input.prompt ?? null,
    spec,
  });
  const meshes = r.artifacts.filter((a) => a.mime.startsWith("model/") || MODEL_EXT.test(a.url));
  if (meshes.length === 0)
    throw new ProviderError(PROVIDER, `${model} finished but returned no 3D model file.`);
  return media({ ...r, artifacts: meshes });
}

export async function soundEffect(
  input: {
    prompt: string;
    duration_seconds?: number | undefined;
    model?: string | undefined;
    format?: "mp3" | "wav" | undefined;
  },
  ctx: PackContext,
): Promise<MediaResult> {
  const model = input.model ?? CAPABILITY_DEFAULTS.sound_effect;
  const { spec, props } = await load(ctx, model);
  const promptField = first(props, ["prompt", "text"]);
  if (!promptField)
    throw new UnsupportedInput(`${model} does not take a text prompt; pick a sound model.`);
  const body: Json = { [promptField]: input.prompt };
  if (input.duration_seconds !== undefined) {
    const field = first(props, ["duration", "seconds_total", "duration_seconds", "audio_length"]);
    if (!field) throw new UnsupportedInput(`${model} has no duration; leave duration_seconds out.`);
    const p = props[field]!;
    const d = input.duration_seconds;
    if (
      (typeof p.minimum === "number" && d < p.minimum) ||
      (typeof p.maximum === "number" && d > p.maximum)
    )
      throw new UnsupportedInput(
        `${model} makes ${p.minimum ?? 0} to ${p.maximum ?? "?"} seconds; ${d}s is out of range.`,
      );
    body[field] = p.type === "integer" ? Math.round(d) : d;
  }
  setFormat(props, body, model, input.format);
  const r = await runtimeOf(ctx).run(ctx, model, body, { prompt: input.prompt, spec });
  const audio = r.artifacts.filter((a) => a.mime.startsWith("audio/"));
  if (audio.length === 0)
    throw new ProviderError(PROVIDER, `${model} finished but returned no audio.`);
  return media({ ...r, artifacts: audio });
}

export const capabilities = {
  "image.generate": imageGenerate,
  "image.edit": imageEdit,
  "image.upscale": imageUpscale,
  "image.remove_background": imageRemoveBackground,
  "video.generate": videoGenerate,
  "video.lipsync": videoLipsync,
  "video.upscale": videoUpscale,
  "audio.separate_stems": audioSeparateStems,
  "3d.generate": threeDGenerate,
  "sound.effect": soundEffect,
  "speech.generate": speechGenerate,
  "music.generate": musicGenerate,
  "audio.transcribe": audioTranscribe,
} as const;

// ---------------------------------------------------------------------------
// Capability providers (priority 35)
// ---------------------------------------------------------------------------

export const PROVIDER_ID = "replicate";
export const PROVIDER_PRIORITY = 35;
const SETUP_HINT = "set REPLICATE_API_TOKEN (https://replicate.com/account/api-tokens)";

/** An input Replicate cannot honour is retryable, so the router tries the next provider. */
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

/**
 * Replicate has no bundled catalog, so explicit-model routing knows only the
 * defaults; name `provider: "replicate"` to run any other model.
 */
const defaults = (...ids: string[]): string[] => [...new Set(ids)];

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
    models: () => defaults(CAPABILITY_DEFAULTS.image, CAPABILITY_DEFAULTS.image_edit),
    estimate: (input, ctx) =>
      estimateFor(
        input.model ??
          (input.image_inputs?.length ? CAPABILITY_DEFAULTS.image_edit : CAPABILITY_DEFAULTS.image),
        { n: input.n },
        ctx,
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
    models: () => defaults(CAPABILITY_DEFAULTS.video),
    estimate: (input, ctx) => estimateFor(input.model ?? CAPABILITY_DEFAULTS.video, {}, ctx),
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
    models: () => defaults(CAPABILITY_DEFAULTS.speech),
    estimate: (input, ctx) =>
      estimateFor(input.model ?? CAPABILITY_DEFAULTS.speech, { text: input.text }, ctx),
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
    models: () => defaults(CAPABILITY_DEFAULTS.music),
    estimate: (input, ctx) =>
      estimateFor(
        input.model ?? CAPABILITY_DEFAULTS.music,
        { duration_seconds: input.duration_seconds },
        ctx,
      ),
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
    models: () => defaults(CAPABILITY_DEFAULTS.transcribe),
    estimate: (input, ctx) => estimateFor(input.model ?? CAPABILITY_DEFAULTS.transcribe, {}, ctx),
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
    models: () => defaults(CAPABILITY_DEFAULTS.image_edit),
    estimate: (input, ctx) =>
      estimateFor(input.model ?? CAPABILITY_DEFAULTS.image_edit, { n: input.n }, ctx),
    run: (input, ctx) => guard(() => imageEdit(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "image.upscale",
    models: () => defaults(CAPABILITY_DEFAULTS.image_upscale),
    estimate: (input, ctx) =>
      estimateFor(
        input.model ?? CAPABILITY_DEFAULTS.image_upscale,
        { scale: input.scale, artifact_id: input.artifact_id },
        ctx,
        4,
      ),
    run: (input, ctx) => guard(() => imageUpscale(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "image.remove_background",
    models: () => defaults(CAPABILITY_DEFAULTS.remove_background),
    estimate: (input, ctx) =>
      estimateFor(input.model ?? CAPABILITY_DEFAULTS.remove_background, {}, ctx),
    run: (input, ctx) => guard(() => imageRemoveBackground(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "video.lipsync",
    models: () => defaults(CAPABILITY_DEFAULTS.lipsync),
    estimate: (input, ctx) =>
      estimateFor(
        input.model ?? CAPABILITY_DEFAULTS.lipsync,
        { artifact_id: input.artifact_id, audio_id: input.audio_id },
        ctx,
      ),
    run: (input, ctx) => guard(() => videoLipsync(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "video.upscale",
    models: () => defaults(CAPABILITY_DEFAULTS.video_upscale),
    estimate: (input, ctx) =>
      estimateFor(
        input.model ?? CAPABILITY_DEFAULTS.video_upscale,
        { scale: input.scale, artifact_id: input.artifact_id },
        ctx,
      ),
    run: (input, ctx) => guard(() => videoUpscale(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "audio.separate_stems",
    models: () => defaults(CAPABILITY_DEFAULTS.stems),
    estimate: (input, ctx) => estimateFor(input.model ?? CAPABILITY_DEFAULTS.stems, {}, ctx),
    run: (input, ctx) => guard(() => audioSeparateStems(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "3d.generate",
    models: () => defaults(CAPABILITY_DEFAULTS.three_d),
    estimate: (input, ctx) => estimateFor(input.model ?? CAPABILITY_DEFAULTS.three_d, {}, ctx),
    run: (input, ctx) => guard(() => threeDGenerate(input, ctx)),
  }),
  defineProvider({
    ...base,
    capability: "sound.effect",
    models: () => defaults(CAPABILITY_DEFAULTS.sound_effect),
    estimate: (input, ctx) =>
      estimateFor(
        input.model ?? CAPABILITY_DEFAULTS.sound_effect,
        { duration_seconds: input.duration_seconds },
        ctx,
      ),
    run: (input, ctx) => guard(() => soundEffect(input, ctx)),
  }),
];
