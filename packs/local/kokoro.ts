// packs/local/kokoro.ts
//
// Speech synthesis through a local Kokoro-FastAPI server (OpenAI-compatible).
import { defineTool, z } from "plughive/pack";
import type { PackContext } from "plughive/pack";
import {
  DEFAULTS,
  HINTS,
  artifactOut,
  backendFetch,
  baseUrl,
  errorExcerpt,
  readBytes,
  readJson,
  settingString,
} from "./lib/util.js";

const BACKEND = "Kokoro";
const MAX_TEXT = 5000;
const MAX_AUDIO_BYTES = 128 * 1024 * 1024;
const VOICE = /^[A-Za-z0-9_+.-]{1,80}$/;

const FORMATS = {
  mp3: "audio/mpeg",
  wav: "audio/wav",
  flac: "audio/flac",
  opus: "audio/ogg",
} as const;
export type SpeechFormat = keyof typeof FORMATS;

export async function listVoices(ctx: PackContext): Promise<string[]> {
  const res = await backendFetch(
    ctx,
    BACKEND,
    HINTS.kokoro,
    baseUrl(ctx, "kokoroUrl"),
    "/v1/audio/voices",
  );
  if (!res.ok) throw new Error(`Kokoro /v1/audio/voices returned HTTP ${res.status}`);
  const data = await readJson<{ voices?: unknown }>(res);
  const voices = Array.isArray(data.voices) ? data.voices : [];
  return voices.filter((v): v is string => typeof v === "string");
}

export const SpeakInput = z.object({
  text: z.string().min(1).max(MAX_TEXT),
  voice: z.string().regex(VOICE, "a voice name from local_voices").optional(),
  model: z.string().regex(VOICE).optional().describe("Kokoro model name. Default kokoro."),
  format: z.enum(["mp3", "wav", "flac", "opus"]).optional(),
  speed: z.number().min(0.5).max(2).optional(),
});
export type SpeakArgs = z.output<typeof SpeakInput>;

export async function speak(ctx: PackContext, input: SpeakArgs, tool = "local_speak") {
  const format: SpeechFormat = input.format ?? "mp3";
  const voice = input.voice ?? settingString(ctx, "kokoroVoice") ?? DEFAULTS.kokoroVoice;
  const model = input.model ?? "kokoro";
  const res = await backendFetch(
    ctx,
    BACKEND,
    HINTS.kokoro,
    baseUrl(ctx, "kokoroUrl"),
    "/v1/audio/speech",
    {
      json: {
        model,
        input: input.text,
        voice,
        response_format: format,
        ...(input.speed !== undefined ? { speed: input.speed } : {}),
      },
      timeoutMs: 5 * 60_000,
    },
  );
  if (!res.ok) {
    const detail = await errorExcerpt(res);
    throw new Error(
      `Kokoro returned HTTP ${res.status}${detail ? `: ${detail}` : ""}. Check the voice with local_voices.`,
    );
  }
  const bytes = await readBytes(res, MAX_AUDIO_BYTES);
  if (bytes.byteLength === 0) throw new Error("Kokoro returned no audio");
  const ref = await ctx.library.save({
    kind: "audio",
    mime: FORMATS[format],
    bytes,
    tool,
    model,
    prompt: input.text.slice(0, 500),
    meta: { voice, format },
  });
  return { artifact: artifactOut(ref), voice, model, format, bytes: bytes.byteLength };
}

export const kokoroTools = [
  defineTool({
    name: "local_voices",
    description: "List the voices offered by the local Kokoro-FastAPI server.",
    input: z.object({}),
    annotations: { title: "List Kokoro voices", readOnlyHint: true, openWorldHint: false },
    tags: ["local", "kokoro", "tts"],
    async run(_input, ctx) {
      const voices = await listVoices(ctx);
      return {
        voices,
        count: voices.length,
        default_voice: settingString(ctx, "kokoroVoice") ?? DEFAULTS.kokoroVoice,
      };
    },
  }),
  defineTool({
    name: "local_speak",
    capability: "speech.generate",
    description:
      "Turn text (up to 5000 characters) into speech with local Kokoro and save it as an audio artifact. No API key. Pick a voice from local_voices.",
    input: SpeakInput,
    annotations: {
      title: "Text to speech (Kokoro)",
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false,
    },
    tags: ["local", "kokoro", "tts", "audio"],
    run: (input, ctx) => speak(ctx, input),
  }),
];
