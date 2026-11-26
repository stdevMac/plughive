// packs/local/engines.ts
//
// Speech-to-text engines other than whisper.cpp. Each one reads the 16 kHz
// mono WAV that transcribe() (whisper.ts) prepares and returns text plus timed
// segments:
//  - parakeet-mlx: NVIDIA Parakeet on Apple silicon through MLX. Fast and
//    accurate, 25 languages detected on its own (no language option);
//  - Hex: `hex transcribe <file> --json`. Uses the running Hex app's local API,
//    or starts Hex's embedded service itself. Exit 3 means Hex could not be
//    reached, exit 4 means no speech. The local API itself is not called
//    directly: its port changes on every start, and a pack can only be granted
//    fixed host:port pairs;
//  - whisperX: faster-whisper with word alignment and, with a Hugging Face
//    token (secret HF_TOKEN), pyannote speaker labels.
// Which engine runs is the transcriptionEngine setting; "auto" picks the first
// installed one in engineOrder().
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PackContext } from "plughive/pack";
import { assertSafePath, run, stderrTail } from "./lib/ffmpeg.js";
import { binaryStatus } from "./lib/probe.js";
import { HINTS, LocalBackendError, round, settingString } from "./lib/util.js";

export const ENGINES = ["parakeet", "hex", "whisperx", "whisper.cpp"] as const;
export type Engine = (typeof ENGINES)[number];
export const ENGINE_SETTING_VALUES = ["auto", ...ENGINES] as const;
export type EngineSetting = (typeof ENGINE_SETTING_VALUES)[number];

export const ENGINE_BINARY: Record<Exclude<Engine, "whisper.cpp">, string> = {
  parakeet: "parakeet-mlx",
  hex: "hex",
  whisperx: "whisperx",
};
export const DEFAULT_PARAKEET_MODEL = "mlx-community/parakeet-tdt-0.6b-v3";
const ENGINE_TIMEOUT_MS = 30 * 60_000;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,159}$/;

/**
 * A spoken-language code exactly as it may reach an engine's command line:
 * "auto" or a 2-3 letter code with optional region/script tails (pt-BR,
 * zh-Hans). The capability schema accepts looser strings, so this is the hard
 * gate before any argv is built — no leading "-", no separators, no spaces.
 */
export const SPEECH_LANGUAGE = /^(auto|[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)$/;

export function speechLanguageProblem(language: string): string | null {
  return SPEECH_LANGUAGE.test(language)
    ? null
    : `"${language.slice(0, 40)}" is not a language code such as en, pt-BR or auto`;
}

export interface TranscriptSegment {
  start_s: number;
  end_s: number;
  text: string;
  speaker?: string;
}

export interface EngineResult {
  text: string;
  segments: TranscriptSegment[];
  language: string | null;
  model: string;
  /** An SRT the engine wrote itself; otherwise one is made from the segments. */
  srtPath?: string;
}

export interface EngineInput {
  /** Absolute path of the 16 kHz mono WAV. */
  wav: string;
  /** Work dir the engine may write into. */
  work: string;
  language?: string;
  model?: string;
  speakers?: boolean;
  duration_s: number;
}

/** The engines to try, best first. Speaker labels need whisperX. */
export function engineOrder(
  setting: EngineSetting,
  opts: { platform?: NodeJS.Platform; arch?: string; speakers?: boolean } = {},
): Engine[] {
  if (opts.speakers) return ["whisperx"];
  if (setting !== "auto") return [setting];
  const platform = opts.platform ?? process.platform;
  const arch = opts.arch ?? process.arch;
  return platform === "darwin" && arch === "arm64"
    ? ["parakeet", "hex", "whisper.cpp", "whisperx"]
    : ["whisper.cpp", "hex", "whisperx"];
}

export function engineSetting(ctx: PackContext): EngineSetting {
  const v = settingString(ctx, "transcriptionEngine");
  return (ENGINE_SETTING_VALUES as readonly string[]).includes(v ?? "")
    ? (v as EngineSetting)
    : "auto";
}

export const ENGINE_HINT: Record<Engine, string> = {
  parakeet: HINTS.parakeet,
  hex: HINTS.hex,
  whisperx: HINTS.whisperx,
  "whisper.cpp": HINTS.whisper,
};

/** Installed? (whisper.cpp is checked in whisper.ts, which also needs a model.) */
export function engineBinaryStatus(ctx: PackContext, engine: Exclude<Engine, "whisper.cpp">) {
  return binaryStatus(ctx, ENGINE_BINARY[engine], ENGINE_HINT[engine], ["--help"]);
}

function modelFor(ctx: PackContext, requested: string | undefined, setting: string) {
  const m = requested ?? settingString(ctx, setting);
  if (m === undefined) return undefined;
  if (!MODEL_ID.test(m)) throw new Error(`"${m.slice(0, 60)}" is not a valid model name`);
  return m;
}

const spokenLanguage = (l: string | undefined) => (l && l !== "auto" ? l : undefined);

function joinText(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

async function readOutput(path: string, engine: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error(`${engine} produced no transcript`);
    throw e;
  }
}

function parseJson<T>(raw: string, engine: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`${engine} wrote unreadable JSON`);
  }
}

// ---------------------------------------------------------------------------
// parakeet-mlx
// ---------------------------------------------------------------------------

interface ParakeetJson {
  text?: string;
  sentences?: Array<{ text?: string; start?: number; end?: number }>;
}

export function parseParakeetJson(raw: string): { text: string; segments: TranscriptSegment[] } {
  const data = parseJson<ParakeetJson>(raw, "parakeet-mlx");
  const segments: TranscriptSegment[] = [];
  for (const s of data.sentences ?? []) {
    const text = (s.text ?? "").trim();
    if (!text) continue;
    segments.push({ start_s: round(s.start ?? 0, 2), end_s: round(s.end ?? 0, 2), text });
  }
  return { text: (data.text ?? "").trim() || joinText(segments), segments };
}

export async function runParakeet(ctx: PackContext, input: EngineInput): Promise<EngineResult> {
  assertSafePath(input.wav);
  const model = modelFor(ctx, input.model, "parakeetModel") ?? DEFAULT_PARAKEET_MODEL;
  const r = await run(
    ctx,
    "parakeet-mlx",
    [
      input.wav,
      "--model",
      model,
      "--output-format",
      "json",
      "--output-dir",
      input.work,
      "--output-template",
      "parakeet",
    ],
    { timeoutMs: ENGINE_TIMEOUT_MS, cwd: input.work, hint: HINTS.parakeet },
  );
  if (r.exitCode !== 0) {
    throw new Error(
      `parakeet-mlx failed (exit ${r.exitCode}): ${stderrTail(r.stderr) || "no output"}`,
    );
  }
  const parsed = parseParakeetJson(
    await readOutput(join(input.work, "parakeet.json"), "parakeet-mlx"),
  );
  return { ...parsed, language: spokenLanguage(input.language) ?? null, model };
}

// ---------------------------------------------------------------------------
// Hex
// ---------------------------------------------------------------------------

/** Where Hex keeps local-api.json and its models (spawned tools get a HOME of the pack's own). */
export function hexSupportDir(platform: NodeJS.Platform = process.platform, home = homedir()) {
  if (platform === "darwin") return join(home, "Library", "Application Support", "hex");
  if (platform === "win32") return join(home, "AppData", "Roaming", "hex");
  return join(home, ".local", "share", "hex");
}

interface HexJson {
  status?: string;
  text?: string;
  code?: string;
  message?: string;
}

/** The last JSON line hex printed (it prints one object with --json). */
export function parseHexOutput(stdout: string): HexJson | null {
  const lines = stdout.split(/\r?\n/).filter((l) => l.trim().startsWith("{"));
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i] as string) as HexJson;
    } catch {
      /* not JSON */
    }
  }
  return null;
}

export async function runHex(ctx: PackContext, input: EngineInput): Promise<EngineResult> {
  assertSafePath(input.wav);
  const model = modelFor(ctx, input.model, "hexModel");
  const language = spokenLanguage(input.language);
  const r = await run(
    ctx,
    "hex",
    [
      "transcribe",
      input.wav,
      "--json",
      ...(model ? ["--model", model] : []),
      ...(language ? ["--language", language] : []),
    ],
    {
      timeoutMs: ENGINE_TIMEOUT_MS,
      cwd: input.work,
      hint: HINTS.hex,
      env: { HEX_APPLICATION_SUPPORT_DIR: hexSupportDir() },
    },
  );
  const out = parseHexOutput(r.stdout);
  const name = model ?? "hex";
  if (r.exitCode === 4) return { text: "", segments: [], language: language ?? null, model: name };
  if (r.exitCode === 3) {
    throw new LocalBackendError(
      `Hex is not running and could not start its transcription service${out?.message ? ` (${out.message.slice(0, 200)})` : ""}. Open Hex once and download a model. ${HINTS.hex}`,
    );
  }
  if (r.exitCode !== 0 || out?.status !== "transcript") {
    const why = out?.message ?? (stderrTail(r.stderr) || "no output");
    throw new Error(`hex transcribe failed (exit ${r.exitCode}): ${why.slice(0, 300)}`);
  }
  const text = (out.text ?? "").trim();
  return {
    text,
    segments: text ? [{ start_s: 0, end_s: round(input.duration_s, 2), text }] : [],
    language: language ?? null,
    model: name,
  };
}

// ---------------------------------------------------------------------------
// whisperX
// ---------------------------------------------------------------------------

interface WhisperxJson {
  language?: string;
  segments?: Array<{ start?: number; end?: number; text?: string; speaker?: string }>;
}

export function parseWhisperxJson(raw: string): {
  text: string;
  segments: TranscriptSegment[];
  language: string | null;
} {
  const data = parseJson<WhisperxJson>(raw, "whisperx");
  const segments: TranscriptSegment[] = [];
  for (const s of data.segments ?? []) {
    const text = (s.text ?? "").trim();
    if (!text) continue;
    segments.push({
      start_s: round(s.start ?? 0, 2),
      end_s: round(s.end ?? 0, 2),
      text,
      ...(typeof s.speaker === "string" ? { speaker: s.speaker } : {}),
    });
  }
  return { text: joinText(segments), segments, language: data.language ?? null };
}

export async function runWhisperx(ctx: PackContext, input: EngineInput): Promise<EngineResult> {
  assertSafePath(input.wav);
  const model = modelFor(ctx, input.model, "whisperxModel");
  const language = spokenLanguage(input.language);
  const env: Record<string, string> = {};
  if (input.speakers) {
    if (!(await ctx.secrets.has("HF_TOKEN"))) {
      throw new LocalBackendError(
        `Speaker labels need the local pack secret HF_TOKEN. ${HINTS.whisperx}`,
      );
    }
    // Passed in the environment, never on the command line (where ps would show it).
    env.HF_TOKEN = await ctx.secrets.get("HF_TOKEN");
  }
  const r = await run(
    ctx,
    "whisperx",
    [
      input.wav,
      "--output_format",
      "json",
      "--output_dir",
      input.work,
      "--compute_type",
      "int8",
      ...(model ? ["--model", model] : []),
      ...(language ? ["--language", language] : []),
      ...(input.speakers ? ["--diarize"] : []),
    ],
    { timeoutMs: ENGINE_TIMEOUT_MS, cwd: input.work, hint: HINTS.whisperx, env },
  );
  if (r.exitCode !== 0) {
    throw new Error(`whisperx failed (exit ${r.exitCode}): ${stderrTail(r.stderr) || "no output"}`);
  }
  // whisperx names the output after the input file: speech.wav -> speech.json.
  const base = input.wav.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "");
  const parsed = parseWhisperxJson(await readOutput(join(input.work, `${base}.json`), "whisperx"));
  return {
    ...parsed,
    language: parsed.language ?? language ?? null,
    model: model ?? "whisperx",
  };
}

// ---------------------------------------------------------------------------
// SRT
// ---------------------------------------------------------------------------

function srtTime(seconds: number): string {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

export function toSrt(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((s, i) => {
      const text = s.speaker ? `[${s.speaker}] ${s.text}` : s.text;
      return `${i + 1}\n${srtTime(s.start_s)} --> ${srtTime(Math.max(s.end_s, s.start_s))}\n${text}\n`;
    })
    .join("\n");
}

export async function writeSrt(path: string, segments: readonly TranscriptSegment[]) {
  await writeFile(path, toSrt(segments), "utf8");
  return path;
}
