// packs/local/lib/util.ts
//
// Shared plumbing: settings, loopback-only URL validation, bounded HTTP reads,
// temp work dirs and the install hints shown when a backend is missing.
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { PackContext, PackFetchInit } from "plughive/pack";

export class LocalBackendError extends Error {
  override name = "LocalBackendError";
}

export const DEFAULTS = {
  comfyUrl: "http://127.0.0.1:8188",
  ollamaUrl: "http://127.0.0.1:11434",
  kokoroUrl: "http://127.0.0.1:8880",
  kokoroVoice: "af_heart",
} as const;

type BaseHintName = "ffmpeg" | "whisper" | "ollama" | "comfy" | "libass" | "kokoro";

const WHISPER_MODEL =
  'and a ggml model: install "Whisper base model" on the Software page (install_software whisper-model-base), ' +
  "or download one from https://huggingface.co/ggerganov/whisper.cpp/tree/main into ~/.cache/whisper.cpp. " +
  "To use a model somewhere else, set the pack setting whisperModelPath.";

const COMFY =
  "Install and start ComfyUI (https://github.com/comfyanonymous/ComfyUI, `python main.py`), listening on 127.0.0.1:8188. For local_generate_image also put a checkpoint (.safetensors) in ComfyUI/models/checkpoints.";

const KOKORO =
  "Run Kokoro-FastAPI: `docker run -p 8880:8880 ghcr.io/remsky/kokoro-fastapi-cpu:latest` (https://github.com/remsky/Kokoro-FastAPI).";

/** Hints for the tools the local pack always offered (ffmpeg, whisper.cpp, Ollama, ComfyUI, Kokoro). */
function baseHints(platform: NodeJS.Platform): Record<BaseHintName, string> {
  if (platform === "darwin") {
    return {
      ffmpeg:
        "Install ffmpeg with `brew install ffmpeg` so that `ffmpeg` and `ffprobe` are on the daemon's PATH.",
      whisper: `Install whisper.cpp with \`brew install whisper-cpp\` (it provides \`whisper-cli\`) ${WHISPER_MODEL}`,
      ollama:
        "Install Ollama (https://ollama.com/download or `brew install ollama`), start it with `ollama serve` and pull a model, for example `ollama pull llama3.2`.",
      comfy: COMFY,
      libass:
        "This ffmpeg has no `subtitles` filter (libass), so local_video_burn_captions cannot run (checked with `ffmpeg -filters`). " +
        "The Homebrew `ffmpeg` formula is built without libass: run `brew install ffmpeg-full`, which is keg-only, then put `$(brew --prefix ffmpeg-full)/bin` first on the daemon's PATH and restart the daemon.",
      kokoro: KOKORO,
    };
  }
  if (platform === "win32") {
    return {
      ffmpeg:
        "Install ffmpeg with `winget install Gyan.FFmpeg` (or download it from https://www.gyan.dev/ffmpeg/builds/), then restart the daemon so that `ffmpeg.exe` and `ffprobe.exe` are on its PATH.",
      whisper: `Download whisper.cpp for Windows (\`whisper-bin-x64.zip\` from https://github.com/ggml-org/whisper.cpp/releases), put the folder with \`whisper-cli.exe\` on the daemon's PATH, ${WHISPER_MODEL}`,
      ollama:
        "Install Ollama with `winget install Ollama.Ollama` (or https://ollama.com/download); it starts in the background. Then pull a model, for example `ollama pull llama3.2`.",
      comfy: `${COMFY} On Windows the ComfyUI portable build or ComfyUI Desktop also works.`,
      libass:
        "This ffmpeg has no `subtitles` filter (libass), so local_video_burn_captions cannot run (checked with `ffmpeg -filters`). " +
        "Install the full build with `winget install Gyan.FFmpeg`, which includes libass, and restart the daemon.",
      kokoro: `${KOKORO} Docker Desktop is needed on Windows.`,
    };
  }
  return {
    ffmpeg:
      "Install ffmpeg (Debian/Ubuntu: `sudo apt install ffmpeg`; Fedora: `sudo dnf install ffmpeg` from RPM Fusion; Arch: `sudo pacman -S ffmpeg`) so that `ffmpeg` and `ffprobe` are on the daemon's PATH.",
    whisper: `Build whisper.cpp (https://github.com/ggml-org/whisper.cpp, \`cmake -B build && cmake --build build\`), put \`build/bin\` with \`whisper-cli\` on the daemon's PATH, ${WHISPER_MODEL}`,
    ollama:
      "Install Ollama from https://ollama.com/download/linux, make sure it runs (`ollama serve` or its systemd service) and pull a model, for example `ollama pull llama3.2`.",
    comfy: COMFY,
    libass:
      "This ffmpeg has no `subtitles` filter (libass), so local_video_burn_captions cannot run (checked with `ffmpeg -filters`). " +
      "The Debian/Ubuntu, Fedora (RPM Fusion) and Arch `ffmpeg` packages include libass; a minimal or static build may not.",
    kokoro: KOKORO,
  };
}

type ExtraHintName =
  | "realesrgan"
  | "rembg"
  | "demucs"
  | "tesseract"
  | "ocrmypdf"
  | "pdftotext"
  | "soffice"
  | "pandoc"
  | "ytdlp"
  | "parakeet"
  | "hex"
  | "whisperx";

export type HintName = BaseHintName | ExtraHintName;

const PATH_NOTE = "so that it is on the daemon's PATH, then restart the daemon";

/** Install hints for the tools behind the newer capabilities, per OS. */
function extraHints(platform: NodeJS.Platform): Record<ExtraHintName, string> {
  const mac = platform === "darwin";
  const win = platform === "win32";
  const pkg = (brew: string, winget: string | null, apt: string | null, fallback: string) =>
    mac
      ? `\`brew install ${brew}\``
      : win
        ? winget
          ? `\`winget install ${winget}\``
          : fallback
        : apt
          ? `your package manager (Debian/Ubuntu: \`sudo apt install ${apt}\`)`
          : fallback;
  const uvTool = (name: string, extra = "") =>
    `\`uv tool install ${name}\`${extra} (or \`pipx install ${name}\`)`;
  return {
    realesrgan: `Download realesrgan-ncnn-vulkan for your OS from https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan/releases and put the folder with \`realesrgan-ncnn-vulkan\` (and its models folder) ${PATH_NOTE}. It needs a Vulkan-capable GPU (Metal through MoltenVK on macOS).`,
    rembg: `Install rembg with ${uvTool('"rembg[cli]"')} ${PATH_NOTE}. It downloads its u2net model on first use.`,
    demucs: `Install Demucs with ${uvTool("demucs")} ${PATH_NOTE}. It downloads its model on first use; ffmpeg is needed too.`,
    tesseract: `Install Tesseract OCR with ${pkg("tesseract", "UB-Mannheim.TesseractOCR", "tesseract-ocr", "https://github.com/tesseract-ocr/tesseract")} ${PATH_NOTE}. Add language packs for non-English text (brew: tesseract-lang).`,
    ocrmypdf: `For scanned PDFs install OCRmyPDF with ${mac ? "`brew install ocrmypdf`" : uvTool("ocrmypdf")} ${PATH_NOTE}; PDFs with a text layer only need pdftotext.`,
    pdftotext: `Install Poppler for pdftotext with ${pkg("poppler", "oschwartz10612.Poppler", "poppler-utils", "https://poppler.freedesktop.org")} ${PATH_NOTE}.`,
    soffice: mac
      ? "Install LibreOffice (`brew install --cask libreoffice`) and link its binary onto the daemon's PATH, for example `ln -s /Applications/LibreOffice.app/Contents/MacOS/soffice /opt/homebrew/bin/soffice`, then restart the daemon."
      : win
        ? `Install LibreOffice with \`winget install TheDocumentFoundation.LibreOffice\` and add \`C:\\Program Files\\LibreOffice\\program\` (which holds soffice.exe) ${PATH_NOTE}.`
        : `Install LibreOffice (Debian/Ubuntu: \`sudo apt install libreoffice\`) ${PATH_NOTE}.`,
    pandoc: `Install pandoc with ${pkg("pandoc", "JohnMacFarlane.Pandoc", "pandoc", "https://pandoc.org/installing.html")} ${PATH_NOTE}.`,
    ytdlp: `Install yt-dlp with ${mac ? "`brew install yt-dlp`" : win ? "`winget install yt-dlp.yt-dlp`" : uvTool("yt-dlp")} ${PATH_NOTE}.`,
    parakeet: mac
      ? `On Apple silicon install parakeet-mlx with ${uvTool("parakeet-mlx")} ${PATH_NOTE}. It downloads mlx-community/parakeet-tdt-0.6b-v3 on first use; ffmpeg is needed too.`
      : "parakeet-mlx runs only on Apple silicon Macs; use whisper.cpp or whisperX here.",
    hex: mac
      ? "Install Hex (https://github.com/anomalyco/hex) and link its command onto the daemon's PATH, for example `ln -s /Applications/Hex.app/Contents/MacOS/hex /opt/homebrew/bin/hex`, then restart the daemon. Download a model in Hex first."
      : `Install Hex (https://github.com/anomalyco/hex) and put its \`hex\` command ${PATH_NOTE}. Download a model in Hex first (\`hex model install\`).`,
    whisperx: `Install whisperX with ${uvTool("whisperx")} ${PATH_NOTE}. For speaker labels also set the local pack secret HF_TOKEN to a Hugging Face token that accepted the pyannote/speaker-diarization-3.1 terms.`,
  };
}

/**
 * Hints whose program plughive's own installer offers (src/core/installer/catalog.json),
 * with the catalog id. A managed install needs no restart and no PATH change, so it is
 * offered first; the manual route stays as the alternative.
 */
const CATALOG_IDS: Partial<Record<HintName, string>> = {
  ffmpeg: "ffmpeg",
  whisper: "whisper.cpp",
  ollama: "ollama",
  kokoro: "kokoro",
  realesrgan: "realesrgan",
  rembg: "rembg",
  demucs: "demucs",
  tesseract: "tesseract",
  ocrmypdf: "ocrmypdf",
  pandoc: "pandoc",
  soffice: "libreoffice",
  ytdlp: "yt-dlp",
  parakeet: "parakeet-mlx",
  hex: "hex",
  whisperx: "whisperx",
};

/** Install hints for the OS the daemon runs on: plughive's installer first, then brew, winget, apt/dnf. */
export function hintsFor(platform: NodeJS.Platform): Record<HintName, string> {
  const all: Record<HintName, string> = { ...baseHints(platform), ...extraHints(platform) };
  for (const [name, id] of Object.entries(CATALOG_IDS) as [HintName, string][]) {
    if (name === "parakeet" && platform !== "darwin") continue;
    all[name] =
      `Install it from plughive's Software page, or have your agent call install_software with id "${id}" (no restart needed). Or yourself: ${all[name]}`;
  }
  return all;
}

/** The hints for this machine. */
export const HINTS = hintsFor(process.platform);

export const MAX_JSON_BYTES = 16 * 1024 * 1024;

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

function isPrivateV4(host: string): boolean {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return false;
  const [a = 0, b = 0] = parts;
  return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

/**
 * Validate a backend base URL. Only http(s) URLs whose host is `localhost`, a
 * loopback address or an RFC 1918 address are accepted; no credentials, path,
 * query or fragment. Returns the origin without a trailing slash.
 */
export function validateLocalUrl(raw: string, setting: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`setting ${setting} is not a valid URL: ${JSON.stringify(raw.slice(0, 100))}`);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`setting ${setting} must be an http or https URL`);
  }
  if (u.username || u.password) throw new Error(`setting ${setting} must not contain credentials`);
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash) {
    throw new Error(`setting ${setting} must be a bare origin such as http://127.0.0.1:8188`);
  }
  const host = u.hostname;
  const ok = host === "localhost" || host === "[::1]" || isPrivateV4(host);
  if (!ok) {
    throw new Error(
      `setting ${setting} must point at this machine or a private network (localhost, 127.x, 10.x, 172.16-31.x, 192.168.x, [::1]); got host "${host}"`,
    );
  }
  return u.origin;
}

export function settingString(ctx: PackContext, key: string): string | undefined {
  const v = ctx.settings[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export function baseUrl(ctx: PackContext, key: "comfyUrl" | "ollamaUrl" | "kokoroUrl"): string {
  return validateLocalUrl(settingString(ctx, key) ?? DEFAULTS[key], key);
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export interface LocalRequest {
  method?: "GET" | "POST";
  json?: unknown;
  /** A multipart body (fetch sets the content type and boundary). */
  form?: FormData;
  timeoutMs?: number;
}

function messageOf(e: unknown): string {
  const err = e as { message?: string; cause?: { message?: string; code?: string } };
  const cause = err.cause?.code ?? err.cause?.message;
  return `${err.message ?? String(e)}${cause ? ` [${cause}]` : ""}`;
}

export function cancelled(ctx: PackContext): boolean {
  return ctx.signal?.aborted === true;
}

export function throwIfCancelled(ctx: PackContext): void {
  if (cancelled(ctx)) throw new Error("cancelled");
}

/**
 * fetch through ctx.fetch with a timeout. Network failures become a
 * LocalBackendError that says how to start the backend; HTTP status codes are
 * left to the caller.
 */
export async function backendFetch(
  ctx: PackContext,
  backend: string,
  hint: string,
  base: string,
  path: string,
  req: LocalRequest = {},
): Promise<Response> {
  const timeoutMs = req.timeoutMs ?? 30_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
  const init: PackFetchInit = {
    // The kernel deadline backs up the pack's own (which gives the nicer message).
    timeoutMs: Math.min(timeoutMs + 2_000, 15 * 60_000),
    method: req.method ?? (req.json !== undefined || req.form !== undefined ? "POST" : "GET"),
    signal,
    redirect: "error",
    ...(req.json !== undefined
      ? { headers: { "content-type": "application/json" }, body: JSON.stringify(req.json) }
      : req.form !== undefined
        ? { body: req.form }
        : {}),
  };
  try {
    return await ctx.fetch(`${base}${path}`, init);
  } catch (e) {
    if (cancelled(ctx)) throw new Error("cancelled");
    if (timeout.aborted) {
      throw new LocalBackendError(
        `${backend} at ${base} did not answer within ${Math.round(timeoutMs / 1000)} s. ${hint}`,
      );
    }
    throw new LocalBackendError(
      `${backend} is not reachable at ${base} (${messageOf(e)}). ${hint}`,
    );
  }
}

export async function readBytes(res: Response, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new Error(`response is larger than ${maxBytes} bytes`);
  if (!res.body) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response is larger than ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

export async function readText(res: Response, maxBytes = MAX_JSON_BYTES): Promise<string> {
  return Buffer.from(await readBytes(res, maxBytes)).toString("utf8");
}

export async function readJson<T = unknown>(res: Response, maxBytes = MAX_JSON_BYTES): Promise<T> {
  const text = await readText(res, maxBytes);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`backend returned invalid JSON: ${text.slice(0, 200)}`);
  }
}

/** Short, single-line excerpt of an error response body. */
export async function errorExcerpt(res: Response): Promise<string> {
  try {
    const text = await readText(res, 64 * 1024);
    try {
      const j = JSON.parse(text) as { error?: unknown; detail?: unknown; message?: unknown };
      const e = j.error ?? j.detail ?? j.message;
      if (e !== undefined) return (typeof e === "string" ? e : JSON.stringify(e)).slice(0, 300);
    } catch {
      /* not JSON */
    }
    return text.replace(/\s+/g, " ").slice(0, 300);
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Work dir and small helpers
// ---------------------------------------------------------------------------

/** Run `fn` with a fresh temp dir inside the pack data dir; always removed afterwards. */
export async function withWorkDir<T>(
  ctx: PackContext,
  fn: (work: string) => Promise<T>,
): Promise<T> {
  const work = join(ctx.pack.dataDir, "work", randomUUID());
  await mkdir(work, { recursive: true, mode: 0o700 });
  try {
    return await fn(work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

/** Work dirs older than this were left by a process that stopped mid-job. */
export const STALE_WORK_MS = 6 * 60 * 60 * 1000;

/**
 * Remove work dirs a crashed or killed daemon left behind. Only plain folders
 * named like the ones `withWorkDir` makes, and only when older than `maxAgeMs`,
 * so a job still running in another pack instance keeps its files.
 */
export async function sweepStaleWorkDirs(
  dataDir: string,
  maxAgeMs: number = STALE_WORK_MS,
  now: number = Date.now(),
): Promise<number> {
  const root = join(dataDir, "work");
  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name)) continue;
    const dir = join(root, name);
    try {
      const info = await lstat(dir);
      if (!info.isDirectory() || now - info.mtimeMs < maxAgeMs) continue;
      await rm(dir, { recursive: true, force: true });
      removed++;
    } catch {
      // gone already, or not ours to remove
    }
  }
  return removed;
}

export function round(n: number, places: number): number {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

export interface ArtifactOut {
  id: string;
  url: string;
  mime: string;
}

export function artifactOut(ref: { id: string; url: string; mime: string }): ArtifactOut {
  return { id: ref.id, url: ref.url, mime: ref.mime };
}

/** Artifact ids only: no slashes, dots, spaces or a leading "-". */
export const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
