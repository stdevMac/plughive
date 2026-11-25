// packs/local/media.ts
//
// The ffmpeg tools. Every builder here is a pure function from validated
// options to an argv array or a filter graph, so tests can inspect exactly what
// would run. See lib/ffmpeg.ts for the rules that apply to all of them.
import { join } from "node:path";
import { defineTool, z } from "plughive/pack";
import type { PackContext } from "plughive/pack";
import {
  ASPECTS,
  AUDIO_FORMATS,
  AUDIO_MIME,
  type Aspect,
  type AudioFormat,
  MAX_OUTPUT_DIM,
  MAX_OUTPUT_SECONDS,
  type MediaInfo,
  VIDEO_FORMATS,
  VIDEO_MIME,
  type VideoFormat,
  artifactIdProblem,
  audioCodecArgs,
  boundedDuration,
  escapeFilterText,
  fixed,
  inputArgs,
  outputBounds,
  quoteFilterValue,
  readTextArtifact,
  reframeFilter,
  run,
  runFfmpeg,
  scaleFilter,
  stageInput,
  videoCodecArgs,
} from "./lib/ffmpeg.js";
import { ARTIFACT_ID, HINTS, artifactOut, round, withWorkDir } from "./lib/util.js";

const artifactId = z
  .string()
  .regex(ARTIFACT_ID, "an artifact id (from a previous tool result), not a path or URL");

const ANNOT = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;

// ---------------------------------------------------------------------------
// local_media_convert
// ---------------------------------------------------------------------------

const OPERATIONS = [
  "transcode",
  "trim",
  "scale",
  "reframe",
  "extract_audio",
  "gif",
  "thumbnail",
] as const;

export const ConvertInput = z
  .object({
    artifact_id: artifactId,
    operation: z.enum(OPERATIONS),
    format: z
      .enum([...VIDEO_FORMATS, ...AUDIO_FORMATS])
      .optional()
      .describe(
        "Output container. Video inputs take mp4, mov, mkv or webm; audio inputs take mp3, wav, m4a, flac or ogg.",
      ),
    start_s: z.number().min(0).max(86_400).optional(),
    duration_s: z.number().min(0.05).max(MAX_OUTPUT_SECONDS).optional(),
    width: z.number().int().min(16).max(MAX_OUTPUT_DIM).optional(),
    height: z.number().int().min(16).max(MAX_OUTPUT_DIM).optional(),
    aspect: z
      .enum(["9:16", "16:9", "1:1"])
      .optional()
      .describe("reframe: 9:16 = 1080x1920, 16:9 = 1920x1080, 1:1 = 1080x1080."),
    fit: z
      .enum(["cover", "contain"])
      .optional()
      .describe("reframe: cover crops to fill, contain pads with black bars. Default cover."),
    crf: z
      .number()
      .int()
      .min(16)
      .max(35)
      .optional()
      .describe("Quality for video encodes, lower is better. Default 23."),
    fps: z.number().int().min(1).max(60).optional(),
    audio_format: z.enum(AUDIO_FORMATS).optional().describe("extract_audio: default mp3."),
    image_format: z.enum(["jpg", "png", "webp"]).optional().describe("thumbnail: default jpg."),
    at_s: z
      .number()
      .min(0)
      .max(86_400)
      .optional()
      .describe("thumbnail: time of the frame in seconds. Default 1."),
  })
  .superRefine((v, ctx) => {
    const need = (ok: boolean, message: string) => {
      if (!ok) ctx.addIssue({ code: "custom", message });
    };
    if (v.operation === "trim")
      need(
        v.start_s !== undefined || v.duration_s !== undefined,
        "trim needs start_s and/or duration_s",
      );
    if (v.operation === "scale")
      need(v.width !== undefined || v.height !== undefined, "scale needs width and/or height");
    if (v.operation === "reframe")
      need(v.aspect !== undefined, "reframe needs aspect (9:16, 16:9 or 1:1)");
  });
export type ConvertArgs = z.output<typeof ConvertInput>;

export interface ConvertPlan {
  args: string[];
  ext: string;
  mime: string;
  kind: "video" | "image" | "audio";
  durationS: number;
}

const isVideoFormat = (f: string): f is VideoFormat =>
  (VIDEO_FORMATS as readonly string[]).includes(f);
const isAudioFormat = (f: string): f is AudioFormat =>
  (AUDIO_FORMATS as readonly string[]).includes(f);

/** Build the ffmpeg argv (everything before the output path) for one convert call. */
export function planConvert(input: ConvertArgs, info: MediaInfo, inPath: string): ConvertPlan {
  const start = input.start_s;
  const pre = start ? ["-ss", fixed(start, 3)] : [];
  const op = input.operation;
  const realVideo = info.hasVideo && !info.isImage;

  if (op === "thumbnail") {
    if (!info.hasVideo)
      throw new Error("the input has no video or image frame to use for a thumbnail");
    const at =
      input.at_s ?? (info.isImage ? 0 : Math.min(1, Math.max(0, (info.duration_s ?? 0) / 2)));
    const fmt = input.image_format ?? "jpg";
    const q = fmt === "jpg" ? ["-q:v", "2"] : fmt === "webp" ? ["-quality", "85"] : [];
    const vf = input.width ? ["-vf", `scale=${input.width}:-2`] : [];
    const mime = fmt === "jpg" ? "image/jpeg" : `image/${fmt}`;
    return {
      args: [
        ...inputArgs(inPath, info.isImage ? [] : ["-ss", fixed(at, 3)]),
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-an",
        ...vf,
        ...q,
        ...outputBounds(1),
      ],
      ext: fmt === "jpg" ? "jpg" : fmt,
      mime,
      kind: "image",
      durationS: 0,
    };
  }

  if (op === "extract_audio") {
    if (!info.hasAudio) throw new Error("the input has no audio track");
    const fmt = input.audio_format ?? "mp3";
    const durationS = boundedDuration(info.duration_s, start, input.duration_s);
    return {
      args: [
        ...inputArgs(inPath, pre),
        "-vn",
        "-map",
        "0:a:0",
        ...audioCodecArgs(fmt),
        ...outputBounds(durationS),
      ],
      ext: fmt,
      mime: AUDIO_MIME[fmt],
      kind: "audio",
      durationS,
    };
  }

  if (op === "gif") {
    if (!realVideo) throw new Error("gif needs a video input");
    const fps = Math.min(input.fps ?? 12, 30);
    const width = Math.min(input.width ?? 480, 1280);
    const durationS = Math.min(input.duration_s ?? 10, 30);
    const graph = `fps=${fps},scale=${width}:-2:flags=lanczos,split[gifa][gifb];[gifa]palettegen=stats_mode=diff[gifpal];[gifb][gifpal]paletteuse=dither=bayer:bayer_scale=5`;
    return {
      args: [
        ...inputArgs(inPath, pre),
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        graph,
        "-loop",
        "0",
        ...outputBounds(durationS),
      ],
      ext: "gif",
      mime: "image/gif",
      kind: "image",
      durationS,
    };
  }

  // transcode | trim | scale | reframe
  if (info.isImage)
    throw new Error(`${op} does not accept still images; use thumbnail to resize one`);
  const durationS = boundedDuration(info.duration_s, start, input.duration_s);

  if (!realVideo) {
    if (op === "scale" || op === "reframe") throw new Error(`${op} needs a video input`);
    const fmt = input.format ?? input.audio_format ?? "mp3";
    if (!isAudioFormat(fmt))
      throw new Error(`the input is audio only; format must be one of ${AUDIO_FORMATS.join(", ")}`);
    return {
      args: [
        ...inputArgs(inPath, pre),
        "-vn",
        "-map",
        "0:a:0",
        ...audioCodecArgs(fmt),
        ...outputBounds(durationS),
      ],
      ext: fmt,
      mime: AUDIO_MIME[fmt],
      kind: "audio",
      durationS,
    };
  }

  const fmt = input.format ?? "mp4";
  if (!isVideoFormat(fmt))
    throw new Error(
      `the input has video; format must be one of ${VIDEO_FORMATS.join(", ")} (use extract_audio for ${fmt})`,
    );
  const filters: string[] = [];
  if (op === "scale") filters.push(scaleFilter(input.width, input.height));
  if (op === "reframe") filters.push(reframeFilter(input.aspect as Aspect, input.fit ?? "cover"));
  if (input.fps) filters.push(`fps=${input.fps}`);
  return {
    args: [
      ...inputArgs(inPath, pre),
      "-map",
      "0:v:0",
      ...(info.hasAudio ? ["-map", "0:a:0"] : []),
      ...(filters.length > 0 ? ["-vf", filters.join(",")] : []),
      ...videoCodecArgs(fmt, input.crf ?? 23),
      ...outputBounds(durationS),
    ],
    ext: fmt,
    mime: VIDEO_MIME[fmt],
    kind: "video",
    durationS,
  };
}

export async function runConvert(
  ctx: PackContext,
  input: ConvertArgs,
  tool = "local_media_convert",
) {
  return withWorkDir(ctx, async (work) => {
    ctx.progress?.(0.05, "probing input");
    const src = await stageInput(ctx, work, input.artifact_id, 0);
    const plan = planConvert(input, src.info, src.path);
    const outPath = join(work, `out.${plan.ext}`);
    ctx.progress?.(0.2, `running ffmpeg (${input.operation})`);
    await runFfmpeg(ctx, work, plan.args, outPath, {
      progress: { from: 0.2, to: 0.9, message: `running ffmpeg (${input.operation})` },
    });
    ctx.progress?.(0.9, "saving result");
    const ref = await ctx.library.importFile({
      kind: plan.kind,
      mime: plan.mime,
      sourcePath: outPath,
      tool,
      meta: { operation: input.operation, source: input.artifact_id, format: plan.ext },
    });
    return {
      artifact: artifactOut(ref),
      operation: input.operation,
      format: plan.ext,
      bytes: ref.bytes ?? null,
    };
  });
}

const mediaConvert = defineTool({
  name: "local_media_convert",
  description:
    "Transcode, trim, scale, reframe (fixed 9:16, 16:9 or 1:1 outputs), extract audio, make a GIF or take a thumbnail from a library video/audio artifact, using local ffmpeg. No API key. Input and output are artifact ids; the result is a new artifact.",
  input: ConvertInput,
  annotations: { title: "Convert media (ffmpeg)", ...ANNOT },
  longRunning: true,
  tags: ["local", "ffmpeg", "video", "audio"],
  run: (input, ctx) => runConvert(ctx, input),
});

// ---------------------------------------------------------------------------
// local_media_probe
// ---------------------------------------------------------------------------

const mediaProbe = defineTool({
  name: "local_media_probe",
  description:
    "Inspect a library artifact with ffprobe: container, duration, size, and per-stream codec, resolution, frame rate, sample rate and channels.",
  input: z.object({ artifact_id: artifactId }),
  annotations: { title: "Probe media (ffprobe)", readOnlyHint: true, openWorldHint: false },
  tags: ["local", "ffmpeg"],
  async run(input, ctx) {
    return withWorkDir(ctx, async (work) => {
      const src = await stageInput(ctx, work, input.artifact_id, 0);
      const i = src.info;
      return {
        artifact_id: input.artifact_id,
        format: i.format,
        duration_s: i.duration_s === null ? null : round(i.duration_s, 3),
        size_bytes: i.size_bytes,
        bit_rate: i.bit_rate,
        has_video: i.hasVideo,
        has_audio: i.hasAudio,
        is_image: i.isImage,
        width: i.width,
        height: i.height,
        fps: i.fps,
        streams: i.streams,
      };
    });
  },
});

// ---------------------------------------------------------------------------
// local_audio_mix
// ---------------------------------------------------------------------------

export interface MixPreset {
  music_volume: number;
  voice_volume: number;
  duck: boolean;
  duck_threshold: number;
  duck_ratio: number;
  intro_ms: number;
  outro_ms: number;
  fade_in_ms: number;
  fade_out_ms: number;
  voice_processing: boolean;
  loudnorm: boolean;
}

// Mix presets for local_audio_mix.
export const MIX_PRESETS: Record<"ad" | "narration" | "podcast" | "trailer" | "custom", MixPreset> =
  {
    ad: {
      music_volume: 0.55,
      voice_volume: 1.0,
      duck: true,
      duck_threshold: 0.05,
      duck_ratio: 8,
      intro_ms: 1000,
      outro_ms: 1500,
      fade_in_ms: 400,
      fade_out_ms: 1500,
      voice_processing: true,
      loudnorm: true,
    },
    narration: {
      music_volume: 0.4,
      voice_volume: 1.0,
      duck: true,
      duck_threshold: 0.05,
      duck_ratio: 5,
      intro_ms: 2000,
      outro_ms: 2500,
      fade_in_ms: 1000,
      fade_out_ms: 2000,
      voice_processing: true,
      loudnorm: true,
    },
    podcast: {
      music_volume: 0.32,
      voice_volume: 1.0,
      duck: true,
      duck_threshold: 0.05,
      duck_ratio: 4,
      intro_ms: 1500,
      outro_ms: 1500,
      fade_in_ms: 500,
      fade_out_ms: 1500,
      voice_processing: true,
      loudnorm: true,
    },
    trailer: {
      music_volume: 0.7,
      voice_volume: 1.05,
      duck: true,
      duck_threshold: 0.04,
      duck_ratio: 6,
      intro_ms: 3000,
      outro_ms: 3000,
      fade_in_ms: 1500,
      fade_out_ms: 2500,
      voice_processing: true,
      loudnorm: true,
    },
    custom: {
      music_volume: 0.2,
      voice_volume: 1.0,
      duck: false,
      duck_threshold: 0.05,
      duck_ratio: 6,
      intro_ms: 0,
      outro_ms: 0,
      fade_in_ms: 0,
      fade_out_ms: 0,
      voice_processing: false,
      loudnorm: false,
    },
  };

export interface MixGraphOptions {
  n: number;
  voiceVol: number;
  bgVol: (i: number) => number;
  intro_ms: number;
  outro_ms: number;
  fade_in_ms: number;
  fade_out_ms: number;
  duck: boolean;
  duck_threshold: number;
  duck_ratio: number;
  voice_processing: boolean;
  loudnorm: boolean;
  totalSec: number;
}

const STEREO_44K = "aformat=sample_rates=44100:channel_layouts=stereo";

/**
 * Filter graph for the preset mix. Input 0 is the voice, the rest are
 * background tracks. All labels are multi-letter (ffmpeg rejects single letters
 * in some builds). The voice feeds both the sidechain key and the final mix, so
 * it is split with asplit: a filter output may only be consumed once.
 */
export function buildMixGraph(o: MixGraphOptions): string {
  const parts: string[] = [];
  const voice: string[] = [STEREO_44K];
  if (o.voice_processing) {
    voice.push("highpass=f=80", "acompressor=threshold=-18dB:ratio=2.5:attack=20:release=250");
  }
  voice.push(`volume=${fixed(o.voiceVol)}`);
  if (o.intro_ms > 0) voice.push(`adelay=${o.intro_ms}|${o.intro_ms}`);
  if (o.outro_ms > 0) voice.push(`apad=pad_dur=${fixed(o.outro_ms / 1000, 3)}`);
  parts.push(
    o.duck ? `[0:a]${voice.join(",")},asplit=2[voice][voicekey]` : `[0:a]${voice.join(",")}[voice]`,
  );

  if (o.n === 2) {
    const bg = [STEREO_44K, `volume=${fixed(o.bgVol(1))}`];
    if (o.fade_in_ms > 0) bg.push(`afade=t=in:d=${fixed(o.fade_in_ms / 1000, 3)}`);
    parts.push(`[1:a]${bg.join(",")}[bg_pre]`);
  } else {
    const labels: string[] = [];
    for (let i = 1; i < o.n; i++) {
      const chain = [STEREO_44K, `volume=${fixed(o.bgVol(i))}`];
      if (o.fade_in_ms > 0 && i === 1) chain.push(`afade=t=in:d=${fixed(o.fade_in_ms / 1000, 3)}`);
      parts.push(`[${i}:a]${chain.join(",")}[bg${i}]`);
      labels.push(`[bg${i}]`);
    }
    parts.push(`${labels.join("")}amix=inputs=${o.n - 1}:duration=longest:normalize=0[bg_pre]`);
  }

  if (o.duck) {
    parts.push(
      `[bg_pre][voicekey]sidechaincompress=threshold=${fixed(o.duck_threshold)}:ratio=${fixed(o.duck_ratio)}:attack=5:release=200[bg_ducked]`,
    );
  } else {
    parts.push("[bg_pre]anull[bg_ducked]");
  }

  if (o.fade_out_ms > 0) {
    const st = Math.max(0, o.totalSec - o.fade_out_ms / 1000);
    parts.push(
      `[bg_ducked]afade=t=out:st=${fixed(st, 3)}:d=${fixed(o.fade_out_ms / 1000, 3)}[bg_final]`,
    );
  } else {
    parts.push("[bg_ducked]anull[bg_final]");
  }

  parts.push(
    "[voice][bg_final]amix=inputs=2:duration=first:dropout_transition=0:normalize=0,asetpts=N/SR/TB[mixed]",
  );
  parts.push(
    o.loudnorm
      ? "[mixed]loudnorm=I=-14:TP=-1:LRA=11,aresample=44100[mixout]"
      : "[mixed]alimiter=limit=0.95[mixout]",
  );
  return parts.join(";");
}

export const MixInput = z.object({
  inputs: z
    .array(z.object({ artifact_id: artifactId, volume: z.number().min(0).max(4).optional() }))
    .min(2)
    .max(8)
    .describe("First entry is the foreground (voice), the rest are background music or effects."),
  preset: z.enum(["narration", "ad", "podcast", "trailer", "custom"]).optional(),
  duck: z.boolean().optional(),
  duck_threshold: z.number().min(0.001).max(1).optional(),
  duck_ratio: z.number().min(1).max(20).optional(),
  intro_ms: z.number().int().min(0).max(60_000).optional(),
  outro_ms: z.number().int().min(0).max(60_000).optional(),
  fade_in_ms: z.number().int().min(0).max(10_000).optional(),
  fade_out_ms: z.number().int().min(0).max(10_000).optional(),
  voice_processing: z.boolean().optional(),
  loudnorm: z.boolean().optional(),
  output_format: z.enum(["mp3", "wav"]).optional(),
});
export type MixArgs = z.output<typeof MixInput>;

export function resolveMix(input: MixArgs, voiceSeconds: number) {
  const presetName = input.preset ?? "custom";
  const p = MIX_PRESETS[presetName];
  const intro_ms = input.intro_ms ?? p.intro_ms;
  const outro_ms = input.outro_ms ?? p.outro_ms;
  const totalSec = intro_ms / 1000 + voiceSeconds + outro_ms / 1000;
  const graph: MixGraphOptions = {
    n: input.inputs.length,
    voiceVol: input.inputs[0]?.volume ?? p.voice_volume,
    bgVol: (i) => input.inputs[i]?.volume ?? p.music_volume,
    intro_ms,
    outro_ms,
    fade_in_ms: input.fade_in_ms ?? p.fade_in_ms,
    fade_out_ms: input.fade_out_ms ?? p.fade_out_ms,
    duck: input.duck ?? p.duck,
    duck_threshold: input.duck_threshold ?? p.duck_threshold,
    duck_ratio: input.duck_ratio ?? p.duck_ratio,
    voice_processing: input.voice_processing ?? p.voice_processing,
    loudnorm: input.loudnorm ?? p.loudnorm,
    totalSec,
  };
  return { presetName, graph, totalSec };
}

export async function runMix(ctx: PackContext, input: MixArgs, tool = "local_audio_mix") {
  return withWorkDir(ctx, async (work) => {
    ctx.progress?.(0.05, "probing inputs");
    const staged = [];
    for (const [i, t] of input.inputs.entries()) {
      const s = await stageInput(ctx, work, t.artifact_id, i);
      if (!s.info.hasAudio) throw new Error(`artifact ${t.artifact_id} has no audio track`);
      staged.push(s);
    }
    const voiceSeconds = staged[0]?.info.duration_s;
    if (!voiceSeconds)
      throw new Error("could not determine the duration of the first (voice) input");
    const { presetName, graph, totalSec } = resolveMix(input, voiceSeconds);
    if (totalSec > MAX_OUTPUT_SECONDS) {
      throw new Error(
        `the mix would be ${Math.round(totalSec)} s, over the ${MAX_OUTPUT_SECONDS} s limit`,
      );
    }
    const fmt = input.output_format ?? "mp3";
    const args: string[] = [];
    for (const s of staged) args.push(...inputArgs(s.path));
    args.push("-filter_complex", buildMixGraph(graph), "-map", "[mixout]");
    args.push(
      ...(fmt === "mp3"
        ? ["-c:a", "libmp3lame", "-b:a", "192k"]
        : ["-c:a", "pcm_s16le", "-ar", "44100"]),
    );
    args.push(...outputBounds(totalSec + 0.1));
    const outPath = join(work, `mix.${fmt}`);
    ctx.progress?.(0.2, "mixing");
    await runFfmpeg(ctx, work, args, outPath, {
      progress: { from: 0.2, to: 0.9, message: "mixing" },
    });
    const ref = await ctx.library.importFile({
      kind: "audio",
      mime: fmt === "mp3" ? "audio/mpeg" : "audio/wav",
      sourcePath: outPath,
      tool,
      meta: {
        preset: presetName,
        inputs: input.inputs.map((t) => t.artifact_id),
        duck: graph.duck,
        loudnorm: graph.loudnorm,
        total_duration_s: round(totalSec, 3),
      },
    });
    return {
      artifact: artifactOut(ref),
      preset: presetName,
      inputs: input.inputs.length,
      total_duration_s: round(totalSec, 3),
    };
  });
}

const audioMix = defineTool({
  name: "local_audio_mix",
  description:
    "Mix a voice track with background music or effects using local ffmpeg: presets ad, narration, podcast, trailer (or custom), intro/outro padding, fades, sidechain ducking under the voice, voice cleanup and loudness normalisation to -14 LUFS / -1 dBTP. First input is the voice.",
  input: MixInput,
  annotations: { title: "Mix audio (ffmpeg)", ...ANNOT },
  longRunning: true,
  tags: ["local", "ffmpeg", "audio"],
  run: (input, ctx) => runMix(ctx, input),
});

// ---------------------------------------------------------------------------
// local_video_concat
// ---------------------------------------------------------------------------

export interface ConcatItem {
  hasAudio: boolean;
  duration: number;
}

/** Normalise every clip to one size/fps/format and join them with the concat filter. */
export function buildConcatGraph(
  items: readonly ConcatItem[],
  size: { width: number; height: number },
  fps: number,
): { graph: string; audio: boolean } {
  const parts: string[] = [];
  const audio = items.some((i) => i.hasAudio);
  const { width: w, height: h } = size;
  items.forEach((item, i) => {
    parts.push(
      `[${i}:v:0]scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[vid${i}]`,
    );
    if (audio) {
      parts.push(
        item.hasAudio
          ? `[${i}:a:0]${STEREO_44K}[aud${i}]`
          : `anullsrc=r=44100:cl=stereo,atrim=duration=${fixed(item.duration, 3)}[aud${i}]`,
      );
    }
  });
  const joined = items.map((_, i) => `[vid${i}]${audio ? `[aud${i}]` : ""}`).join("");
  parts.push(
    `${joined}concat=n=${items.length}:v=1:a=${audio ? 1 : 0}[outv]${audio ? "[outa]" : ""}`,
  );
  return { graph: parts.join(";"), audio };
}

export const ConcatInput = z.object({
  artifact_ids: z.array(artifactId).min(2).max(20),
  aspect: z
    .enum(["first", "9:16", "16:9", "1:1"])
    .optional()
    .describe("Output frame: the first clip's size (default) or a fixed 9:16, 16:9 or 1:1 preset."),
  fps: z.number().int().min(10).max(60).optional(),
  crf: z.number().int().min(16).max(35).optional(),
});
export type ConcatArgs = z.output<typeof ConcatInput>;

const even = (n: number) => Math.max(2, Math.floor(n / 2) * 2);

export async function runConcat(ctx: PackContext, input: ConcatArgs, tool = "local_video_concat") {
  return withWorkDir(ctx, async (work) => {
    ctx.progress?.(0.05, "probing clips");
    const staged = [];
    for (const [i, id] of input.artifact_ids.entries()) {
      const s = await stageInput(ctx, work, id, i);
      if (!s.info.hasVideo || s.info.isImage || !s.info.duration_s) {
        throw new Error(`artifact ${id} is not a video with a known duration`);
      }
      staged.push(s);
    }
    const total = staged.reduce((a, s) => a + (s.info.duration_s ?? 0), 0);
    if (total > MAX_OUTPUT_SECONDS)
      throw new Error(
        `the clips add up to ${Math.round(total)} s, over the ${MAX_OUTPUT_SECONDS} s limit`,
      );
    const first = staged[0]?.info;
    const aspect = input.aspect ?? "first";
    const size =
      aspect === "first"
        ? {
            width: even(Math.min(first?.width ?? 1280, MAX_OUTPUT_DIM)),
            height: even(Math.min(first?.height ?? 720, MAX_OUTPUT_DIM)),
          }
        : ASPECTS[aspect];
    const fps = input.fps ?? 30;
    const { graph, audio } = buildConcatGraph(
      staged.map((s) => ({ hasAudio: s.info.hasAudio, duration: s.info.duration_s ?? 0 })),
      size,
      fps,
    );
    const args: string[] = [];
    for (const s of staged) args.push(...inputArgs(s.path));
    args.push("-filter_complex", graph, "-map", "[outv]");
    if (audio) args.push("-map", "[outa]");
    args.push(...videoCodecArgs("mp4", input.crf ?? 23), ...outputBounds(total + 0.5));
    const outPath = join(work, "out.mp4");
    ctx.progress?.(0.2, "joining clips");
    await runFfmpeg(ctx, work, args, outPath, {
      progress: { from: 0.2, to: 0.9, message: "joining clips" },
    });
    const ref = await ctx.library.importFile({
      kind: "video",
      mime: "video/mp4",
      sourcePath: outPath,
      tool,
      meta: { sources: input.artifact_ids, width: size.width, height: size.height, fps },
    });
    return {
      artifact: artifactOut(ref),
      clips: staged.length,
      width: size.width,
      height: size.height,
      duration_s: round(total, 3),
    };
  });
}

const videoConcat = defineTool({
  name: "local_video_concat",
  description:
    "Join two or more library videos end to end with local ffmpeg. Clips are scaled and padded to one frame size (the first clip's, or 9:16 / 16:9 / 1:1) and one frame rate; clips without audio get silence when others have it.",
  input: ConcatInput,
  annotations: { title: "Concatenate videos (ffmpeg)", ...ANNOT },
  longRunning: true,
  tags: ["local", "ffmpeg", "video"],
  run: (input, ctx) => runConcat(ctx, input),
});

// ---------------------------------------------------------------------------
// local_audio_concat
// ---------------------------------------------------------------------------

export interface AudioConcatGraphOptions {
  /** Number of audio inputs, in order. */
  n: number;
  /** Silence between consecutive items, in milliseconds. */
  gap_ms: number;
  loudnorm: boolean;
}

/**
 * Join N audio inputs end to end. Every input is resampled to 44.1 kHz stereo
 * so the concat filter accepts them, and a silent anullsrc segment (one per
 * gap: a filter output may only be consumed once) goes between items.
 */
export function buildAudioConcatGraph(o: AudioConcatGraphOptions): string {
  const parts: string[] = [];
  const order: string[] = [];
  const gapS = o.gap_ms / 1000;
  for (let i = 0; i < o.n; i++) {
    parts.push(`[${i}:a:0]${STEREO_44K}[aud${i}]`);
    order.push(`[aud${i}]`);
    if (gapS > 0 && i < o.n - 1) {
      parts.push(`anullsrc=r=44100:cl=stereo,atrim=duration=${fixed(gapS, 3)}[gap${i}]`);
      order.push(`[gap${i}]`);
    }
  }
  parts.push(`${order.join("")}concat=n=${order.length}:v=0:a=1[joined]`);
  parts.push(
    o.loudnorm
      ? "[joined]loudnorm=I=-16:TP=-1.5:LRA=11,aresample=44100[catout]"
      : "[joined]anull[catout]",
  );
  return parts.join(";");
}

export const AudioConcatInput = z.object({
  artifact_ids: z
    .array(artifactId)
    .min(2)
    .max(200)
    .describe("Audio (or video with audio) artifacts, joined in this order."),
  gap_ms: z
    .number()
    .int()
    .min(0)
    .max(10_000)
    .optional()
    .describe("Silence between consecutive items, in milliseconds. Default 0."),
  loudnorm: z
    .boolean()
    .optional()
    .describe(
      "Normalise the joined result to -16 LUFS / -1.5 dBTP (speech/podcast level). Default false.",
    ),
  output_format: z.enum(["mp3", "wav"]).optional().describe("Default mp3."),
});
export type AudioConcatArgs = z.output<typeof AudioConcatInput>;

export async function runAudioConcat(
  ctx: PackContext,
  input: AudioConcatArgs,
  tool = "local_audio_concat",
) {
  return withWorkDir(ctx, async (work) => {
    ctx.progress?.(0.05, "probing inputs");
    const staged = [];
    for (const [i, id] of input.artifact_ids.entries()) {
      const s = await stageInput(ctx, work, id, i);
      if (!s.info.hasAudio || !s.info.duration_s) {
        throw new Error(`artifact ${id} has no audio track with a known duration`);
      }
      staged.push(s);
    }
    const gap_ms = input.gap_ms ?? 0;
    const loudnorm = input.loudnorm ?? false;
    const total =
      staged.reduce((a, s) => a + (s.info.duration_s ?? 0), 0) +
      (gap_ms / 1000) * (staged.length - 1);
    if (total > MAX_OUTPUT_SECONDS) {
      throw new Error(
        `the joined audio would be ${Math.round(total)} s, over the ${MAX_OUTPUT_SECONDS} s limit`,
      );
    }
    const fmt = input.output_format ?? "mp3";
    const args: string[] = [];
    for (const s of staged) args.push(...inputArgs(s.path));
    args.push(
      "-filter_complex",
      buildAudioConcatGraph({ n: staged.length, gap_ms, loudnorm }),
      "-map",
      "[catout]",
    );
    args.push(
      ...(fmt === "mp3"
        ? ["-c:a", "libmp3lame", "-b:a", "192k"]
        : ["-c:a", "pcm_s16le", "-ar", "44100"]),
    );
    args.push(...outputBounds(total + 0.5));
    const outPath = join(work, `joined.${fmt}`);
    ctx.progress?.(0.2, "joining audio");
    await runFfmpeg(ctx, work, args, outPath, {
      progress: { from: 0.2, to: 0.9, message: "joining audio" },
    });
    const ref = await ctx.library.importFile({
      kind: "audio",
      mime: fmt === "mp3" ? "audio/mpeg" : "audio/wav",
      sourcePath: outPath,
      tool,
      meta: { sources: input.artifact_ids, gap_ms, loudnorm, total_duration_s: round(total, 3) },
    });
    return {
      artifact: artifactOut(ref),
      items: staged.length,
      gap_ms,
      loudnorm,
      total_duration_s: round(total, 3),
    };
  });
}

const audioConcat = defineTool({
  name: "local_audio_concat",
  description:
    "Join two or more library audio files end to end with local ffmpeg (for example per-turn speech into one podcast track). Optional silence gap between items and optional loudness normalisation to -16 LUFS / -1.5 dBTP. Video inputs contribute their audio track.",
  input: AudioConcatInput,
  annotations: { title: "Concatenate audio (ffmpeg)", ...ANNOT },
  longRunning: true,
  tags: ["local", "ffmpeg", "audio"],
  run: (input, ctx) => runAudioConcat(ctx, input),
});

// ---------------------------------------------------------------------------
// local_video_mux_audio
// ---------------------------------------------------------------------------

export const MuxInput = z.object({
  video_artifact_id: artifactId,
  audio_artifact_id: artifactId,
  mode: z
    .enum(["replace", "mix"])
    .optional()
    .describe("replace drops the video's own audio (default); mix blends the new audio with it."),
  audio_volume: z.number().min(0).max(4).optional(),
  original_volume: z
    .number()
    .min(0)
    .max(4)
    .optional()
    .describe("mix only: volume of the video's own audio."),
  end: z
    .enum(["video", "shortest"])
    .optional()
    .describe(
      "video (default): output is as long as the video, shorter audio is padded with silence. shortest: stop at the shorter of the two.",
    ),
});
export type MuxArgs = z.output<typeof MuxInput>;

const COPYABLE_VIDEO = new Set(["h264", "hevc", "mpeg4"]);

export function planMux(
  input: MuxArgs,
  video: MediaInfo,
  vPath: string,
  aPath: string,
): { args: string[]; durationS: number } {
  const mode = input.mode === "mix" && video.hasAudio ? "mix" : "replace";
  const end = input.end ?? "video";
  const vol = fixed(input.audio_volume ?? 1);
  const newAudio = `[1:a:0]${STEREO_44K},volume=${vol}${end === "video" ? ",apad" : ""}`;
  const graph =
    mode === "mix"
      ? `[0:a:0]${STEREO_44K},volume=${fixed(input.original_volume ?? 1)}[orig];${newAudio}[extra];[orig][extra]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[muxa]`
      : `${newAudio}[muxa]`;
  const copy = video.videoCodec !== null && COPYABLE_VIDEO.has(video.videoCodec);
  const durationS = Math.min(video.duration_s ?? MAX_OUTPUT_SECONDS, MAX_OUTPUT_SECONDS);
  return {
    durationS,
    args: [
      ...inputArgs(vPath),
      ...inputArgs(aPath),
      "-filter_complex",
      graph,
      "-map",
      "0:v:0",
      "-map",
      "[muxa]",
      ...(copy
        ? ["-c:v", "copy", ...(video.videoCodec === "hevc" ? ["-tag:v", "hvc1"] : [])]
        : ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p"]),
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-movflags",
      "+faststart",
      "-shortest",
      ...outputBounds(durationS + 0.2),
    ],
  };
}

const videoMux = defineTool({
  name: "local_video_mux_audio",
  description:
    "Put an audio artifact onto a video artifact with local ffmpeg: replace the video's audio or mix the two. The video stream is copied when it is H.264/HEVC, so this is fast and lossless for the picture.",
  input: MuxInput,
  annotations: { title: "Add audio to video (ffmpeg)", ...ANNOT },
  longRunning: true,
  tags: ["local", "ffmpeg", "video", "audio"],
  async run(input, ctx) {
    return withWorkDir(ctx, async (work) => {
      ctx.progress?.(0.05, "probing inputs");
      const v = await stageInput(ctx, work, input.video_artifact_id, 0);
      if (!v.info.hasVideo || v.info.isImage)
        throw new Error(`artifact ${input.video_artifact_id} is not a video`);
      const a = await stageInput(ctx, work, input.audio_artifact_id, 1);
      if (!a.info.hasAudio)
        throw new Error(`artifact ${input.audio_artifact_id} has no audio track`);
      const plan = planMux(input, v.info, v.path, a.path);
      const outPath = join(work, "out.mp4");
      ctx.progress?.(0.2, "muxing");
      await runFfmpeg(ctx, work, plan.args, outPath, {
        progress: { from: 0.2, to: 0.9, message: "muxing" },
      });
      const ref = await ctx.library.importFile({
        kind: "video",
        mime: "video/mp4",
        sourcePath: outPath,
        tool: "local_video_mux_audio",
        meta: {
          video: input.video_artifact_id,
          audio: input.audio_artifact_id,
          mode: input.mode ?? "replace",
        },
      });
      return {
        artifact: artifactOut(ref),
        mode: input.mode ?? "replace",
        duration_s: round(plan.durationS, 3),
      };
    });
  },
});

// ---------------------------------------------------------------------------
// local_video_burn_captions
// ---------------------------------------------------------------------------

// ASS colours are &HAABBGGRR.
export const CAPTION_COLORS = {
  white: "&H00FFFFFF",
  yellow: "&H0000FFFF",
  black: "&H00000000",
  red: "&H000000FF",
  green: "&H0000FF00",
  blue: "&H00FF0000",
  cyan: "&H00FFFF00",
  magenta: "&H00FF00FF",
  orange: "&H000080FF",
} as const;
const ALIGNMENT = { bottom: 2, middle: 5, top: 8 } as const;

export const CaptionsInput = z.object({
  video_artifact_id: artifactId,
  captions_artifact_id: artifactId.describe("An SRT or WebVTT file stored as an artifact."),
  position: z.enum(["bottom", "middle", "top"]).optional(),
  font_size: z
    .number()
    .int()
    .min(8)
    .max(60)
    .optional()
    .describe("Relative to a 288 px tall frame (libass default for SRT). Default 18."),
  color: z
    .enum(
      Object.keys(CAPTION_COLORS) as [
        keyof typeof CAPTION_COLORS,
        ...Array<keyof typeof CAPTION_COLORS>,
      ],
    )
    .optional(),
  outline_color: z
    .enum(
      Object.keys(CAPTION_COLORS) as [
        keyof typeof CAPTION_COLORS,
        ...Array<keyof typeof CAPTION_COLORS>,
      ],
    )
    .optional(),
  outline: z.number().min(0).max(6).optional(),
  margin: z.number().int().min(0).max(100).optional(),
  crf: z.number().int().min(16).max(35).optional(),
});
export type CaptionsArgs = z.output<typeof CaptionsInput>;

/** The `subtitles` filter for a caption file that sits in the work dir (cwd) under a fixed name. */
export function buildCaptionsFilter(
  file: "captions.srt" | "captions.vtt",
  o: CaptionsArgs,
): string {
  const style = [
    `Alignment=${ALIGNMENT[o.position ?? "bottom"]}`,
    `FontSize=${o.font_size ?? 18}`,
    `PrimaryColour=${CAPTION_COLORS[o.color ?? "white"]}`,
    `OutlineColour=${CAPTION_COLORS[o.outline_color ?? "black"]}`,
    "BorderStyle=1",
    `Outline=${fixed(o.outline ?? 2, 2)}`,
    "Shadow=0",
    `MarginV=${o.margin ?? 20}`,
  ].join(",");
  return `subtitles=filename=${escapeFilterText(file)}:force_style=${quoteFilterValue(style)}`;
}

const MAX_CAPTION_BYTES = 1024 * 1024;

export function captionFileFor(text: string): "captions.srt" | "captions.vtt" {
  if (/\[Script Info\]|\[V4\+? Styles\]|\[Events\]/i.test(text)) {
    throw new Error("styled ASS/SSA subtitles are not accepted; provide plain SRT or WebVTT");
  }
  return text.trimStart().startsWith("WEBVTT") ? "captions.vtt" : "captions.srt";
}

const MAX_CUES = 20_000;
const CUE_TIME =
  /^\s*((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,3}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

function cueSeconds(t: string): number {
  const parts = t.replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

function srtTime(s: number): string {
  const ms = Math.round(s * 1000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(Math.floor(ms / 3_600_000))}:${p(Math.floor(ms / 60_000) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`;
}

/**
 * Parse SRT or WebVTT cues and write them back as plain SRT. Everything that
 * is not a timed cue (headers, NOTE/STYLE blocks, any other format's syntax)
 * is dropped, and cue text loses override tags. Throws when no cue is found.
 */
export function canonicalCaptions(text: string): string {
  const blocks = text.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  const cues: string[] = [];
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => CUE_TIME.test(l));
    const m = at < 0 ? null : (lines[at] ?? "").match(CUE_TIME);
    if (!m) continue;
    const start = cueSeconds(m[1] ?? "");
    const end = cueSeconds(m[2] ?? "");
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    const body = lines
      .slice(at + 1)
      // ASS override blocks ({\an8}) and stray braces would restyle or confuse libass.
      .map((l) =>
        l
          .replace(/\{[^}]*\}/g, "")
          .replace(/[{}]/g, "")
          .trimEnd(),
      )
      .filter((l) => l.trim() !== "");
    if (body.length === 0) continue;
    cues.push(`${cues.length + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${body.join("\n")}\n`);
    if (cues.length > MAX_CUES) throw new Error(`captions have more than ${MAX_CUES} cues`);
  }
  if (cues.length === 0) {
    throw new Error("the captions artifact has no valid SRT or WebVTT cues (start --> end lines)");
  }
  return cues.join("\n");
}

async function hasSubtitlesFilter(ctx: PackContext): Promise<boolean> {
  const r = await run(ctx, "ffmpeg", ["-hide_banner", "-filters"], { timeoutMs: 15_000 });
  return /^\s*\S+\s+subtitles\s/m.test(r.stdout);
}

const burnCaptions = defineTool({
  name: "local_video_burn_captions",
  description:
    "Burn SRT or WebVTT captions (an artifact, for example from local_transcribe) into a video artifact with local ffmpeg. Needs an ffmpeg build with libass; local_status reports whether yours has it.",
  input: CaptionsInput,
  annotations: { title: "Burn captions (ffmpeg)", ...ANNOT },
  longRunning: true,
  tags: ["local", "ffmpeg", "video", "captions"],
  async run(input, ctx) {
    const problem = artifactIdProblem(input.captions_artifact_id);
    if (problem) throw new Error(problem);
    return withWorkDir(ctx, async (work) => {
      ctx.progress?.(0.05, "probing inputs");
      const v = await stageInput(ctx, work, input.video_artifact_id, 0);
      if (!v.info.hasVideo || v.info.isImage)
        throw new Error(`artifact ${input.video_artifact_id} is not a video`);
      const text = await readTextArtifact(ctx, input.captions_artifact_id, MAX_CAPTION_BYTES);
      captionFileFor(text); // refuses styled ASS/SSA
      // Only re-serialized SRT cues reach ffmpeg, never the artifact's raw
      // bytes: the subtitles filter probes the file's format, so raw text could
      // be read as another demuxer (for example ffconcat pointing at other files).
      const srt = canonicalCaptions(text);
      const file = "captions.srt";
      if (!(await hasSubtitlesFilter(ctx))) {
        throw new Error(HINTS.libass);
      }
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(work, file), srt);
      const durationS = boundedDuration(v.info.duration_s, undefined, undefined);
      const args = [
        ...inputArgs(v.path),
        "-map",
        "0:v:0",
        ...(v.info.hasAudio ? ["-map", "0:a:0"] : []),
        "-vf",
        buildCaptionsFilter(file, input),
        ...videoCodecArgs("mp4", input.crf ?? 20),
        ...outputBounds(durationS + 0.2),
      ];
      const outPath = join(work, "out.mp4");
      ctx.progress?.(0.2, "burning captions");
      await runFfmpeg(ctx, work, args, outPath, {
        progress: { from: 0.2, to: 0.9, message: "burning captions" },
      });
      const ref = await ctx.library.importFile({
        kind: "video",
        mime: "video/mp4",
        sourcePath: outPath,
        tool: "local_video_burn_captions",
        meta: { video: input.video_artifact_id, captions: input.captions_artifact_id },
      });
      return { artifact: artifactOut(ref), duration_s: round(durationS, 3) };
    });
  },
});

export const mediaTools = [
  mediaProbe,
  mediaConvert,
  audioMix,
  audioConcat,
  videoConcat,
  videoMux,
  burnCaptions,
];
