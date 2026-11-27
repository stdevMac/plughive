// packs/local/imaging.ts
//
// Media capabilities that run one command-line tool on a library artifact:
// image.upscale (realesrgan-ncnn-vulkan), image.remove_background (rembg),
// video.upscale (ffmpeg lanczos) and audio.separate_stems (Demucs). Each tool
// is probed first, so a missing one fails with its install hint before any
// work; the input is staged into a temp work dir and the outputs are imported
// into the library.
import { existsSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityError, type PackContext } from "plughive/pack";
import {
  AUDIO_MIME,
  MAX_INPUT_DIM,
  MAX_OUTPUT_DIM,
  assertSafePath,
  audioCodecArgs,
  boundedDuration,
  inputArgs,
  outputBounds,
  run,
  runFfmpeg,
  stageInput,
  stderrTail,
  videoCodecArgs,
} from "./lib/ffmpeg.js";
import { requireBinary } from "./lib/probe.js";
import { HINTS, artifactOut, throwIfCancelled, withWorkDir } from "./lib/util.js";

const TOOL_TIMEOUT_MS = 15 * 60_000;
const DEMUCS_TIMEOUT_MS = 30 * 60_000;
/** Largest upscaled side realesrgan may produce. */
const MAX_UPSCALE_DIM = MAX_INPUT_DIM;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const unsupported = (what: string) =>
  new CapabilityError(`The local backends cannot do ${what}.`, {
    retryable: true,
    code: "UNSUPPORTED_OPTION",
  });

function checkName(kind: string, name: string): string {
  if (!NAME.test(name)) throw new Error(`"${name.slice(0, 60)}" is not a valid ${kind} name`);
  return name;
}

async function nonEmpty(path: string, what: string): Promise<void> {
  const s = await stat(path).catch(() => null);
  if (!s || s.size === 0) throw new Error(`${what} produced no output`);
}

function failed(binary: string, r: { exitCode: number; stderr: string; stdout: string }): Error {
  return new Error(
    `${binary} failed (exit ${r.exitCode}): ${stderrTail(r.stderr) || stderrTail(r.stdout) || "no output"}`,
  );
}

async function stageImage(ctx: PackContext, work: string, id: string) {
  const src = await stageInput(ctx, work, id, 0);
  if (!src.info.isImage || !src.info.width || !src.info.height) {
    throw new Error(`artifact ${id} is not an image`);
  }
  return { ...src, width: src.info.width, height: src.info.height };
}

// ---------------------------------------------------------------------------
// image.upscale: realesrgan-ncnn-vulkan
// ---------------------------------------------------------------------------

export const REALESRGAN_MODELS = [
  "realesrgan-x4plus",
  "realesrgan-x4plus-anime",
  "realesr-animevideov3",
] as const;

export interface UpscaleImageInput {
  artifact_id: string;
  scale?: number;
  model?: string;
}

/**
 * `modelsDir`: the models folder shipped beside the program. The macOS build
 * looks for "models" in the folder it is run from and crashes when it is not
 * there, so it is passed as an absolute path whenever it is known.
 */
export function realesrganArgs(
  input: string,
  output: string,
  model: string,
  scale: number,
  modelsDir?: string | null,
) {
  assertSafePath(input);
  assertSafePath(output);
  const args = ["-i", input, "-o", output, "-n", model, "-s", String(scale), "-f", "png"];
  if (modelsDir) {
    assertSafePath(modelsDir);
    args.push("-m", modelsDir);
  }
  return args;
}

/** The models folder next to realesrgan-ncnn-vulkan, when it is there. */
export function realesrganModelsDir(ctx: PackContext): string | null {
  const dir = ctx.programDir("realesrgan-ncnn-vulkan");
  if (!dir) return null;
  const models = join(dir, "models");
  return existsSync(join(models, "realesrgan-x4plus.param")) ? models : null;
}

/** Refuse a scale outside 2 to 4 (whole numbers): the schema says so, and it is checked here too. */
function checkScale(scale: number): number {
  if (!Number.isInteger(scale) || scale < 2 || scale > 4) {
    throw unsupported(`an upscale factor of ${scale} (use 2, 3 or 4)`);
  }
  return scale;
}

/**
 * The factor realesrgan itself runs at for `model` and `scale`, after checking
 * that neither its own output nor the final image goes over MAX_UPSCALE_DIM.
 * The x4plus models only upscale by 4; other factors run at 4 and are scaled
 * down, so a 4096 px image at scale 2 would first be rendered at 16384 px.
 */
export function upscalePlan(width: number, height: number, scale: number, model: string): number {
  const native = model === "realesr-animevideov3" ? scale : 4;
  if (Math.max(width, height) * Math.max(scale, native) > MAX_UPSCALE_DIM) {
    throw unsupported(
      `an upscaled image over ${MAX_UPSCALE_DIM} px (input is ${width}x${height}, and ${model} renders it x${native} first)`,
    );
  }
  return native;
}

export async function upscaleImage(ctx: PackContext, input: UpscaleImageInput, tool: string) {
  const scale = checkScale(input.scale ?? 4);
  const model = input.model ?? "realesrgan-x4plus";
  if (!(REALESRGAN_MODELS as readonly string[]).includes(model)) {
    throw unsupported(`the upscale model ${model} (use ${REALESRGAN_MODELS.join(", ")})`);
  }
  await requireBinary(ctx, "realesrgan-ncnn-vulkan", HINTS.realesrgan, ["-h"]);
  return withWorkDir(ctx, async (work) => {
    ctx.progress?.(0.05, "reading image");
    const src = await stageImage(ctx, work, input.artifact_id);
    const native = upscalePlan(src.width, src.height, scale, model);
    const raw = join(work, "upscaled.png");
    ctx.progress?.(0.15, `upscaling x${scale} with ${model}`);
    const r = await run(
      ctx,
      "realesrgan-ncnn-vulkan",
      realesrganArgs(src.path, raw, model, native, realesrganModelsDir(ctx)),
      { cwd: work, timeoutMs: TOOL_TIMEOUT_MS, hint: HINTS.realesrgan },
    );
    if (r.exitCode !== 0) throw failed("realesrgan-ncnn-vulkan", r);
    await nonEmpty(raw, "realesrgan-ncnn-vulkan");
    let out = raw;
    if (native !== scale) {
      out = join(work, "out.png");
      await runFfmpeg(
        ctx,
        work,
        [
          ...inputArgs(raw),
          "-vf",
          `scale=${src.width * scale}:${src.height * scale}:flags=lanczos`,
          "-frames:v",
          "1",
        ],
        out,
      );
    }
    ctx.progress?.(0.9, "saving image");
    const ref = await ctx.library.importFile({
      kind: "image",
      mime: "image/png",
      sourcePath: out,
      tool,
      meta: {
        source: input.artifact_id,
        scale,
        model,
        width: src.width * scale,
        height: src.height * scale,
      },
    });
    return { artifacts: [artifactOut(ref)], model };
  });
}

// ---------------------------------------------------------------------------
// image.remove_background: rembg
// ---------------------------------------------------------------------------

export async function removeBackground(
  ctx: PackContext,
  input: { artifact_id: string; model?: string },
  tool: string,
) {
  const model = checkName("rembg model", input.model ?? "u2net");
  await requireBinary(ctx, "rembg", HINTS.rembg, ["--help"]);
  return withWorkDir(ctx, async (work) => {
    ctx.progress?.(0.05, "reading image");
    const src = await stageImage(ctx, work, input.artifact_id);
    const out = join(work, "cutout.png");
    assertSafePath(src.path);
    assertSafePath(out);
    ctx.progress?.(0.2, `removing the background with ${model}`);
    const r = await run(ctx, "rembg", ["i", "-m", model, src.path, out], {
      cwd: work,
      timeoutMs: TOOL_TIMEOUT_MS,
      hint: HINTS.rembg,
    });
    if (r.exitCode !== 0) throw failed("rembg", r);
    await nonEmpty(out, "rembg");
    ctx.progress?.(0.9, "saving image");
    const ref = await ctx.library.importFile({
      kind: "image",
      mime: "image/png",
      sourcePath: out,
      tool,
      meta: { source: input.artifact_id, model, transparent: true },
    });
    return { artifacts: [artifactOut(ref)], model };
  });
}

// ---------------------------------------------------------------------------
// video.upscale: ffmpeg lanczos
// ---------------------------------------------------------------------------

export async function upscaleVideo(
  ctx: PackContext,
  input: { artifact_id: string; scale?: number },
  tool: string,
) {
  const scale = checkScale(input.scale ?? 2);
  return withWorkDir(ctx, async (work) => {
    ctx.progress?.(0.05, "probing video");
    const src = await stageInput(ctx, work, input.artifact_id, 0);
    const { width, height } = src.info;
    if (!src.info.hasVideo || src.info.isImage || !width || !height) {
      throw new Error(`artifact ${input.artifact_id} is not a video`);
    }
    if (Math.max(width, height) * scale > MAX_OUTPUT_DIM) {
      throw unsupported(
        `a video upscale over ${MAX_OUTPUT_DIM} px (input is ${width}x${height}, scale ${scale})`,
      );
    }
    const seconds = boundedDuration(src.info.duration_s, undefined, undefined);
    const out = join(work, "upscaled.mp4");
    await runFfmpeg(
      ctx,
      work,
      [
        ...inputArgs(src.path),
        "-map",
        "0:v:0",
        "-map",
        "0:a:0?",
        "-vf",
        `scale=iw*${scale}:ih*${scale}:flags=lanczos,scale=trunc(iw/2)*2:trunc(ih/2)*2,setsar=1`,
        ...videoCodecArgs("mp4", 18),
        ...outputBounds(seconds),
      ],
      out,
      { progress: { from: 0.1, to: 0.9, message: `upscaling x${scale}` } },
    );
    ctx.progress?.(0.9, "saving video");
    const ref = await ctx.library.importFile({
      kind: "video",
      mime: "video/mp4",
      sourcePath: out,
      tool,
      meta: {
        source: input.artifact_id,
        scale,
        model: "ffmpeg-lanczos",
        width: width * scale,
        height: height * scale,
      },
    });
    return { artifacts: [artifactOut(ref)], model: "ffmpeg-lanczos" };
  });
}

// ---------------------------------------------------------------------------
// audio.separate_stems: Demucs
// ---------------------------------------------------------------------------

export const DEMUCS_MODELS = [
  "htdemucs",
  "htdemucs_ft",
  "htdemucs_6s",
  "hdemucs_mmi",
  "mdx",
  "mdx_extra",
  "mdx_q",
  "mdx_extra_q",
] as const;
const SIX_STEMS = new Set(["piano", "guitar"]);
/** The stems Demucs can split out (the capability schema's list). */
const STEMS = new Set(["vocals", "drums", "bass", "other", "piano", "guitar"]);

function checkStem(stem: string): string {
  if (!STEMS.has(stem)) {
    throw unsupported(`a "${stem.slice(0, 40)}" stem (use ${[...STEMS].join(", ")})`);
  }
  return stem;
}

export interface StemsInput {
  artifact_id: string;
  two_stems?: string;
  model?: string;
  format?: "mp3" | "wav";
}

export function pickDemucsModel(input: Pick<StemsInput, "two_stems" | "model">): string {
  if (input.two_stems !== undefined) checkStem(input.two_stems);
  if (input.model) {
    if (!(DEMUCS_MODELS as readonly string[]).includes(input.model)) {
      throw unsupported(`the Demucs model ${input.model} (use ${DEMUCS_MODELS.join(", ")})`);
    }
    if (input.two_stems && SIX_STEMS.has(input.two_stems) && input.model !== "htdemucs_6s") {
      throw unsupported(`a ${input.two_stems} stem with ${input.model} (only htdemucs_6s has one)`);
    }
    return input.model;
  }
  return input.two_stems && SIX_STEMS.has(input.two_stems) ? "htdemucs_6s" : "htdemucs";
}

export function demucsArgs(model: string, outDir: string, wav: string, twoStems?: string) {
  assertSafePath(outDir);
  assertSafePath(wav);
  return [
    "-n",
    model,
    ...(twoStems ? ["--two-stems", checkStem(twoStems)] : []),
    "-o",
    outDir,
    "--filename",
    "{stem}.{ext}",
    wav,
  ];
}

/** Stem files Demucs wrote, `vocals.wav` and the like, found under its output folder. */
export async function findStems(dir: string): Promise<Array<{ stem: string; path: string }>> {
  const found: Array<{ stem: string; path: string }> = [];
  const walk = async (d: string, depth: number) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (e.isFile() && /^[a-z_]+\.wav$/.test(e.name))
        found.push({ stem: e.name.slice(0, -4), path: p });
    }
  };
  await walk(dir, 0);
  return found.sort((a, b) => a.stem.localeCompare(b.stem));
}

export async function separateStems(ctx: PackContext, input: StemsInput, tool: string) {
  const model = pickDemucsModel(input);
  const format = input.format ?? "mp3";
  await requireBinary(ctx, "demucs", HINTS.demucs, ["--help"]);
  return withWorkDir(ctx, async (work) => {
    ctx.progress?.(0.03, "preparing audio");
    const src = await stageInput(ctx, work, input.artifact_id, 0);
    if (!src.info.hasAudio) throw new Error(`artifact ${input.artifact_id} has no audio track`);
    const seconds = boundedDuration(src.info.duration_s, undefined, undefined);
    const wav = join(work, "mix.wav");
    await runFfmpeg(
      ctx,
      work,
      [
        ...inputArgs(src.path),
        "-vn",
        "-map",
        "0:a:0",
        "-ac",
        "2",
        "-ar",
        "44100",
        "-c:a",
        "pcm_s16le",
        ...outputBounds(seconds + 0.2),
      ],
      wav,
    );
    const outDir = join(work, "stems");
    ctx.progress?.(0.1, `separating stems with ${model}`);
    const r = await run(ctx, "demucs", demucsArgs(model, outDir, wav, input.two_stems), {
      cwd: work,
      timeoutMs: DEMUCS_TIMEOUT_MS,
      hint: HINTS.demucs,
    });
    if (r.exitCode !== 0) throw failed("demucs", r);
    const stems = await findStems(outDir);
    if (stems.length === 0) throw new Error("demucs produced no stems");
    const artifacts: Array<ReturnType<typeof artifactOut> & { stem: string }> = [];
    for (const [i, s] of stems.entries()) {
      throwIfCancelled(ctx);
      ctx.progress?.(0.85 + (0.15 * i) / stems.length, `saving ${s.stem}`);
      let path = s.path;
      if (format === "mp3") {
        path = join(work, `${s.stem}.mp3`);
        await runFfmpeg(
          ctx,
          work,
          [...inputArgs(s.path), ...audioCodecArgs("mp3"), ...outputBounds(seconds + 1)],
          path,
        );
      }
      const ref = await ctx.library.importFile({
        kind: "audio",
        mime: AUDIO_MIME[format],
        sourcePath: path,
        tool,
        meta: { source: input.artifact_id, stem: s.stem, model },
      });
      artifacts.push({ ...artifactOut(ref), stem: s.stem });
    }
    return { artifacts, model };
  });
}
