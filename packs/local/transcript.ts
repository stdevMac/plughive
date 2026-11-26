// packs/local/transcript.ts
//
// media.transcript with yt-dlp: the page's own subtitles when it has them
// (uploaded ones first, then automatic captions), otherwise the audio is
// downloaded and run through the local speech-to-text engines.
//
// yt-dlp opens its own connections, so the URL is checked against the
// loopback, private and metadata ranges first (lib/ssrf.ts), and every yt-dlp
// run goes through a loopback pinning proxy (lib/pin-proxy.ts): each request,
// redirects included, is checked again and connected to the exact address
// that was checked, which closes the DNS-rebinding window.
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CapabilityError, type PackContext } from "plughive/pack";
import type { TranscriptSegment } from "./engines.js";
import { speechLanguageProblem } from "./engines.js";
import {
  MAX_OUTPUT_SECONDS,
  assertSafePath,
  probeFile,
  run,
  runFfmpeg,
  stderrTail,
} from "./lib/ffmpeg.js";
import { startPinProxy } from "./lib/pin-proxy.js";
import { requireBinary } from "./lib/probe.js";
import { checkUrl } from "./lib/ssrf.js";
import { HINTS, throwIfCancelled, withWorkDir } from "./lib/util.js";
import { engineFromModel, planEngines, runEngines, wavArgs } from "./whisper.js";

const INFO_TIMEOUT_MS = 2 * 60_000;
const DOWNLOAD_TIMEOUT_MS = 20 * 60_000;
const MAX_INFO_BYTES = 64 * 1024 * 1024;
const MAX_AUDIO_BYTES = "500M";

const unsupported = (what: string) =>
  new CapabilityError(`The local backends cannot do ${what}.`, {
    retryable: true,
    code: "UNSUPPORTED_OPTION",
  });

/** Options every yt-dlp call gets: no user config, no plugins' surprises, one item only. */
const BASE = [
  "--ignore-config",
  "--no-playlist",
  "--no-warnings",
  "--no-progress",
  "--no-cache-dir",
  // Only yt-dlp's site extractors: the generic one fetches any page and
  // follows whatever media links it finds there, to any host.
  "--use-extractors",
  "default,-generic",
];

export interface MediaTranscriptInput {
  url: string;
  language?: string;
  timestamps?: boolean;
  model?: string;
}

export interface MediaTranscriptResult {
  text: string;
  segments?: TranscriptSegment[];
  language: string | null;
  title: string | null;
  model: string;
  source: "subtitles" | "automatic_captions" | "speech_to_text";
}

interface SubTrack {
  ext?: string;
}

export interface VideoInfo {
  title?: string;
  duration?: number;
  language?: string | null;
  is_live?: boolean;
  subtitles?: Record<string, SubTrack[]>;
  automatic_captions?: Record<string, SubTrack[]>;
}

// ---------------------------------------------------------------------------
// Subtitle choice and VTT parsing
// ---------------------------------------------------------------------------

function hasVtt(tracks: SubTrack[] | undefined): boolean {
  return Array.isArray(tracks) && tracks.some((t) => t?.ext === "vtt");
}

const base = (code: string) => code.toLowerCase().split(/[-_]/)[0] ?? code;

/**
 * Subtitle keys come from yt-dlp's metadata (untrusted) and the chosen one is
 * passed to `--sub-langs` argv, so only plain language-code keys are ever
 * considered: no leading "-", no dots or other regex metacharacters that
 * could turn the escaped pattern into something else.
 */
const SUB_KEY = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

/**
 * Which subtitle track to fetch: uploaded subtitles in the wanted language,
 * then automatic captions (the original-language track, `xx-orig`, before
 * machine translations). With no language asked for, the video's own
 * language, else English, else the only uploaded track. Keys that are not
 * plain language codes are ignored (fail closed).
 */
export function pickSubtitles(
  info: VideoInfo,
  language?: string,
): { key: string; auto: boolean; language: string } | null {
  const subs = Object.entries(info.subtitles ?? {}).filter(
    ([k, v]) => k !== "live_chat" && SUB_KEY.test(k) && hasVtt(v),
  );
  const autos = Object.entries(info.automatic_captions ?? {}).filter(
    ([k, v]) => SUB_KEY.test(k) && hasVtt(v),
  );
  const wanted = language ? [language] : [info.language, "en"].filter((l): l is string => !!l);
  for (const lang of wanted) {
    const l = lang.toLowerCase();
    const exact =
      subs.find(([k]) => k.toLowerCase() === l) ?? subs.find(([k]) => base(k) === base(l));
    if (exact) return { key: exact[0], auto: false, language: exact[0] };
    const auto =
      autos.find(([k]) => k.toLowerCase() === `${l}-orig`) ??
      autos.find(([k]) => k.toLowerCase() === l) ??
      autos.find(([k]) => base(k) === base(l));
    if (auto) return { key: auto[0], auto: true, language: auto[0].replace(/-orig$/i, "") };
  }
  if (!language && subs.length === 1 && subs[0]) {
    return { key: subs[0][0], auto: false, language: subs[0][0] };
  }
  return null;
}

function vttTime(t: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(t.trim());
  if (!m) return null;
  return (
    Number(m[1] ?? 0) * 3600 +
    Number(m[2]) * 60 +
    Number(m[3]) +
    Number((m[4] ?? "0").padEnd(3, "0")) / 1000
  );
}

const ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
  "&nbsp;": " ",
  "&lrm;": "",
  "&rlm;": "",
};

function cleanLine(line: string): string {
  return line
    .replace(/<[^>]*>/g, "")
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp|lrm|rlm);/g, (e) => ENTITIES[e] ?? e)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * WebVTT to segments. Automatic captions repeat each line in the next cue
 * (rolling captions), so a line equal to one of the last few kept lines is
 * dropped, as are the 10 ms "snapshot" cues they use.
 */
export function parseVtt(vtt: string): TranscriptSegment[] {
  const out: TranscriptSegment[] = [];
  const recent: string[] = [];
  const blocks = vtt.replace(/\r\n?/g, "\n").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n");
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at < 0) continue;
    const [from, rest] = (lines[at] ?? "").split("-->");
    const start = vttTime(from ?? "");
    const end = vttTime((rest ?? "").trim().split(/\s+/)[0] ?? "");
    if (start === null || end === null) continue;
    const fresh: string[] = [];
    for (const raw of lines.slice(at + 1)) {
      const line = cleanLine(raw);
      if (!line || recent.includes(line)) continue;
      fresh.push(line);
      recent.push(line);
      if (recent.length > 3) recent.shift();
    }
    if (fresh.length === 0) continue;
    out.push({ start_s: start, end_s: Math.max(start, end), text: fresh.join(" ") });
  }
  return out;
}

export function segmentsText(segments: readonly TranscriptSegment[]): string {
  return segments
    .map((s) => s.text)
    .join(" ")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

// ---------------------------------------------------------------------------
// yt-dlp
// ---------------------------------------------------------------------------

async function ytdlp(
  ctx: PackContext,
  work: string,
  proxy: string,
  args: string[],
  timeoutMs: number,
  maxOutputBytes?: number,
) {
  const r = await run(ctx, "yt-dlp", [...BASE, "--proxy", proxy, ...args], {
    cwd: work,
    timeoutMs,
    hint: HINTS.ytdlp,
    ...(maxOutputBytes ? { maxOutputBytes } : {}),
  });
  if (r.exitCode !== 0) {
    const tail = stderrTail(r.stderr) || stderrTail(r.stdout) || "no output";
    if (
      /Unsupported URL|is not a valid URL|no video formats|Video unavailable|Private video/i.test(
        tail,
      )
    ) {
      throw unsupported(`this URL (${tail.replace(/^ERROR:\s*/, "")})`);
    }
    if (/Requested format is not available/i.test(tail)) {
      throw unsupported(
        "speech to text on media that is only offered as a streaming playlist (HLS)",
      );
    }
    throw new Error(`yt-dlp failed (exit ${r.exitCode}): ${tail}`);
  }
  return r;
}

async function fetchInfo(
  ctx: PackContext,
  work: string,
  proxy: string,
  url: string,
): Promise<{ info: VideoInfo; path: string }> {
  const r = await ytdlp(
    ctx,
    work,
    proxy,
    ["--dump-single-json", "--skip-download", "--", url],
    INFO_TIMEOUT_MS,
    MAX_INFO_BYTES,
  );
  let info: VideoInfo;
  try {
    info = JSON.parse(r.stdout) as VideoInfo;
  } catch {
    throw new Error("yt-dlp returned unreadable metadata");
  }
  if (!info || typeof info !== "object") throw new Error("yt-dlp returned no metadata");
  const path = join(work, "info.json");
  await writeFile(path, r.stdout);
  return { info, path };
}

/** Keys whose string values yt-dlp may fetch when it loads the info JSON. */
const URL_KEY = /(^|_)url$/i;
/** Distinct hosts one item may point at before it is refused outright. */
const MAX_INFO_ORIGINS = 64;
const MAX_INFO_DEPTH = 32;
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const AMBIGUOUS_CHARS = /[\\\s\u0000-\u001f\u007f]/;
/** The authority of an absolute or scheme-relative URL. */
const AUTHORITY = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/?#]*)/i;

const refuse = (why: string) =>
  new Error(`URL refused: the media points at a blocked address (${why})`);

/**
 * Every host yt-dlp could fetch from when it loads the metadata (formats,
 * fragments, subtitle tracks, ...), one resolved URL per origin. Fragment
 * `path` and relative `url` values are joined onto the format's
 * fragment_base_url (or its url) the way yt-dlp joins them. Fails closed: a
 * value that does not resolve to an absolute URL, metadata nested too deep or
 * pointing at too many hosts refuses the item instead of being skipped.
 * Thumbnails are not walked: they are never downloaded.
 */
export function infoUrls(info: unknown): string[] {
  const byOrigin = new Map<string, string>();
  const add = (raw: string, base: string | undefined) => {
    if (raw === "") return;
    // The check reads the WHATWG-parsed URL; yt-dlp (Python) fetches the raw
    // string. Refuse the forms the two parsers can read as different hosts.
    if (AMBIGUOUS_CHARS.test(raw))
      throw refuse(`"${raw.slice(0, 80)}" has characters the check cannot vouch for`);
    const authority = raw.match(AUTHORITY)?.[1];
    if (authority !== undefined && /[@%]/.test(authority)) {
      throw refuse(`"${raw.slice(0, 80)}" has credentials or escapes in its host`);
    }
    let url: URL;
    try {
      url = base ? new URL(raw, base) : new URL(raw);
    } catch {
      throw refuse(`"${raw.slice(0, 80)}" is not an absolute URL`);
    }
    if (!byOrigin.has(url.origin)) {
      if (byOrigin.size >= MAX_INFO_ORIGINS) throw refuse(`over ${MAX_INFO_ORIGINS} hosts`);
      byOrigin.set(url.origin, url.href);
    }
  };
  const walk = (v: unknown, key: string, depth: number, base: string | undefined) => {
    if (depth > MAX_INFO_DEPTH) throw refuse("the metadata is nested too deeply to check");
    if (typeof v === "string") {
      if (URL_KEY.test(key) || (key === "path" && base !== undefined)) add(v, base);
    } else if (Array.isArray(v)) {
      for (const x of v) walk(x, key, depth + 1, base);
    } else if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      // Fragments below this object resolve against its base.
      const own =
        typeof o.fragment_base_url === "string"
          ? o.fragment_base_url
          : typeof o.url === "string"
            ? o.url
            : undefined;
      let childBase = base;
      if (own !== undefined) {
        try {
          childBase = new URL(own, base).href;
        } catch {
          childBase = undefined; // reported by add() when its key is walked
        }
      }
      for (const [k, x] of Object.entries(o)) {
        if (k === "thumbnails" || k === "thumbnail") continue;
        walk(x, k, depth + 1, k === "fragments" ? childBase : base);
      }
    }
  };
  walk(info, "", 0, undefined);
  return [...byOrigin.values()];
}

/**
 * The page passed the URL check, but the media and subtitle files it points
 * at can live on other hosts. Check each host before yt-dlp downloads from
 * it. Audio downloads are limited to direct http(s) formats (no HLS
 * playlists, whose segment URLs are not in the metadata). This early check
 * gives a clear refusal; the pinning proxy enforces the same rule on every
 * connection yt-dlp actually makes, redirects included.
 */
export async function checkInfoUrls(info: unknown): Promise<void> {
  for (const raw of infoUrls(info)) {
    const v = await checkUrl(raw, { allowLocal: false }, { topLevel: true });
    if (!v.ok) throw refuse(v.reason);
  }
}

async function downloadSubtitles(
  ctx: PackContext,
  work: string,
  proxy: string,
  infoPath: string,
  pick: { key: string; auto: boolean },
): Promise<string | null> {
  // The key reached --sub-langs argv: it must be a plain language code.
  if (!SUB_KEY.test(pick.key)) {
    throw new Error(
      `refusing subtitle key ${JSON.stringify(pick.key.slice(0, 80))}: not a plain language code`,
    );
  }
  await ytdlp(
    ctx,
    work,
    proxy,
    [
      "--load-info-json",
      infoPath,
      "--skip-download",
      pick.auto ? "--write-auto-subs" : "--write-subs",
      "--sub-langs",
      // A literal key: escape the regex characters yt-dlp would read.
      pick.key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
      "--sub-format",
      "vtt",
      "-o",
      join(work, "sub.%(ext)s"),
    ],
    INFO_TIMEOUT_MS,
  );
  const file = (await readdir(work)).find((f) => f.startsWith("sub.") && f.endsWith(".vtt"));
  return file ? readFile(join(work, file), "utf8") : null;
}

async function downloadAudio(
  ctx: PackContext,
  work: string,
  proxy: string,
  infoPath: string,
): Promise<string> {
  const dir = join(work, "dl");
  await ytdlp(
    ctx,
    work,
    proxy,
    [
      "--load-info-json",
      infoPath,
      "-f",
      // Direct downloads only: an HLS playlist names segment hosts that the
      // metadata check never saw.
      "bestaudio[protocol^=http]/best[protocol^=http]",
      "--max-filesize",
      MAX_AUDIO_BYTES,
      "--no-part",
      "-o",
      join(dir, "audio.%(ext)s"),
    ],
    DOWNLOAD_TIMEOUT_MS,
  );
  const file = (await readdir(dir).catch(() => [] as string[])).find((f) => f.startsWith("audio."));
  if (!file) throw new Error("yt-dlp did not download any audio (the file may be over 500 MB)");
  return join(dir, file);
}

// ---------------------------------------------------------------------------
// media.transcript
// ---------------------------------------------------------------------------

export async function mediaTranscript(
  ctx: PackContext,
  input: MediaTranscriptInput,
): Promise<MediaTranscriptResult> {
  const verdict = await checkUrl(input.url, { allowLocal: false }, { topLevel: true });
  if (!verdict.ok) throw new Error(`URL refused: ${verdict.reason}`);
  // The language reaches the speech engines' argv when there are no
  // subtitles, so refuse anything that is not a plain code up front.
  if (input.language !== undefined) {
    const problem = speechLanguageProblem(input.language);
    if (problem) throw new Error(problem);
  }
  await requireBinary(ctx, "yt-dlp", HINTS.ytdlp);
  return withWorkDir(ctx, async (work) => {
    const pin = await startPinProxy(pinDecide);
    try {
      return await transcribeUrl(ctx, input, work, pin.url);
    } finally {
      await pin.close();
    }
  });
}

/** The proxy's verdict: the same address rule, pinned to the checked IP. */
export async function pinDecide(url: string) {
  const v = await checkUrl(url, { allowLocal: false }, { topLevel: true });
  if (!v.ok) return { ok: false as const, reason: v.reason };
  const address = v.addresses[0];
  return address
    ? { ok: true as const, address }
    : { ok: false as const, reason: "the URL has no network address" };
}

async function transcribeUrl(
  ctx: PackContext,
  input: MediaTranscriptInput,
  work: string,
  proxy: string,
): Promise<MediaTranscriptResult> {
  ctx.progress?.(0.05, "reading the page");
  const { info, path: infoPath } = await fetchInfo(ctx, work, proxy, input.url);
  if (info.is_live) throw unsupported("transcripts of live streams");
  await checkInfoUrls(info);
  const title = typeof info.title === "string" ? info.title : null;
  const keep = input.timestamps !== false;
  // A model that names an engine (or any model) means "transcribe the audio".
  const forceSpeech = input.model !== undefined;

  const pick = forceSpeech ? null : pickSubtitles(info, input.language);
  if (pick) {
    ctx.progress?.(0.3, "downloading subtitles");
    const vtt = await downloadSubtitles(ctx, work, proxy, infoPath, pick);
    const segments = vtt ? parseVtt(vtt) : [];
    if (segments.length > 0) {
      return {
        text: segmentsText(segments),
        ...(keep ? { segments } : {}),
        language: pick.language,
        title,
        model: pick.auto ? "yt-dlp automatic captions" : "yt-dlp subtitles",
        source: pick.auto ? "automatic_captions" : "subtitles",
      };
    }
  }

  if (typeof info.duration === "number" && info.duration > MAX_OUTPUT_SECONDS) {
    throw unsupported(
      `speech to text on media over ${MAX_OUTPUT_SECONDS / 60} minutes without subtitles (this one is ${Math.round(info.duration / 60)} minutes)`,
    );
  }
  const byModel = engineFromModel(input.model);
  const engines = await planEngines(ctx, byModel ? { engine: byModel } : {});
  throwIfCancelled(ctx);
  ctx.progress?.(0.15, "downloading audio");
  const audio = await downloadAudio(ctx, work, proxy, infoPath);
  assertSafePath(audio);
  const probed = await probeFile(ctx, audio);
  if (!probed.hasAudio) throw new Error("the downloaded media has no audio track");
  const seconds = probed.duration_s ?? info.duration ?? MAX_OUTPUT_SECONDS;
  if (seconds > MAX_OUTPUT_SECONDS) {
    throw unsupported(`speech to text on media over ${MAX_OUTPUT_SECONDS / 60} minutes`);
  }
  const wav = join(work, "speech.wav");
  await runFfmpeg(ctx, work, wavArgs(audio, seconds), wav, {
    progress: { from: 0.2, to: 0.3, message: "preparing audio" },
  });
  const { result } = await runEngines(ctx, engines, {
    wav,
    work,
    duration_s: seconds,
    ...(input.language ? { language: input.language } : {}),
    ...(input.model && !byModel ? { model: input.model } : {}),
  });
  return {
    text: result.text,
    ...(keep ? { segments: result.segments } : {}),
    language: result.language,
    title,
    model: result.model,
    source: "speech_to_text",
  };
}
