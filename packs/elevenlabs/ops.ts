// packs/elevenlabs/ops.ts
// The ElevenLabs REST calls. The key is read from ctx.secrets per call and sent
// in the xi-api-key header only: never in a URL, a log line or an error.
import type { PackContext, PackFetch } from "plughive/pack";
import type { z } from "plughive/pack";
import type {
  dubSchema,
  getDubSchema,
  isolateSchema,
  listModelsSchema,
  listVoicesSchema,
  musicSchema,
  sfxSchema,
  transcribeSchema,
  ttsSchema,
} from "./schemas.js";
import {
  type AudioResult,
  ElevenError,
  loadArtifact,
  mapHttpError,
  readCapped,
  scrub,
  sleep,
  throwIfAborted,
} from "./util.js";

const BASE = "https://api.elevenlabs.io";
const SECRET = "ELEVENLABS_API_KEY";
const MAX_AUDIO_BYTES = 100 * 1024 * 1024;

export const DEFAULTS = {
  tts_model: "eleven_multilingual_v2",
  tts_voice: "JBFqnCBsd6RMkjVDRZzb",
  music_model: "music_v2_5",
  stt_model: "scribe_v3",
  sfx_model: "eleven_text_to_sound_v3",
} as const;

// --- http ---------------------------------------------------------------------

interface CallInit {
  method?: "GET" | "POST" | "DELETE";
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  form?: FormData;
  accept?: string;
  /** Cleanup calls run even after the caller cancelled. */
  ignoreAbort?: boolean;
  /** Whole-request budget (headers and body). Default DEFAULT_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Fetch to use instead of the per-call ctx.fetch (the pack-lifetime one for cleanup). */
  fetch?: PackFetch;
}

/** Plain API calls (TTS, lists, polls). */
const DEFAULT_TIMEOUT_MS = 2 * 60_000;
/** Music, transcription uploads and dub downloads, which take minutes. */
const LONG_TIMEOUT_MS = 10 * 60_000;

async function call(ctx: PackContext, path: string, init: CallInit = {}): Promise<Response> {
  if (!init.ignoreAbort) throwIfAborted(ctx.signal);
  const key = await ctx.secrets.get(SECRET);
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(init.query ?? {}))
    if (v !== undefined) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {
    "xi-api-key": key,
    Accept: init.accept ?? "application/json",
  };
  let body: RequestInit["body"] | undefined;
  if (init.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.json);
  } else if (init.form) {
    body = init.form;
  }
  let res: Response;
  try {
    res = await (init.fetch ?? ctx.fetch)(url.toString(), {
      method: init.method ?? "GET",
      headers,
      timeoutMs: init.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      ...(body ? { body } : {}),
    });
  } catch (e) {
    if (ctx.signal?.aborted && !init.ignoreAbort) throw new ElevenError("The call was cancelled.");
    const raw = scrub(e instanceof Error ? e.message : String(e), key).slice(0, 160);
    // A timeout means the request was sent: it may have been processed and
    // billed, so the hint must not invite a blind retry.
    const hint = /timed out/i.test(raw)
      ? " The request may already have been processed and billed; check elevenlabs_usage before running it again, or shorten the input."
      : "";
    throw new ElevenError(`Could not reach ElevenLabs (${raw}).${hint}`, undefined, true);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw mapHttpError(res.status, text, key);
  }
  return res;
}

async function jsonOf<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    throw new ElevenError(
      "ElevenLabs returned a response that was not valid JSON.",
      res.status,
      true,
    );
  }
}

async function saveAudio(
  ctx: PackContext,
  tool: string,
  bytes: Uint8Array,
  mime: string,
  model: string,
  prompt: string,
  meta: Record<string, unknown>,
) {
  const kind = mime.startsWith("video/") ? "video" : "audio";
  const ref = await ctx.library.save({
    kind,
    mime,
    bytes,
    tool,
    model,
    prompt,
    costUsd: null,
    meta,
  });
  return { id: ref.id, url: ref.url, mime: ref.mime };
}

const mimeOf = (res: Response, fallback: string) =>
  res.headers.get("content-type")?.split(";")[0]?.trim() || fallback;
const intHeader = (res: Response, name: string): number | undefined => {
  const n = Number(res.headers.get(name));
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// --- models ---------------------------------------------------------------------

export interface ModelInfo {
  id: string;
  name: string;
  description: string;
  languages: number;
  text_to_speech: boolean;
  max_characters?: number;
}

let modelCache: { at: number; models: ModelInfo[] } | null = null;
export const clearModelCache = () => {
  modelCache = null;
};

export async function listModels(input: z.infer<typeof listModelsSchema>, ctx: PackContext) {
  const fresh = modelCache && Date.now() - modelCache.at < 600_000 && !input.refresh;
  if (!fresh) {
    const res = await call(ctx, "/v1/models");
    const raw =
      await jsonOf<
        {
          model_id?: string;
          name?: string;
          description?: string;
          languages?: unknown[];
          can_do_text_to_speech?: boolean;
          maximum_text_length_per_request?: number;
        }[]
      >(res);
    const models = (Array.isArray(raw) ? raw : [])
      .filter((m) => typeof m.model_id === "string")
      .map((m) => ({
        id: m.model_id as string,
        name: String(m.name ?? m.model_id),
        description: String(m.description ?? "").slice(0, 160),
        languages: Array.isArray(m.languages) ? m.languages.length : 0,
        text_to_speech: m.can_do_text_to_speech === true,
        ...(typeof m.maximum_text_length_per_request === "number"
          ? { max_characters: m.maximum_text_length_per_request }
          : {}),
      }));
    modelCache = { at: Date.now(), models };
  }
  return {
    cached: Boolean(fresh),
    count: modelCache?.models.length ?? 0,
    models: modelCache?.models ?? [],
    defaults: DEFAULTS,
    note: "Speech-to-text (scribe_*), music (music_*) and sound-effect ids are not listed here; see defaults.",
  };
}

// --- voices ---------------------------------------------------------------------

interface RawVoice {
  voice_id?: string;
  name?: string;
  category?: string;
  description?: string;
  preview_url?: string;
  labels?: Record<string, string>;
}

export async function listVoices(input: z.infer<typeof listVoicesSchema>, ctx: PackContext) {
  // gender, accent and use_cases are server-side filters on GET /v2/voices.
  const res = await call(ctx, "/v2/voices", {
    query: {
      search: input.search,
      category: input.category,
      gender: input.gender,
      accent: input.accent,
      use_cases: input.use_case,
      page_size: input.limit ?? 20,
      next_page_token: input.page_token,
    },
  });
  const raw = await jsonOf<{
    voices?: RawVoice[];
    has_more?: boolean;
    next_page_token?: string | null;
  }>(res);
  const voices = (raw.voices ?? [])
    .filter((v) => typeof v.voice_id === "string")
    .slice(0, input.limit ?? 20)
    .map((v) => ({
      id: v.voice_id as string,
      name: String(v.name ?? ""),
      category: v.category ?? "",
      gender: v.labels?.gender ?? "",
      accent: v.labels?.accent ?? "",
      age: v.labels?.age ?? "",
      use_case: v.labels?.use_case ?? v.labels?.usecase ?? "",
      description: String(v.description ?? v.labels?.descriptive ?? "").slice(0, 120),
      preview_url: v.preview_url ?? "",
    }));
  return {
    count: voices.length,
    voices,
    ...(raw.has_more && raw.next_page_token ? { next_page_token: raw.next_page_token } : {}),
  };
}

// --- text to speech -----------------------------------------------------------

export async function textToSpeech(
  input: z.infer<typeof ttsSchema>,
  ctx: PackContext,
  tool = "elevenlabs_text_to_speech",
): Promise<AudioResult> {
  const model = input.model ?? DEFAULTS.tts_model;
  const voice = input.voice ?? DEFAULTS.tts_voice;
  const wav = input.format === "wav";
  const voiceSettings = {
    ...(input.stability !== undefined ? { stability: input.stability } : {}),
    ...(input.similarity_boost !== undefined ? { similarity_boost: input.similarity_boost } : {}),
    ...(input.style !== undefined ? { style: input.style } : {}),
    ...(input.speed !== undefined ? { speed: input.speed } : {}),
  };
  const res = await call(ctx, `/v1/text-to-speech/${encodeURIComponent(voice)}`, {
    method: "POST",
    query: { output_format: wav ? "wav_24000" : "mp3_44100_128" },
    accept: "audio/*",
    json: {
      text: input.text,
      model_id: model,
      ...(input.language_code ? { language_code: input.language_code } : {}),
      ...(Object.keys(voiceSettings).length ? { voice_settings: voiceSettings } : {}),
      ...(input.seed !== undefined ? { seed: input.seed } : {}),
    },
  });
  const raw = await readCapped(res, MAX_AUDIO_BYTES);
  if (raw.byteLength === 0)
    throw new ElevenError("ElevenLabs returned no audio. Check the text and voice id, then retry.");
  const art = await saveAudio(
    ctx,
    tool,
    raw,
    wav ? "audio/wav" : "audio/mpeg",
    model,
    input.text.slice(0, 500),
    {
      voice,
      format: wav ? "wav" : "mp3",
    },
  );
  return {
    artifacts: [art],
    model,
    provider: "elevenlabs",
    characters_used: intHeader(res, "character-cost") ?? input.text.length,
  };
}

// --- sound effects ------------------------------------------------------------

export async function soundEffect(
  input: z.infer<typeof sfxSchema>,
  ctx: PackContext,
  tool = "elevenlabs_sound_effect",
  model: string = DEFAULTS.sfx_model,
): Promise<AudioResult> {
  const wav = input.format === "wav";
  const res = await call(ctx, "/v1/sound-generation", {
    method: "POST",
    query: { output_format: wav ? "wav_24000" : "mp3_44100_128" },
    accept: "audio/*",
    json: {
      text: input.prompt,
      model_id: model,
      ...(input.duration_seconds !== undefined ? { duration_seconds: input.duration_seconds } : {}),
      ...(input.prompt_influence !== undefined ? { prompt_influence: input.prompt_influence } : {}),
      ...(input.loop !== undefined ? { loop: input.loop } : {}),
    },
  });
  const raw = await readCapped(res, MAX_AUDIO_BYTES);
  if (raw.byteLength === 0)
    throw new ElevenError("ElevenLabs returned no audio. Rephrase the prompt and retry.");
  const art = await saveAudio(
    ctx,
    tool,
    raw,
    wav ? "audio/wav" : "audio/mpeg",
    model,
    input.prompt,
    { duration_seconds: input.duration_seconds ?? null },
  );
  const used = intHeader(res, "character-cost");
  return {
    artifacts: [art],
    model,
    provider: "elevenlabs",
    ...(used ? { characters_used: used } : {}),
  };
}

// --- instant voice cloning ----------------------------------------------------------

/** All samples of one clone together; each one is also capped at MAX_INPUT_BYTES. */
const MAX_CLONE_BYTES = 100 * 1024 * 1024;

/**
 * POST /v1/voices/add (multipart: name, files[], description): an instant
 * voice clone from library audio. Returns the new voice id.
 */
export async function cloneVoice(
  input: { name: string; artifact_ids: string[]; description?: string },
  ctx: PackContext,
): Promise<{
  voice_id: string;
  name: string;
  provider: "elevenlabs";
  requires_verification?: boolean;
}> {
  const form = new FormData();
  form.set("name", input.name);
  let total = 0;
  for (const [i, id] of input.artifact_ids.entries()) {
    const src = await loadArtifact(ctx, id, ["audio"]);
    total += src.bytes.byteLength;
    if (total > MAX_CLONE_BYTES) {
      throw new ElevenError(
        `The voice samples add up to more than ${MAX_CLONE_BYTES / 1048576} MB. Use fewer or shorter clips.`,
      );
    }
    form.append(
      "files",
      new Blob([src.bytes as unknown as ArrayBuffer], { type: src.mime }),
      `sample-${i + 1}.${src.mime.split("/")[1] ?? "bin"}`,
    );
  }
  if (input.description) form.set("description", input.description);
  ctx.progress?.(0.2, "Cloning the voice");
  const r = await jsonOf<{ voice_id?: unknown; requires_verification?: unknown }>(
    await call(ctx, "/v1/voices/add", { method: "POST", form, timeoutMs: LONG_TIMEOUT_MS }),
  );
  if (typeof r.voice_id !== "string" || !r.voice_id) {
    throw new ElevenError(
      "ElevenLabs accepted the clone but returned no voice id. Check the voices in your ElevenLabs account before cloning again.",
    );
  }
  return {
    voice_id: r.voice_id,
    name: input.name,
    provider: "elevenlabs",
    ...(typeof r.requires_verification === "boolean"
      ? { requires_verification: r.requires_verification }
      : {}),
  };
}

// --- music --------------------------------------------------------------------

export async function music(
  input: z.infer<typeof musicSchema>,
  ctx: PackContext,
  tool = "elevenlabs_music",
): Promise<AudioResult> {
  const model = input.model ?? DEFAULTS.music_model;
  ctx.progress?.(0.05, "Composing");
  const res = await call(ctx, "/v1/music", {
    method: "POST",
    timeoutMs: LONG_TIMEOUT_MS,
    query: { output_format: "mp3_44100_128" },
    accept: "audio/*",
    json: {
      prompt: input.prompt,
      model_id: model,
      force_instrumental: input.instrumental ?? false,
      ...(input.duration_seconds !== undefined
        ? { music_length_ms: Math.round(input.duration_seconds * 1000) }
        : {}),
    },
  });
  ctx.progress?.(0.9, "Saving");
  const raw = await readCapped(res, MAX_AUDIO_BYTES);
  if (raw.byteLength === 0)
    throw new ElevenError("ElevenLabs returned no audio. Rephrase the prompt and retry.");
  const songId = res.headers.get("song-id") ?? undefined;
  const art = await saveAudio(ctx, tool, raw, "audio/mpeg", model, input.prompt, {
    duration_seconds: input.duration_seconds ?? null,
    instrumental: input.instrumental ?? false,
    ...(songId ? { song_id: songId } : {}),
  });
  return {
    artifacts: [art],
    model,
    provider: "elevenlabs",
    ...(songId ? { song_id: songId } : {}),
  };
}

// --- dubbing (async) ----------------------------------------------------------

export interface DubOptions {
  pollMs?: number;
}

const SAFE_ID = /^[A-Za-z0-9_-]{1,120}$/;
/** Consecutive failed status checks (network, 429, 5xx) tolerated while a dub runs. */
const MAX_DUB_POLL_FAILURES = 5;
/** Dubbing outputs are signed Google Cloud Storage links under this bucket. */
const DUB_OUTPUT_HOST = "storage.googleapis.com";
const DUB_OUTPUT_PREFIX = "/eleven-dubbing/";

/** The service key setup() stores the pack-lifetime fetch under. */
export const LIFETIME_FETCH = "elevenlabsLifetimeFetch";

/**
 * The fetch captured in setup(). It is bound to the pack's lifetime, so a
 * cleanup request still goes out after the call was aborted (the per-call
 * ctx.fetch refuses to run once the call signal fired).
 */
function lifetimeFetch(ctx: PackContext): PackFetch {
  const f = (ctx as PackContext & { [LIFETIME_FETCH]?: PackFetch })[LIFETIME_FETCH];
  return typeof f === "function" ? f : ctx.fetch;
}

const collectHint = (id: string) =>
  `collect it with elevenlabs_get_dub {dubbing_id: "${id}"} instead of dubbing again (that would bill twice)`;

interface DubProject {
  project_id?: string;
  status?: string;
  language_ids?: string[];
  error?: { error?: string } | null;
}

interface DubTarget {
  status?: string;
  outputs?: { lossless_audio?: string | null } | null;
}

type TargetState =
  | { kind: "completed"; url: string | undefined }
  | { kind: "running"; status: string };

/** Read one language target and map its status. Throws for failed and stale. */
async function readTarget(ctx: PackContext, id: string, langId: string): Promise<TargetState> {
  const s = await jsonOf<DubTarget>(
    await call(ctx, `/v1/dubbing/project/${id}/language/${langId}`),
  );
  switch (s.status) {
    case "completed":
      return { kind: "completed", url: s.outputs?.lossless_audio ?? undefined };
    case "failed":
      throw new ElevenError(
        `ElevenLabs could not dub this file (project ${id}, status failed). Try a shorter or cleaner source, or set source_language.`,
      );
    case "stale":
      throw new ElevenError(
        `The dub output for project ${id} is out of date (status stale: its transcript changed after the audio was rendered). Nothing new was started; re-render it in the ElevenLabs dubbing editor, then collect it with elevenlabs_get_dub {dubbing_id: "${id}"}.`,
      );
    default:
      // queued, processing, or a status this pack does not know yet: keep waiting.
      return { kind: "running", status: s.status ?? "unknown" };
  }
}

/** Read the project; returns its first language id, or undefined while none exists yet. */
async function readProject(
  ctx: PackContext,
  id: string,
  target?: string,
): Promise<string | undefined> {
  const p = await jsonOf<DubProject>(await call(ctx, `/v1/dubbing/project/${id}`));
  if (p.status === "failed") {
    throw new ElevenError(
      `ElevenLabs could not prepare this file for dubbing (project ${id}). Try a shorter or cleaner source, or set source_language.`,
    );
  }
  const ids = (p.language_ids ?? []).filter((l) => typeof l === "string");
  const pick = (target && ids.find((l) => l === target)) || ids[0];
  if (pick && !SAFE_ID.test(pick))
    throw new ElevenError(
      `ElevenLabs returned an unexpected language id for dubbing project ${id}; it was not used. Nothing new was started: check the project in the ElevenLabs dubbing dashboard instead of dubbing again.`,
    );
  return pick;
}

/** Only signed dubbing-bucket links are fetched, and never with the API key. */
function checkOutputUrl(raw: string | undefined, id: string): URL {
  let url: URL | null = null;
  try {
    url = raw ? new URL(raw) : null;
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:") {
    throw new ElevenError(
      `ElevenLabs finished the dub (project ${id}) but returned no download link. Collect it again later with elevenlabs_get_dub.`,
    );
  }
  if (
    url.hostname !== DUB_OUTPUT_HOST ||
    url.port !== "" ||
    !url.pathname.startsWith(DUB_OUTPUT_PREFIX) ||
    url.username !== "" ||
    url.password !== ""
  ) {
    throw new ElevenError(
      `ElevenLabs returned a dub download link outside ${DUB_OUTPUT_HOST}${DUB_OUTPUT_PREFIX} (project ${id}); it was not fetched. Report it.`,
    );
  }
  return url;
}

async function downloadDub(
  ctx: PackContext,
  raw: string | undefined,
  id: string,
  langId: string,
  tool: string,
  target: string | null,
): Promise<AudioResult & { project_id: string }> {
  const url = checkOutputUrl(raw, id);
  ctx.progress?.(0.95, "Downloading");
  let file: Response;
  try {
    // A signed URL: no API key, no redirects.
    file = await ctx.fetch(url.toString(), {
      method: "GET",
      headers: { Accept: "*/*" },
      redirect: "error",
      timeoutMs: LONG_TIMEOUT_MS,
    });
  } catch {
    if (ctx.signal?.aborted) throw new ElevenError("The call was cancelled.");
    throw new ElevenError(
      `The dub finished but its download link could not be fetched (project ${id}; network error or timeout). The link expires after an hour; ${collectHint(id)}.`,
    );
  }
  if (!file.ok)
    throw new ElevenError(
      `The dubbed file could not be downloaded (HTTP ${file.status}, project ${id}); ${collectHint(id)}.`,
    );
  const bytes = await readCapped(file, MAX_AUDIO_BYTES);
  if (bytes.byteLength === 0)
    throw new ElevenError(`The dubbed file was empty (project ${id}); ${collectHint(id)}.`);
  const art = await saveAudio(
    ctx,
    tool,
    bytes,
    "audio/flac",
    "dubbing_v2",
    target ? `dub to ${target}` : `dub ${id}`,
    { project_id: id, language_id: langId, target_language: target },
  );
  return { artifacts: [art], model: "dubbing_v2", provider: "elevenlabs", project_id: id };
}

/**
 * Delete the project after a cancel. ElevenLabs has no cancel endpoint; the
 * DELETE removes the project and its outputs, and its docs say a dub that is
 * already running is still billed.
 */
async function deleteAfterCancel(ctx: PackContext, id: string): Promise<string> {
  try {
    await call(ctx, `/v1/dubbing/project/${id}`, {
      method: "DELETE",
      ignoreAbort: true,
      fetch: lifetimeFetch(ctx),
      timeoutMs: 15_000,
    });
    return `The call was cancelled. A delete request for dubbing project ${id} was sent; ElevenLabs still bills a dub that had already started.`;
  } catch {
    return `The call was cancelled, but the delete request for dubbing project ${id} could not be sent: the dub may finish and be billed. ${collectHint(id).replace(/^c/, "C")}, or delete it in the ElevenLabs dashboard.`;
  }
}

export async function dub(
  input: z.infer<typeof dubSchema>,
  ctx: PackContext,
  tool = "elevenlabs_dub",
  opts: DubOptions = {},
): Promise<AudioResult & { project_id: string }> {
  const src = await loadArtifact(ctx, input.artifact_id, ["audio", "video"]);
  const form = new FormData();
  form.set(
    "file",
    new Blob([src.bytes as unknown as ArrayBuffer], { type: src.mime }),
    `input.${src.mime.split("/")[1] ?? "bin"}`,
  );
  form.set("target_language", input.target_language);
  if (input.source_language) form.set("source_language", input.source_language);
  form.set("reference", "plughive");
  ctx.progress?.(0.02, "Uploading");
  let created: DubProject;
  try {
    created = await jsonOf<DubProject>(
      await call(ctx, "/v1/dubbing/project", { method: "POST", form, timeoutMs: LONG_TIMEOUT_MS }),
    );
  } catch (e) {
    // A 429 was refused before any work; a 5xx, a timeout or a garbled reply
    // may still have created (and started billing) a project we cannot name.
    if (e instanceof ElevenError && e.transient && e.status !== 429 && !ctx.signal?.aborted) {
      throw new ElevenError(
        `${e.message} The dubbing project may have been created anyway: look for a recent project in the ElevenLabs dubbing dashboard (reference "plughive") and collect it with elevenlabs_get_dub before dubbing again, since a second dub bills twice.`,
        e.status,
      );
    }
    throw e;
  }
  const id = created.project_id;
  if (!id || !SAFE_ID.test(id))
    throw new ElevenError(
      'ElevenLabs accepted the dub but returned no usable project id. Look for the project in the ElevenLabs dubbing dashboard (reference "plughive") and collect it with elevenlabs_get_dub instead of dubbing again (that would bill twice).',
    );
  // An odd language id is ignored here; the project is re-read for it below.
  let langId: string | undefined = created.language_ids?.[0];
  if (langId && !SAFE_ID.test(langId)) langId = undefined;

  const pollMs = opts.pollMs ?? 5000;
  const waitS = input.max_wait_seconds ?? 900;
  const deadline = Date.now() + waitS * 1000;
  let attempt = 0;
  let failures = 0;
  let url: string | undefined;
  try {
    for (;;) {
      throwIfAborted(ctx.signal);
      try {
        // The target exists once the project is prepared; re-read the project for its id.
        if (!langId) langId = await readProject(ctx, id, input.target_language);
        if (langId) {
          const t = await readTarget(ctx, id, langId);
          if (t.kind === "completed") {
            url = t.url;
            break;
          }
        }
        failures = 0;
      } catch (e) {
        if (ctx.signal?.aborted) throw e;
        const msg = e instanceof Error ? e.message : String(e);
        if (!(e instanceof ElevenError && e.transient)) {
          // Failed, stale, refused key...: final, but the project still exists.
          throw msg.includes(id)
            ? e
            : new ElevenError(
                `${msg} (dubbing project ${id}; ${collectHint(id)})`,
                (e as ElevenError).status,
              );
        }
        failures++;
        if (failures >= MAX_DUB_POLL_FAILURES) {
          throw new ElevenError(
            `Lost contact with ElevenLabs while dubbing project ${id}: ${failures} status checks in a row failed (last: ${msg}). The dub keeps running on ElevenLabs and is billed; ${collectHint(id)}.`,
          );
        }
        ctx.logger?.warn?.("dub status check failed", { project_id: id, failures });
        await sleep(Math.min(pollMs * 2 ** (failures - 1), 60_000), ctx.signal);
        continue;
      }
      if (Date.now() > deadline) {
        throw new ElevenError(
          `Dubbing project ${id} is still running after ${waitS} seconds. It keeps running on ElevenLabs and is billed; ${collectHint(id)}.`,
        );
      }
      attempt++;
      ctx.progress?.(Math.min(0.9, 0.1 + attempt * 0.05), "Dubbing");
      await sleep(pollMs, ctx.signal);
    }
  } catch (e) {
    if (ctx.signal?.aborted) throw new ElevenError(await deleteAfterCancel(ctx, id));
    throw e;
  }
  return downloadDub(ctx, url, id, langId, tool, input.target_language);
}

export type GetDubResult =
  | (AudioResult & { project_id: string; status: "completed" })
  | { status: string; project_id: string; message: string };

/**
 * Collect a dub that was submitted earlier (for example one that outlived
 * max_wait_seconds). Reads the project and target again, which also yields a
 * fresh signed link. Never submits anything, so it never bills.
 */
export async function getDub(
  input: z.infer<typeof getDubSchema>,
  ctx: PackContext,
  tool = "elevenlabs_get_dub",
): Promise<GetDubResult> {
  const id = input.dubbing_id;
  const langId = await readProject(ctx, id, input.target_language);
  if (!langId) {
    return {
      status: "preparing",
      project_id: id,
      message: "ElevenLabs is still preparing this project. Call this tool again in a minute.",
    };
  }
  const t = await readTarget(ctx, id, langId);
  if (t.kind === "running") {
    return {
      status: t.status,
      project_id: id,
      message: `The dub is ${t.status}. Call this tool again in a minute.`,
    };
  }
  const out = await downloadDub(ctx, t.url, id, langId, tool, input.target_language ?? null);
  return { ...out, status: "completed" };
}

// --- speech to text -----------------------------------------------------------

interface ScribeWord {
  text?: string;
  start?: number;
  end?: number;
  type?: string;
  speaker_id?: string;
}

export interface Segment {
  start: number;
  end: number;
  speaker?: string;
  text: string;
}

function toSegments(words: ScribeWord[]): Segment[] {
  const out: Segment[] = [];
  let cur: Segment | null = null;
  for (const w of words) {
    if (w.type === "audio_event") continue;
    const text = String(w.text ?? "");
    if (w.type === "spacing") {
      if (cur) cur.text += text;
      continue;
    }
    const start: number = w.start ?? cur?.end ?? 0;
    const end = w.end ?? start;
    const gap = cur ? start - cur.end : 0;
    if (!cur || w.speaker_id !== cur.speaker || gap > 1.2) {
      if (cur) out.push(cur);
      cur = { start, end, ...(w.speaker_id ? { speaker: w.speaker_id } : {}), text };
    } else {
      cur.text += text;
      cur.end = end;
    }
  }
  if (cur) out.push(cur);
  return out.map((s) => ({ ...s, text: s.text.trim() })).filter((s) => s.text);
}

export async function transcribe(input: z.infer<typeof transcribeSchema>, ctx: PackContext) {
  const src = await loadArtifact(ctx, input.artifact_id, ["audio", "video"]);
  const model = input.model ?? DEFAULTS.stt_model;
  const wantSegments = Boolean(input.diarize || input.timestamps);
  const form = new FormData();
  form.set(
    "file",
    new Blob([src.bytes as unknown as ArrayBuffer], { type: src.mime }),
    `input.${src.mime.split("/")[1] ?? "bin"}`,
  );
  form.set("model_id", model);
  if (input.language) form.set("language_code", input.language);
  if (input.diarize) form.set("diarize", "true");
  if (wantSegments) form.set("timestamps_granularity", "word");
  ctx.progress?.(0.1, "Transcribing");
  const r = await jsonOf<{ text?: string; language_code?: string; words?: ScribeWord[] }>(
    await call(ctx, "/v1/speech-to-text", { method: "POST", form, timeoutMs: LONG_TIMEOUT_MS }),
  );
  if (typeof r.text !== "string")
    throw new ElevenError(
      "ElevenLabs returned no transcript. Check the audio has speech and retry.",
    );
  return {
    text: r.text.trim(),
    ...(r.language_code ? { language: r.language_code } : {}),
    ...(wantSegments && Array.isArray(r.words) ? { segments: toSegments(r.words) } : {}),
    model,
    provider: "elevenlabs" as const,
  };
}

// --- voice isolation ----------------------------------------------------------

export async function isolateVoice(
  input: z.infer<typeof isolateSchema>,
  ctx: PackContext,
  tool = "elevenlabs_isolate_voice",
): Promise<AudioResult> {
  const src = await loadArtifact(ctx, input.artifact_id, ["audio", "video"]);
  const form = new FormData();
  form.set(
    "audio",
    new Blob([src.bytes as unknown as ArrayBuffer], { type: src.mime }),
    `input.${src.mime.split("/")[1] ?? "bin"}`,
  );
  ctx.progress?.(0.1, "Isolating");
  const res = await call(ctx, "/v1/audio-isolation", {
    method: "POST",
    form,
    accept: "audio/*",
    timeoutMs: LONG_TIMEOUT_MS,
  });
  const bytes = await readCapped(res, MAX_AUDIO_BYTES);
  if (bytes.byteLength === 0)
    throw new ElevenError(
      "ElevenLabs returned no audio. Check the source has audible speech and retry.",
    );
  const art = await saveAudio(
    ctx,
    tool,
    bytes,
    mimeOf(res, "audio/mpeg"),
    "audio-isolation",
    "voice isolation",
    {
      source: input.artifact_id,
    },
  );
  return { artifacts: [art], model: "audio-isolation", provider: "elevenlabs" };
}

// --- usage ----------------------------------------------------------------------

export async function usage(ctx: PackContext) {
  const s = await jsonOf<{
    tier?: string;
    status?: string;
    character_count?: number;
    character_limit?: number;
    next_character_count_reset_unix?: number;
    voice_slots_used?: number;
    voice_limit?: number;
    can_use_instant_voice_cloning?: boolean;
  }>(await call(ctx, "/v1/user/subscription"));
  const used = s.character_count ?? 0;
  const limit = s.character_limit ?? 0;
  return {
    tier: s.tier ?? "unknown",
    status: s.status ?? "unknown",
    characters_used: used,
    characters_limit: limit,
    characters_remaining: Math.max(0, limit - used),
    ...(s.next_character_count_reset_unix
      ? { resets_at: new Date(s.next_character_count_reset_unix * 1000).toISOString() }
      : {}),
    ...(s.voice_limit !== undefined
      ? { voice_slots_used: s.voice_slots_used ?? 0, voice_limit: s.voice_limit }
      : {}),
  };
}
