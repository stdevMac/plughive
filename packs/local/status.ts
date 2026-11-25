// packs/local/status.ts
//
// local_status: what works on this machine right now. Fast, never throws.
import { basename } from "node:path";
import { defineTool, z } from "plughive/pack";
import type { PackContext } from "plughive/pack";
import { ENGINE_HINT, engineBinaryStatus, engineSetting } from "./engines.js";
import { run } from "./lib/ffmpeg.js";
import { type BackendStatus, binaryStatus, rememberAvailable } from "./lib/probe.js";
import { HINTS, backendFetch, baseUrl, readJson } from "./lib/util.js";
import { WHISPER_BINARIES, findModels } from "./whisper.js";

export type { BackendStatus };

const SPAWN_TIMEOUT_MS = 8000;
const HTTP_TIMEOUT_MS = 3000;

function msg(e: unknown): string {
  return ((e as Error)?.message ?? String(e)).slice(0, 300);
}

const down = (hint: string, error: string): BackendStatus => ({
  available: false,
  details: {},
  install_hint: hint,
  error,
});

async function binaryVersion(ctx: PackContext, bin: string): Promise<string | null> {
  const r = await run(ctx, bin, ["-version"], { timeoutMs: SPAWN_TIMEOUT_MS });
  if (r.exitCode !== 0) return null;
  return r.stdout.split("\n")[0]?.trim().slice(0, 200) ?? null;
}

export function ffmpegStatus(ctx: PackContext): Promise<BackendStatus> {
  // Three spawns, and most local providers ask: share them (see rememberAvailable).
  return rememberAvailable(`${ctx.pack.dataDir}\0ffmpegStatus`, () => probeFfmpeg(ctx));
}

async function probeFfmpeg(ctx: PackContext): Promise<BackendStatus> {
  try {
    const [ffmpeg, ffprobe] = await Promise.all([
      binaryVersion(ctx, "ffmpeg").catch(() => null),
      binaryVersion(ctx, "ffprobe").catch(() => null),
    ]);
    if (!ffmpeg || !ffprobe) {
      return {
        available: false,
        details: { ffmpeg, ffprobe },
        install_hint: HINTS.ffmpeg,
        error: `${!ffmpeg ? "ffmpeg" : "ffprobe"} not found`,
      };
    }
    const filters = await run(ctx, "ffmpeg", ["-hide_banner", "-filters"], {
      timeoutMs: SPAWN_TIMEOUT_MS,
    }).catch(() => null);
    const burnCaptions = filters ? /^\s*\S+\s+subtitles\s/m.test(filters.stdout) : null;
    return {
      available: true,
      details: { ffmpeg, ffprobe, burn_captions_supported: burnCaptions },
      install_hint: burnCaptions === false ? HINTS.libass : null,
    };
  } catch (e) {
    return down(HINTS.ffmpeg, msg(e));
  }
}

export async function whisperStatus(ctx: PackContext): Promise<BackendStatus> {
  let binary: string | null = null;
  for (const bin of WHISPER_BINARIES) {
    try {
      const r = await run(ctx, bin, ["--help"], {
        timeoutMs: SPAWN_TIMEOUT_MS,
        hint: HINTS.whisper,
      });
      if (r.exitCode === 0 || r.stderr.includes("usage") || r.stdout.includes("usage")) {
        binary = bin;
        break;
      }
    } catch {
      /* try next */
    }
  }
  const models = await findModels(ctx).catch(() => [] as string[]);
  const configured =
    typeof ctx.settings.whisperModelPath === "string" &&
    ctx.settings.whisperModelPath.trim() !== "";
  const hasModel = configured || models.length > 0;
  return {
    available: binary !== null && hasModel,
    details: {
      binary,
      models: models.map((m) => basename(m)),
      model_setting: configured ? ctx.settings.whisperModelPath : null,
    },
    install_hint: binary === null || !hasModel ? HINTS.whisper : null,
    ...(binary === null
      ? { error: "whisper-cli not found" }
      : !hasModel
        ? { error: "no ggml model found" }
        : {}),
  };
}

async function getJson<T>(
  ctx: PackContext,
  backend: string,
  hint: string,
  base: string,
  path: string,
): Promise<T> {
  const res = await backendFetch(ctx, backend, hint, base, path, { timeoutMs: HTTP_TIMEOUT_MS });
  if (!res.ok) throw new Error(`${backend} ${path} returned HTTP ${res.status}`);
  return readJson<T>(res, 1024 * 1024);
}

export async function ollamaStatus(ctx: PackContext): Promise<BackendStatus> {
  try {
    const base = baseUrl(ctx, "ollamaUrl");
    const [version, tags] = await Promise.all([
      getJson<{ version?: string }>(ctx, "Ollama", HINTS.ollama, base, "/api/version"),
      getJson<{ models?: Array<{ name?: string }> }>(
        ctx,
        "Ollama",
        HINTS.ollama,
        base,
        "/api/tags",
      ).catch(() => ({ models: [] })),
    ]);
    const models = (tags.models ?? [])
      .map((m) => m.name)
      .filter((n): n is string => typeof n === "string");
    return {
      available: true,
      details: { url: base, version: version.version ?? null, models },
      install_hint:
        models.length === 0
          ? "Ollama is running but has no models. Pull one, for example `ollama pull llama3.2`."
          : null,
    };
  } catch (e) {
    return down(HINTS.ollama, msg(e));
  }
}

export async function comfyStatusBrief(ctx: PackContext): Promise<BackendStatus> {
  try {
    const base = baseUrl(ctx, "comfyUrl");
    const [stats, info] = await Promise.all([
      getJson<{ system?: { comfyui_version?: string } }>(
        ctx,
        "ComfyUI",
        HINTS.comfy,
        base,
        "/system_stats",
      ),
      getJson<{ CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: unknown[] } } } }>(
        ctx,
        "ComfyUI",
        HINTS.comfy,
        base,
        "/object_info/CheckpointLoaderSimple",
      ).catch(() => ({})),
    ]);
    const names = (
      info as { CheckpointLoaderSimple?: { input?: { required?: { ckpt_name?: unknown[] } } } }
    ).CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0];
    const checkpoints = Array.isArray(names)
      ? names.filter((n): n is string => typeof n === "string")
      : [];
    return {
      available: true,
      details: { url: base, version: stats.system?.comfyui_version ?? null, checkpoints },
      install_hint:
        checkpoints.length === 0
          ? "ComfyUI is running but has no checkpoints; local_generate_image needs one in ComfyUI/models/checkpoints."
          : null,
    };
  } catch (e) {
    return down(HINTS.comfy, msg(e));
  }
}

export async function kokoroStatus(ctx: PackContext): Promise<BackendStatus> {
  try {
    const base = baseUrl(ctx, "kokoroUrl");
    const data = await getJson<{ voices?: unknown[] }>(
      ctx,
      "Kokoro",
      HINTS.kokoro,
      base,
      "/v1/audio/voices",
    );
    const voices = (data.voices ?? []).filter((v): v is string => typeof v === "string");
    return {
      available: true,
      details: { url: base, voice_count: voices.length, voices: voices.slice(0, 40) },
      install_hint: null,
    };
  } catch (e) {
    return down(HINTS.kokoro, msg(e));
  }
}

/** Command-line tools behind the newer capabilities: [binary, hint, probe args]. */
const CLI_BACKENDS: Record<string, [string, string, string[]?]> = {
  realesrgan: ["realesrgan-ncnn-vulkan", HINTS.realesrgan, ["-h"]],
  rembg: ["rembg", HINTS.rembg, ["--help"]],
  demucs: ["demucs", HINTS.demucs, ["--help"]],
  pdftotext: ["pdftotext", HINTS.pdftotext, ["-v"]],
  tesseract: ["tesseract", HINTS.tesseract],
  ocrmypdf: ["ocrmypdf", HINTS.ocrmypdf],
  pandoc: ["pandoc", HINTS.pandoc],
  soffice: ["soffice", HINTS.soffice],
  ytdlp: ["yt-dlp", HINTS.ytdlp],
};

async function cliStatus(ctx: PackContext, name: string): Promise<BackendStatus> {
  const [binary, hint, args] = CLI_BACKENDS[name] as [string, string, string[]?];
  try {
    return await binaryStatus(ctx, binary, hint, args);
  } catch (e) {
    return down(hint, msg(e));
  }
}

async function engineStatus(
  ctx: PackContext,
  engine: "parakeet" | "hex" | "whisperx",
): Promise<BackendStatus> {
  if (engine === "parakeet" && !(process.platform === "darwin" && process.arch === "arm64")) {
    return {
      available: false,
      details: {},
      install_hint: null,
      error: "parakeet-mlx needs Apple silicon",
    };
  }
  try {
    const s = await engineBinaryStatus(ctx, engine);
    if (engine !== "whisperx" || !s.available) return s;
    const token = await ctx.secrets.has("HF_TOKEN").catch(() => false);
    return { ...s, details: { ...s.details, speaker_labels: token } };
  } catch (e) {
    return down(ENGINE_HINT[engine], msg(e));
  }
}

const TOOLS_BY_BACKEND: Record<string, string[]> = {
  ffmpeg: [
    "local_media_probe",
    "local_media_convert",
    "local_audio_mix",
    "local_audio_concat",
    "local_video_concat",
    "local_video_mux_audio",
    "local_video_burn_captions",
  ],
  whisper: ["local_transcribe"],
  parakeet: ["local_transcribe"],
  hex: ["local_transcribe"],
  whisperx: ["local_transcribe"],
  ollama: ["local_ollama_models", "local_chat", "local_embed"],
  comfyui: ["local_comfy_status", "local_comfy_run_workflow", "local_generate_image"],
  kokoro: ["local_voices", "local_speak"],
};

/** The capabilities each backend serves through the router (local is the free fallback). */
const CAPABILITIES_BY_BACKEND: Record<string, string[]> = {
  ffmpeg: ["video.upscale"],
  whisper: ["audio.transcribe"],
  parakeet: ["audio.transcribe"],
  hex: ["audio.transcribe"],
  whisperx: ["audio.transcribe"],
  ollama: ["chat", "text.translate", "text.embed", "text.rerank"],
  comfyui: ["image.generate", "image.edit"],
  kokoro: ["speech.generate"],
  realesrgan: ["image.upscale"],
  rembg: ["image.remove_background"],
  demucs: ["audio.separate_stems"],
  pdftotext: ["document.parse"],
  tesseract: ["document.parse"],
  pandoc: ["document.parse", "document.convert"],
  soffice: ["document.convert"],
  ytdlp: ["media.transcript"],
};

export async function localStatus(ctx: PackContext) {
  const cliNames = Object.keys(CLI_BACKENDS);
  const [ffmpeg, whisper, parakeet, hex, whisperx, ollama, comfyui, kokoro, ...clis] =
    await Promise.all([
      ffmpegStatus(ctx),
      whisperStatus(ctx),
      engineStatus(ctx, "parakeet"),
      engineStatus(ctx, "hex"),
      engineStatus(ctx, "whisperx"),
      ollamaStatus(ctx),
      comfyStatusBrief(ctx),
      kokoroStatus(ctx),
      ...cliNames.map((n) => cliStatus(ctx, n)),
    ]);
  const backends: Record<string, BackendStatus> = {
    ffmpeg,
    whisper,
    parakeet,
    hex,
    whisperx,
    ollama,
    comfyui,
    kokoro,
  };
  cliNames.forEach((n, i) => {
    backends[n] = clis[i] as BackendStatus;
  });
  const ready = Object.entries(backends)
    .filter(([, b]) => b.available)
    .map(([k]) => k);
  const missing = Object.entries(backends)
    .filter(([, b]) => !b.available)
    .map(([k]) => k);
  const unique = (list: string[]) => [...new Set(list)];
  return {
    backends,
    ready,
    missing,
    transcription_engine: engineSetting(ctx),
    usable_tools: unique(ready.flatMap((k) => TOOLS_BY_BACKEND[k] ?? [])),
    usable_capabilities: unique(ready.flatMap((k) => CAPABILITIES_BY_BACKEND[k] ?? [])).sort(),
  };
}

export const statusTools = [
  defineTool({
    name: "local_status",
    description:
      "Detect which local backends work on this machine: ffmpeg/ffprobe, the speech engines (whisper.cpp with its models, parakeet-mlx, Hex, whisperX), Ollama (models), ComfyUI (checkpoints), Kokoro (voices) and the command-line tools behind the free capability fallbacks (Real-ESRGAN, rembg, Demucs, pdftotext, Tesseract, OCRmyPDF, pandoc, LibreOffice, yt-dlp). Missing ones come with install hints. Fast; never fails.",
    input: z.object({}),
    annotations: { title: "Local backends status", readOnlyHint: true, openWorldHint: false },
    tags: ["local", "status"],
    run: (_input, ctx) => localStatus(ctx),
  }),
];
