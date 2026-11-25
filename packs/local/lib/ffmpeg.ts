// packs/local/lib/ffmpeg.ts
//
// ffmpeg / ffprobe plumbing. The rules every caller relies on:
//  - inputs are library artifact ids only. Each one is linked (or written) into
//    a fresh work dir under a fixed name (`in0.mp4`), so an ffmpeg input path
//    is always absolute, starts with "/" and contains only characters this
//    module chose. A user string never becomes an ffmpeg option or filter text;
//  - every `-i` is preceded by `-protocol_whitelist file,pipe`, and every input
//    is probed first and rejected when its container is a playlist, concat
//    list or network demuxer (those can name other files or hosts);
//  - filter graphs are built from validated enums and numbers only;
//  - duration, resolution and output size are bounded.
import { copyFile, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, relative } from "node:path";
import type { ArtifactRecord, PackContext } from "plughive/pack";
import { ARTIFACT_ID, HINTS, LocalBackendError, cancelled, throwIfCancelled } from "./util.js";

export const MAX_OUTPUT_SECONDS = 1800;
export const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;
export const MAX_OUTPUT_DIM = 4096;
export const MAX_INPUT_DIM = 8192;
export const FFMPEG_TIMEOUT_MS = 15 * 60_000;
export const PROBE_TIMEOUT_MS = 30_000;
const STDERR_CAP = 1024 * 1024;

export const PROTOCOLS = ["-protocol_whitelist", "file,pipe"] as const;

// ---------------------------------------------------------------------------
// Running binaries
// ---------------------------------------------------------------------------

const MISSING = /could not (start|find|resolve)|ENOENT|not found|no such file|not installed/i;

interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  input?: string | Uint8Array;
  hint?: string;
  onStderr?: (line: string) => void;
  env?: Record<string, string>;
  maxOutputBytes?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** ctx.spawn with missing-binary, timeout, truncation and cancel mapped to clear errors. */
export async function run(
  ctx: PackContext,
  binary: string,
  args: readonly string[],
  opts: RunOptions = {},
): Promise<RunResult> {
  const hint = opts.hint ?? HINTS.ffmpeg;
  let r: RunResult & { timedOut?: boolean; truncated?: boolean };
  try {
    r = await ctx.spawn(binary, args, {
      timeoutMs: opts.timeoutMs ?? FFMPEG_TIMEOUT_MS,
      maxOutputBytes: opts.maxOutputBytes ?? STDERR_CAP,
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      ...(opts.input !== undefined ? { input: opts.input } : {}),
      ...(opts.onStderr ? { onStderr: opts.onStderr } : {}),
    });
  } catch (e) {
    if (cancelled(ctx)) throw new Error("cancelled");
    const msg = (e as Error).message ?? String(e);
    if (MISSING.test(msg)) {
      throw new LocalBackendError(`${binary} is not available (${msg.slice(0, 200)}). ${hint}`);
    }
    throw e;
  }
  if (cancelled(ctx)) throw new Error("cancelled");
  if (r.timedOut)
    throw new Error(`${binary} timed out after ${(opts.timeoutMs ?? FFMPEG_TIMEOUT_MS) / 1000} s`);
  if (r.exitCode === 127 || (r.exitCode !== 0 && MISSING.test(r.stderr) && !r.stdout)) {
    throw new LocalBackendError(`${binary} is not available. ${hint}`);
  }
  return r;
}

/** A `-stats` progress line ("frame= ... time=00:00:01.23 ... speed=1x"). */
const STATS_LINE = /\btime=\s*(-?\d+):(\d{2}):(\d{2}(?:\.\d+)?)/;

/** Seconds of output ffmpeg reports in a `-stats` line, or null. */
export function statsSeconds(line: string): number | null {
  const m = line.match(STATS_LINE);
  if (!m || !/\bspeed=|\bbitrate=|\bsize=/.test(line)) return null;
  const s = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(s) && s >= 0 ? s : null;
}

/** Last meaningful lines of ffmpeg stderr, for error messages (progress lines dropped). */
export function stderrTail(stderr: string, lines = 4): string {
  return stderr
    .split(/[\r\n]+/)
    .map((l) => l.trim())
    .filter((l) => l !== "" && statsSeconds(l) === null)
    .slice(-lines)
    .join(" | ")
    .slice(0, 500);
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

export interface StreamInfo {
  index: number;
  type: string;
  codec: string | null;
  width?: number;
  height?: number;
  fps?: number;
  sample_rate?: number;
  channels?: number;
  duration_s?: number;
}

export interface MediaInfo {
  format: string;
  duration_s: number | null;
  size_bytes: number | null;
  bit_rate: number | null;
  hasVideo: boolean;
  hasAudio: boolean;
  isImage: boolean;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  streams: StreamInfo[];
}

const ALLOWED_FORMATS = new Set([
  "mov",
  "mp4",
  "m4a",
  "3gp",
  "3g2",
  "mj2",
  "matroska",
  "webm",
  "avi",
  "mpegts",
  "mpeg",
  "mpegvideo",
  "flv",
  "mp3",
  "wav",
  "w64",
  "flac",
  "ogg",
  "opus",
  "aac",
  "aiff",
  "caf",
  "ac3",
  "amr",
  "gif",
  "apng",
  "image2",
  "asf",
  "wtv",
  // Single-image pipes, enumerated: a blanket `*_pipe` match would admit
  // svg_pipe (librsvg, which can pull in other resources) and many rarely
  // used parsers.
  "png_pipe",
  "jpeg_pipe",
  "webp_pipe",
  "bmp_pipe",
  "tiff_pipe",
  "gif_pipe",
  "qoi_pipe",
  "jpegxl_pipe",
]);
const DENIED_FORMATS = new Set([
  "hls",
  "applehttp",
  "concat",
  "ffconcat",
  "sdp",
  "rtsp",
  "rtp",
  "dash",
  "ffmetadata",
  "srt",
  "webvtt",
  "ass",
  "lavfi",
  "tee",
]);

export function formatProblem(formatName: string): string | null {
  const tokens = formatName.split(",").map((t) => t.trim());
  const denied = tokens.find((t) => DENIED_FORMATS.has(t));
  if (denied)
    return `container format "${denied}" is not accepted (playlists and lists can reference other files)`;
  if (!tokens.some((t) => ALLOWED_FORMATS.has(t))) {
    return `container format "${formatName}" is not a supported audio, video or image format`;
  }
  return null;
}

function num(v: unknown): number | null {
  const n = typeof v === "string" || typeof v === "number" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

function rate(v: unknown): number | undefined {
  if (typeof v !== "string") return undefined;
  const [a, b] = v.split("/").map(Number);
  if (a === undefined || b === undefined || !b || !Number.isFinite(a / b)) return undefined;
  const r = a / b;
  return r > 0 && r < 1000 ? Math.round(r * 1000) / 1000 : undefined;
}

export function parseProbe(raw: unknown): MediaInfo {
  const j = (raw ?? {}) as {
    format?: Record<string, unknown>;
    streams?: Array<Record<string, unknown>>;
  };
  const fmt = j.format ?? {};
  const streams: StreamInfo[] = (j.streams ?? []).map((s) => {
    const info: StreamInfo = {
      index: Number(s.index ?? 0),
      type: String(s.codec_type ?? "unknown"),
      codec: typeof s.codec_name === "string" ? s.codec_name : null,
    };
    const w = num(s.width);
    const h = num(s.height);
    if (w) info.width = w;
    if (h) info.height = h;
    const fps = rate(s.avg_frame_rate) ?? rate(s.r_frame_rate);
    if (fps && info.type === "video") info.fps = fps;
    const sr = num(s.sample_rate);
    if (sr) info.sample_rate = sr;
    const ch = num(s.channels);
    if (ch) info.channels = ch;
    const d = num(s.duration);
    if (d !== null) info.duration_s = d;
    if ((s.disposition as { attached_pic?: number } | undefined)?.attached_pic === 1) {
      info.type = "cover_art";
    }
    return info;
  });
  const video = streams.find((s) => s.type === "video");
  const audio = streams.find((s) => s.type === "audio");
  const format = String(fmt.format_name ?? "");
  const duration = num(fmt.duration) ?? video?.duration_s ?? audio?.duration_s ?? null;
  return {
    format,
    duration_s: duration,
    size_bytes: num(fmt.size),
    bit_rate: num(fmt.bit_rate),
    hasVideo: video !== undefined,
    hasAudio: audio !== undefined,
    isImage: video !== undefined && (/image2|_pipe/.test(format) || num(fmt.duration) === null),
    width: video?.width ?? null,
    height: video?.height ?? null,
    fps: video?.fps ?? null,
    videoCodec: video?.codec ?? null,
    audioCodec: audio?.codec ?? null,
    streams,
  };
}

export async function probeFile(ctx: PackContext, path: string): Promise<MediaInfo> {
  assertSafePath(path);
  const r = await run(
    ctx,
    "ffprobe",
    [
      "-v",
      "error",
      "-hide_banner",
      ...PROTOCOLS,
      "-print_format",
      "json",
      "-show_format",
      "-show_streams",
      "-i",
      path,
    ],
    { timeoutMs: PROBE_TIMEOUT_MS },
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `could not read this file as media: ${stderrTail(r.stderr, 2) || `ffprobe exit ${r.exitCode}`}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new Error("ffprobe returned unreadable output");
  }
  const info = parseProbe(json);
  const problem = formatProblem(info.format);
  if (problem) throw new Error(problem);
  if ((info.width ?? 0) > MAX_INPUT_DIM || (info.height ?? 0) > MAX_INPUT_DIM) {
    throw new Error(`input is larger than ${MAX_INPUT_DIM} pixels on a side`);
  }
  return info;
}

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** Paths handed to ffmpeg must be absolute, free of control characters and never look like an option. */
export function assertSafePath(p: string): void {
  if (!isAbsolute(p) || /[\0\r\n]/.test(p) || p.startsWith("-")) {
    throw new Error("internal error: unsafe media path");
  }
}

export interface StagedInput {
  /** Absolute path inside the work dir. */
  path: string;
  record: ArtifactRecord;
  info: MediaInfo;
}

export function artifactIdProblem(id: string): string | null {
  return ARTIFACT_ID.test(id)
    ? null
    : `"${id.slice(0, 40)}" is not an artifact id (artifact ids only, no paths or URLs)`;
}

const MIME_EXT: Record<string, string> = {
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "video/x-matroska": ".mkv",
  "audio/mpeg": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/flac": ".flac",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
  "audio/aac": ".aac",
  "audio/opus": ".opus",
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "application/x-subrip": ".srt",
  "text/vtt": ".vtt",
};

function extForMime(mime: string | undefined): string {
  return MIME_EXT[((mime ?? "").split(";")[0] ?? "").trim().toLowerCase()] ?? "";
}

/** Copy the artifact into the work dir as `in<index><ext>` and probe it. */
export async function stageInput(
  ctx: PackContext,
  work: string,
  artifactId: string,
  index: number,
  opts: { probe?: boolean } = {},
): Promise<StagedInput> {
  const problem = artifactIdProblem(artifactId);
  if (problem) throw new Error(problem);
  const record = await ctx.library.get(artifactId);
  if (!record) throw new Error(`artifact not found: ${artifactId}`);
  const ext = extForMime(record.mime);
  const dest = join(work, `in${index}${ext}`);
  // Streamed (or reflinked) by the kernel into the work dir, never loaded into
  // memory, then given the fixed name this module chose.
  const copy = await ctx.library.materialize(artifactId, { dir: relative(ctx.pack.dataDir, work) });
  await rename(copy.path, dest);
  const info = opts.probe === false ? emptyInfo() : await probeFile(ctx, dest);
  return { path: dest, record, info };
}

function emptyInfo(): MediaInfo {
  return {
    format: "",
    duration_s: null,
    size_bytes: null,
    bit_rate: null,
    hasVideo: false,
    hasAudio: false,
    isImage: false,
    width: null,
    height: null,
    fps: null,
    videoCodec: null,
    audioCodec: null,
    streams: [],
  };
}

/** Read a text artifact (captions) with a size cap. */
export async function readTextArtifact(
  ctx: PackContext,
  artifactId: string,
  maxBytes: number,
): Promise<string> {
  const problem = artifactIdProblem(artifactId);
  if (problem) throw new Error(problem);
  const record = await ctx.library.get(artifactId);
  if (!record) throw new Error(`artifact not found: ${artifactId}`);
  if (record.bytes > maxBytes)
    throw new Error(`artifact ${artifactId} is larger than ${maxBytes} bytes`);
  const bytes = await ctx.library.read(artifactId);
  if (bytes.byteLength > maxBytes)
    throw new Error(`artifact ${artifactId} is larger than ${maxBytes} bytes`);
  return Buffer.from(bytes).toString("utf8").replace(/^﻿/, "");
}

// ---------------------------------------------------------------------------
// Running ffmpeg and importing the result
// ---------------------------------------------------------------------------

export const BASE_ARGS = ["-hide_banner", "-nostdin", "-loglevel", "error", "-y"] as const;

/** `-protocol_whitelist file,pipe -i <path>` with optional input options first. */
export function inputArgs(path: string, pre: readonly string[] = []): string[] {
  assertSafePath(path);
  return [...pre, ...PROTOCOLS, "-i", path];
}

/** Options that bound the output file. Place them directly before the output path. */
export function outputBounds(seconds: number): string[] {
  return ["-t", fixed(Math.min(seconds, MAX_OUTPUT_SECONDS), 3), "-fs", String(MAX_OUTPUT_BYTES)];
}

export interface FfmpegProgress {
  /** Fraction reported when ffmpeg starts and when it finishes. */
  from: number;
  to: number;
  message: string;
}

/** Output length ffmpeg was bounded to: the last `-t` before the output path. */
function boundedSeconds(args: readonly string[]): number | null {
  const i = args.lastIndexOf("-t");
  const s = i >= 0 ? Number(args[i + 1]) : Number.NaN;
  return Number.isFinite(s) && s > 0 ? s : null;
}

/**
 * Run ffmpeg into `outPath`. With `progress`, ffmpeg's `-stats` lines on
 * stderr are turned into ctx.progress calls between the from and to fractions (at most
 * one per percent), measured against the output's `-t` bound.
 */
export async function runFfmpeg(
  ctx: PackContext,
  work: string,
  args: readonly string[],
  outPath: string,
  opts: { progress?: FfmpegProgress } = {},
): Promise<number> {
  assertSafePath(outPath);
  const p = opts.progress;
  const total = p ? boundedSeconds(args) : null;
  let last = -1;
  const onStderr =
    p && total
      ? (line: string) => {
          const s = statsSeconds(line);
          if (s === null) return;
          const pct = Math.floor(Math.min(1, s / total) * 100);
          if (pct <= last) return;
          last = pct;
          ctx.progress?.(p.from + ((p.to - p.from) * pct) / 100, `${p.message} ${pct}%`);
        }
      : undefined;
  const r = await run(
    ctx,
    "ffmpeg",
    [...BASE_ARGS, ...(onStderr ? ["-stats"] : []), ...args, outPath],
    {
      cwd: work,
      ...(onStderr ? { onStderr } : {}),
    },
  );
  if (r.exitCode !== 0) {
    throw new Error(`ffmpeg failed (exit ${r.exitCode}): ${stderrTail(r.stderr) || "no output"}`);
  }
  let size = 0;
  try {
    size = (await stat(outPath)).size;
  } catch {
    throw new Error(`ffmpeg produced no output${r.stderr ? `: ${stderrTail(r.stderr)}` : ""}`);
  }
  if (size === 0)
    throw new Error(
      "ffmpeg produced an empty file (the requested range may be past the end of the input)",
    );
  if (size >= MAX_OUTPUT_BYTES) {
    throw new Error(
      `output reached the ${MAX_OUTPUT_BYTES / (1024 * 1024)} MiB cap; use a shorter range or smaller size`,
    );
  }
  return size;
}

export async function copyInto(src: string, dest: string): Promise<void> {
  await copyFile(src, dest);
}

export async function readSmall(path: string): Promise<Buffer> {
  return readFile(path);
}

// ---------------------------------------------------------------------------
// Filter syntax helpers
// ---------------------------------------------------------------------------

/** Plain decimal (never exponent notation) with trailing zeros removed. */
export function fixed(n: number, places = 4): string {
  if (!Number.isFinite(n)) throw new Error("internal error: non-finite number in filter");
  const s = n.toFixed(places);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}

/**
 * Escape text for use as one filter option value or as a filename inside a
 * filtergraph: backslash-escapes every character that has meaning at either
 * level of ffmpeg's filter parsing (`\ ' : , ; [ ] = ` and whitespace/control).
 */
export function escapeFilterText(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are escaped on purpose
  return text.replace(/[\\':,;[\]=\s\u0000-\u001f]/g, (c) => `\\${c}`);
}

/** Wrap a value in single quotes for the filter option level, escaping embedded quotes. */
export function quoteFilterValue(text: string): string {
  return `'${text.replace(/'/g, "'\\''")}'`;
}

// ---------------------------------------------------------------------------
// Presets and codecs
// ---------------------------------------------------------------------------

export const ASPECTS = {
  "9:16": { width: 1080, height: 1920 },
  "16:9": { width: 1920, height: 1080 },
  "1:1": { width: 1080, height: 1080 },
} as const;
export type Aspect = keyof typeof ASPECTS;

export const VIDEO_FORMATS = ["mp4", "mov", "mkv", "webm"] as const;
export const AUDIO_FORMATS = ["mp3", "wav", "m4a", "flac", "ogg"] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];
export type AudioFormat = (typeof AUDIO_FORMATS)[number];

export const VIDEO_MIME: Record<VideoFormat, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  mkv: "video/x-matroska",
  webm: "video/webm",
};
export const AUDIO_MIME: Record<AudioFormat, string> = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  m4a: "audio/mp4",
  flac: "audio/flac",
  ogg: "audio/ogg",
};

export function videoCodecArgs(format: VideoFormat, crf: number): string[] {
  if (format === "webm") {
    return [
      "-c:v",
      "libvpx-vp9",
      "-crf",
      String(crf),
      "-b:v",
      "0",
      "-row-mt",
      "1",
      "-cpu-used",
      "4",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "libopus",
      "-b:a",
      "128k",
    ];
  }
  const args = [
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    String(crf),
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-b:a",
    "160k",
  ];
  if (format === "mp4" || format === "mov") args.push("-movflags", "+faststart");
  return args;
}

export function audioCodecArgs(format: AudioFormat): string[] {
  switch (format) {
    case "mp3":
      return ["-c:a", "libmp3lame", "-q:a", "2"];
    case "wav":
      return ["-c:a", "pcm_s16le"];
    case "m4a":
      return ["-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart"];
    case "flac":
      return ["-c:a", "flac"];
    case "ogg":
      return ["-c:a", "libopus", "-b:a", "128k"];
  }
}

/** Even-pixel scale expression pair for `scale=`; missing side keeps aspect (-2 = even). */
export function scaleFilter(width?: number, height?: number): string {
  if (width && height) {
    return `scale=${width}:${height}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  }
  return `scale=${width ?? -2}:${height ?? -2}`;
}

export function reframeFilter(aspect: Aspect, fit: "cover" | "contain"): string {
  const { width: w, height: h } = ASPECTS[aspect];
  return fit === "cover"
    ? `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`
    : `scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1`;
}

/** Throws unless the work is within the duration cap. */
export function boundedDuration(
  inputDuration: number | null,
  start: number | undefined,
  requested: number | undefined,
): number {
  if (requested !== undefined) return Math.min(requested, MAX_OUTPUT_SECONDS);
  if (inputDuration === null) return MAX_OUTPUT_SECONDS;
  const remaining = Math.max(0, inputDuration - (start ?? 0));
  if (remaining > MAX_OUTPUT_SECONDS) {
    throw new Error(
      `the selected range is ${Math.round(remaining)} s, over the ${MAX_OUTPUT_SECONDS} s limit; pass duration_s (at most ${MAX_OUTPUT_SECONDS})`,
    );
  }
  return remaining > 0 ? remaining : MAX_OUTPUT_SECONDS;
}

export { throwIfCancelled };
