// packs/local/whisper.ts
//
// Speech to text. The input artifact is converted to 16 kHz mono WAV with
// ffmpeg first, then the chosen engine runs on it: whisper.cpp (here; whisper-cli
// writes JSON and SRT next to the WAV) or parakeet-mlx, Hex or whisperX
// (engines.ts).
import { readFile, readdir, stat } from "node:fs/promises";
import { availableParallelism, homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { defineTool, z } from "plughive/pack";
import type { PackContext } from "plughive/pack";
import {
  ENGINE_HINT,
  ENGINE_SETTING_VALUES,
  type Engine,
  type EngineInput,
  type EngineResult,
  type TranscriptSegment,
  engineBinaryStatus,
  engineOrder,
  engineSetting,
  runHex,
  runParakeet,
  runWhisperx,
  writeSrt,
} from "./engines.js";
import {
  assertSafePath,
  boundedDuration,
  inputArgs,
  outputBounds,
  run,
  runFfmpeg,
  stageInput,
  stderrTail,
} from "./lib/ffmpeg.js";
import { binaryStatus } from "./lib/probe.js";
import {
  ARTIFACT_ID,
  HINTS,
  LocalBackendError,
  artifactOut,
  round,
  settingString,
  throwIfCancelled,
  withWorkDir,
} from "./lib/util.js";

export const WHISPER_BINARIES = ["whisper-cli", "whisper-cpp"] as const;
const WHISPER_TIMEOUT_MS = 30 * 60_000;
const MODEL_FILE = /\.(bin|gguf)$/i;
const LANGUAGE = /^(auto|[a-z]{2,3})$/;

export function modelDirs(ctx: PackContext): string[] {
  const home = homedir();
  return [
    join(home, ".cache", "whisper.cpp"),
    join(home, "whisper.cpp", "models"),
    join(ctx.pack.dataDir, "models"),
  ];
}

/** Rank model files: multilingual base first, then any ggml file, alphabetically. */
export function pickModel(files: readonly string[]): string | undefined {
  const usable = files
    .filter((f) => MODEL_FILE.test(f) && !/silero|vad|encoder|coreml/i.test(f))
    .sort();
  return (
    usable.find((f) => /ggml-base\.(bin)$/.test(f)) ??
    usable.find((f) => /base/.test(f)) ??
    usable[0]
  );
}

export async function findModels(ctx: PackContext): Promise<string[]> {
  const found: string[] = [];
  for (const dir of modelDirs(ctx)) {
    try {
      const names = await readdir(dir);
      for (const n of names) if (MODEL_FILE.test(n)) found.push(join(dir, n));
    } catch {
      /* directory absent */
    }
  }
  return found;
}

/** The configured model path, validated, or the best discovered one. */
export async function resolveWhisperModel(ctx: PackContext): Promise<string> {
  const configured = settingString(ctx, "whisperModelPath");
  if (configured) {
    if (!isAbsolute(configured) || !MODEL_FILE.test(configured) || configured.includes("\0")) {
      throw new Error(
        "setting whisperModelPath must be an absolute path to a ggml .bin (or .gguf) model file",
      );
    }
    try {
      if (!(await stat(configured)).isFile()) throw new Error("not a file");
    } catch {
      throw new LocalBackendError(`whisper model not found at ${configured}. ${HINTS.whisper}`);
    }
    return configured;
  }
  const model = pickModel(await findModels(ctx));
  if (!model) {
    throw new LocalBackendError(
      `No whisper.cpp model found (looked in ${modelDirs(ctx).join(", ")}). ${HINTS.whisper}`,
    );
  }
  return model;
}

export type Segment = TranscriptSegment;

interface WhisperJson {
  result?: { language?: string };
  transcription?: Array<{ offsets?: { from?: number; to?: number }; text?: string }>;
}

export function parseWhisperJson(raw: string): {
  text: string;
  segments: Segment[];
  language: string | null;
} {
  let data: WhisperJson;
  try {
    data = JSON.parse(raw) as WhisperJson;
  } catch {
    throw new Error("whisper-cli wrote unreadable JSON");
  }
  const segments: Segment[] = [];
  for (const s of data.transcription ?? []) {
    const text = (s.text ?? "").trim();
    if (!text) continue;
    segments.push({
      start_s: round((s.offsets?.from ?? 0) / 1000, 2),
      end_s: round((s.offsets?.to ?? 0) / 1000, 2),
      text,
    });
  }
  return {
    text: segments.map((s) => s.text).join(" "),
    segments,
    language: data.result?.language ?? null,
  };
}

export function whisperArgs(
  model: string,
  wav: string,
  outBase: string,
  language: string | undefined,
  threads: number,
): string[] {
  assertSafePath(model);
  assertSafePath(wav);
  assertSafePath(outBase);
  return [
    "-m",
    model,
    "-f",
    wav,
    "-oj",
    "-osrt",
    "-of",
    outBase,
    "-np",
    "-t",
    String(threads),
    "-l",
    language ?? "auto",
  ];
}

/** Run whisper-cli, falling back to the whisper-cpp name when the first binary is missing. */
export async function runWhisper(ctx: PackContext, args: readonly string[], cwd: string) {
  let lastMissing: unknown;
  for (const bin of WHISPER_BINARIES) {
    try {
      return await run(ctx, bin, args, { timeoutMs: WHISPER_TIMEOUT_MS, cwd, hint: HINTS.whisper });
    } catch (e) {
      if (e instanceof LocalBackendError) {
        lastMissing = e;
        continue;
      }
      throw e;
    }
  }
  throw lastMissing;
}

export const TranscribeInput = z.object({
  artifact_id: z.string().regex(ARTIFACT_ID, "an artifact id, not a path"),
  language: z.string().regex(LANGUAGE, "a two or three letter code such as en, or auto").optional(),
  engine: z
    .enum(ENGINE_SETTING_VALUES)
    .optional()
    .describe(
      "Speech engine. Default: the transcriptionEngine setting (auto picks parakeet-mlx on Apple silicon, else whisper.cpp, then Hex or whisperX, whichever is installed).",
    ),
  speakers: z
    .boolean()
    .optional()
    .describe("Label speakers. Needs whisperX and the local pack secret HF_TOKEN."),
});
export type TranscribeArgs = z.output<typeof TranscribeInput> & { model?: string };

/** whisper.cpp is usable when a binary answers and a model is set or found. */
export async function whisperCppAvailable(ctx: PackContext): Promise<boolean> {
  let binary = false;
  for (const bin of WHISPER_BINARIES) {
    if ((await binaryStatus(ctx, bin, HINTS.whisper, ["--help"])).available) {
      binary = true;
      break;
    }
  }
  if (!binary) return false;
  return resolveWhisperModel(ctx).then(
    () => true,
    () => false,
  );
}

export async function engineAvailable(ctx: PackContext, engine: Engine): Promise<boolean> {
  if (engine === "whisper.cpp") return whisperCppAvailable(ctx);
  if (engine === "parakeet" && !(process.platform === "darwin" && process.arch === "arm64"))
    return false;
  return (await engineBinaryStatus(ctx, engine)).available;
}

/**
 * The engines this call may use, in order. A forced engine (argument or
 * setting) is used as is, so its own error explains what is missing; in auto
 * mode only installed engines are kept.
 */
export async function planEngines(
  ctx: PackContext,
  input: { engine?: string | undefined; speakers?: boolean | undefined },
): Promise<Engine[]> {
  const choice = (input.engine as Engine | "auto" | undefined) ?? engineSetting(ctx);
  const order = engineOrder(choice, { speakers: input.speakers === true });
  if (choice !== "auto" || input.speakers) return order;
  const usable: Engine[] = [];
  for (const e of order) if (await engineAvailable(ctx, e)) usable.push(e);
  if (usable.length === 0) {
    throw new LocalBackendError(
      `No speech-to-text engine is installed. ${order.map((e) => ENGINE_HINT[e]).join(" Or: ")}`,
    );
  }
  return usable;
}

const GPU_ERROR = /metal|cuda|cublas|vulkan|rocm|ggml_backend|\bgpu\b|\bhip\b|out of memory/i;

/**
 * True when a failed whisper-cli run looks like a GPU problem worth one CPU
 * retry: it was killed by a signal (exit -1, typically a driver crash) or its
 * stderr names a GPU backend. Bad input fails the same way on the CPU, so
 * other failures are not retried.
 */
export function gpuFailure(r: { exitCode: number; stderr: string }): boolean {
  if (r.exitCode === 0) return false;
  return r.exitCode === -1 || GPU_ERROR.test(r.stderr);
}

async function runWhisperCpp(ctx: PackContext, input: EngineInput): Promise<EngineResult> {
  const model = await resolveWhisperModel(ctx);
  const outBase = join(input.work, "transcript");
  const threads = Math.max(1, Math.min(8, availableParallelism()));
  const args = whisperArgs(model, input.wav, outBase, input.language, threads);
  let r = await runWhisper(ctx, args, input.work);
  if (gpuFailure(r)) {
    // A GPU build can crash or fail to set up Metal/CUDA/Vulkan on some
    // machines; the same binary runs fine on the CPU with -ng (--no-gpu).
    ctx.logger.warn("whisper-cli failed on the GPU; retrying on the CPU (-ng)");
    r = await runWhisper(ctx, [...args, "-ng"], input.work);
  }
  if (r.exitCode !== 0) {
    throw new Error(
      `whisper-cli failed (exit ${r.exitCode}): ${stderrTail(r.stderr) || "no output"}`,
    );
  }
  let parsed: ReturnType<typeof parseWhisperJson>;
  try {
    parsed = parseWhisperJson(await readFile(`${outBase}.json`, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      throw new Error("whisper-cli produced no transcript");
    throw e;
  }
  return { ...parsed, model: basename(model), srtPath: `${outBase}.srt` };
}

const RUNNERS: Record<Engine, (ctx: PackContext, input: EngineInput) => Promise<EngineResult>> = {
  "whisper.cpp": runWhisperCpp,
  parakeet: runParakeet,
  hex: runHex,
  whisperx: runWhisperx,
};

const ENGINE_LABEL: Record<Engine, string> = {
  "whisper.cpp": "whisper.cpp",
  parakeet: "parakeet-mlx",
  hex: "Hex",
  whisperx: "whisperX",
};

/**
 * Run the planned engines in order on a 16 kHz mono WAV. A missing or
 * unreachable engine (LocalBackendError) hands over to the next one; real
 * failures, and a miss on the last engine, are thrown.
 */
export async function runEngines(
  ctx: PackContext,
  engines: readonly Engine[],
  input: EngineInput,
): Promise<{ result: EngineResult; engine: Engine }> {
  let lastMissing: unknown;
  for (const engine of engines) {
    throwIfCancelled(ctx);
    ctx.progress?.(0.25, `transcribing with ${ENGINE_LABEL[engine]}`);
    try {
      return { result: await RUNNERS[engine](ctx, input), engine };
    } catch (e) {
      if (e instanceof LocalBackendError && engine !== engines[engines.length - 1]) {
        lastMissing = e;
        continue;
      }
      throw e;
    }
  }
  throw lastMissing ?? new Error("no speech-to-text engine ran");
}

/** The ffmpeg arguments that turn the first audio stream into 16 kHz mono WAV. */
export function wavArgs(src: string, seconds: number): string[] {
  return [
    ...inputArgs(src),
    "-vn",
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    ...outputBounds(seconds + 0.2),
  ];
}

/** Is `model` one of the engine names? Then it picks the engine, not a model. */
export function engineFromModel(model: string | undefined): Engine | undefined {
  return (ENGINE_SETTING_VALUES as readonly string[]).includes(model ?? "") && model !== "auto"
    ? (model as Engine)
    : undefined;
}

export async function transcribe(
  ctx: PackContext,
  input: TranscribeArgs,
  tool = "local_transcribe",
) {
  const byModel = engineFromModel(input.model);
  const model = byModel ? undefined : input.model;
  const engines = await planEngines(ctx, {
    engine: input.engine ?? byModel,
    speakers: input.speakers,
  });
  // Fail before any work when the only engine is whisper.cpp without a model.
  if (engines.length === 1 && engines[0] === "whisper.cpp") await resolveWhisperModel(ctx);
  return withWorkDir(ctx, async (work) => {
    ctx.progress?.(0.05, "preparing audio");
    const src = await stageInput(ctx, work, input.artifact_id, 0);
    if (!src.info.hasAudio) throw new Error(`artifact ${input.artifact_id} has no audio track`);
    const seconds = boundedDuration(src.info.duration_s, undefined, undefined);
    const wav = join(work, "speech.wav");
    await runFfmpeg(ctx, work, wavArgs(src.path, seconds), wav, {
      progress: { from: 0.05, to: 0.25, message: "preparing audio" },
    });
    const { result, engine: used } = await runEngines(ctx, engines, {
      wav,
      work,
      duration_s: seconds,
      ...(input.language ? { language: input.language } : {}),
      ...(model ? { model } : {}),
      ...(input.speakers ? { speakers: true } : {}),
    });
    ctx.progress?.(0.9, "saving subtitles");
    let srt: ReturnType<typeof artifactOut> | null = null;
    if (result.segments.length > 0) {
      let srtPath = result.srtPath;
      if (!srtPath || !(await stat(srtPath).catch(() => null))) {
        srtPath = await writeSrt(join(work, "transcript-out.srt"), result.segments);
      }
      const ref = await ctx.library.importFile({
        kind: "document",
        mime: "application/x-subrip",
        sourcePath: srtPath,
        tool,
        meta: { source: input.artifact_id, language: result.language, engine: used },
      });
      srt = artifactOut(ref);
    }
    return {
      text: result.text,
      segments: result.segments,
      language: result.language,
      duration_s: round(seconds, 2),
      srt_artifact: srt,
      model: result.model,
      engine: used,
    };
  });
}

export const whisperTools = [
  defineTool({
    name: "local_transcribe",
    capability: "audio.transcribe",
    description:
      "Transcribe a library audio or video artifact on this machine with parakeet-mlx (Apple silicon), whisper.cpp, Hex or whisperX, whichever is installed (or the one named by engine / the transcriptionEngine setting). Returns the text, timed segments and an SRT subtitle artifact (usable with local_video_burn_captions). speakers: true labels speakers with whisperX and an HF_TOKEN. local_status shows what is installed. Up to 30 minutes of audio per call.",
    input: TranscribeInput,
    annotations: {
      title: "Transcribe (local)",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    longRunning: true,
    tags: ["local", "whisper", "parakeet", "transcription", "captions"],
    run: (input, ctx) => transcribe(ctx, input),
  }),
];
