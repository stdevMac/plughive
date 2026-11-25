// packs/elevenlabs/capabilities.ts
// The capability providers this pack serves (priority 60), plus plain
// (input, ctx) functions over the pack's own schemas for direct use.
// ElevenLabs does not do images, video generation or chat, so only speech,
// music, transcription, sound effects and voice cloning apply. An option ElevenLabs cannot honour throws a
// retryable CapabilityError before any request, so the router tries the next
// provider instead.
import {
  type AnyProviderDefinition,
  CapabilityError,
  type PackContext,
  defineProvider,
} from "plughive/pack";
import {
  estimateClone,
  estimateMusic,
  estimateSoundEffect,
  estimateSpeech,
  estimateTranscribe,
} from "./estimates.js";
import { DEFAULTS, cloneVoice, music, soundEffect, textToSpeech, transcribe } from "./ops.js";
import { musicSchema, transcribeSchema, ttsSchema } from "./schemas.js";

export const PROVIDER_ID = "elevenlabs";
export const PROVIDER_PRIORITY = 60;
const SETUP_HINT = "set ELEVENLABS_API_KEY (https://elevenlabs.io/app/settings/api-keys)";
const TTS_MAX_CHARS = 5000;
const LANG = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Sound-effect models (SFXModelId in https://api.elevenlabs.io/openapi.json), the default first. */
const SFX_MODELS: readonly string[] = [DEFAULTS.sfx_model, "eleven_text_to_sound_v2"];
/** The pack's own sound-effect prompt limit (schemas.ts sfxSchema). */
const SFX_MAX_CHARS = 450;
/** Instant voice cloning (POST /v1/voices/add) takes no model id; this names it. */
const IVC_MODEL = "instant-voice-clone";

/** `{text, voice?, model?, format?}` */
export async function speechGenerate(input: unknown, ctx: PackContext) {
  return textToSpeech(ttsSchema.parse(input), ctx);
}

/** `{prompt, duration_seconds?, model?}` */
export async function musicGenerate(input: unknown, ctx: PackContext) {
  return music(musicSchema.parse(input), ctx);
}

/** `{artifact_id, language?}` -> `{text, segments?}` */
export async function audioTranscribe(input: unknown, ctx: PackContext) {
  const r = await transcribe(transcribeSchema.parse(input), ctx);
  return { text: r.text, ...(r.segments ? { segments: r.segments } : {}) };
}

/** capability name -> function over the pack's own schemas. */
export const capabilities = {
  "speech.generate": speechGenerate,
  "music.generate": musicGenerate,
  "audio.transcribe": audioTranscribe,
} as const;

const unsupported = (what: string) =>
  new CapabilityError(`ElevenLabs cannot do ${what}.`, {
    retryable: true,
    code: "UNSUPPORTED_OPTION",
  });

/** ElevenLabs ids are letters, digits, _ and -: anything else cannot be one of its models or voices. */
function idOrRefuse(value: string | undefined, what: string): string | undefined {
  if (value === undefined) return undefined;
  if (!ID.test(value)) throw unsupported(`the ${what} "${value.slice(0, 64)}"`);
  return value;
}

const base = {
  id: PROVIDER_ID,
  priority: PROVIDER_PRIORITY,
  setupHint: SETUP_HINT,
  isConfigured: (ctx: PackContext) => ctx.secrets.has("ELEVENLABS_API_KEY"),
};

export const providers: readonly AnyProviderDefinition[] = [
  defineProvider({
    ...base,
    capability: "speech.generate",
    models: () => ["eleven_multilingual_v2", "eleven_v3", "eleven_flash_v2_5", "eleven_turbo_v2_5"],
    estimate: (input) => estimateSpeech({ text: input.text, model: input.model }),
    run: (input, ctx) => {
      if (input.text.length > TTS_MAX_CHARS)
        throw unsupported(`more than ${TTS_MAX_CHARS} characters in one request`);
      if (input.format === "flac" || input.format === "opus")
        throw unsupported(`${input.format} output (mp3 or wav)`);
      const voice = idOrRefuse(input.voice, "voice");
      const model = idOrRefuse(input.model, "model");
      return textToSpeech(
        {
          text: input.text,
          ...(voice ? { voice } : {}),
          ...(model ? { model } : {}),
          ...(input.format ? { format: input.format } : {}),
          ...(input.language && LANG.test(input.language) ? { language_code: input.language } : {}),
        },
        ctx,
      );
    },
  }),
  defineProvider({
    ...base,
    capability: "music.generate",
    models: () => [DEFAULTS.music_model],
    estimate: (input) =>
      estimateMusic({ model: input.model, duration_seconds: input.duration_seconds }),
    run: (input, ctx) => {
      if (input.format === "wav") throw unsupported("wav music (mp3 only)");
      const model = idOrRefuse(input.model, "model");
      return music(
        {
          prompt: input.prompt.slice(0, 4100),
          ...(model ? { model } : {}),
          ...(input.duration_seconds !== undefined
            ? { duration_seconds: input.duration_seconds }
            : {}),
          ...(input.instrumental !== undefined ? { instrumental: input.instrumental } : {}),
        },
        ctx,
      );
    },
  }),
  defineProvider({
    ...base,
    capability: "audio.transcribe",
    models: () => [DEFAULTS.stt_model],
    estimate: (input, ctx) =>
      estimateTranscribe({ artifact_id: input.artifact_id, model: input.model }, ctx),
    run: async (input, ctx) => {
      const model = idOrRefuse(input.model, "model");
      const r = await transcribe(
        {
          artifact_id: input.artifact_id,
          ...(input.language && LANG.test(input.language) ? { language: input.language } : {}),
          ...(model ? { model } : {}),
          ...(input.speakers ? { diarize: true } : {}),
          ...(input.timestamps ? { timestamps: true } : {}),
        },
        ctx,
      );
      return r;
    },
  }),
  defineProvider({
    ...base,
    capability: "sound.effect",
    models: () => SFX_MODELS,
    estimate: (input) =>
      SFX_MODELS.includes(input.model ?? DEFAULTS.sfx_model)
        ? estimateSoundEffect({ duration_seconds: input.duration_seconds })
        : null,
    run: async (input, ctx) => {
      if (input.prompt.length > SFX_MAX_CHARS)
        throw unsupported(`a sound-effect prompt over ${SFX_MAX_CHARS} characters`);
      const model = idOrRefuse(input.model, "model") ?? DEFAULTS.sfx_model;
      if (!SFX_MODELS.includes(model))
        throw unsupported(`the sound-effect model "${model}" (use ${SFX_MODELS.join(" or ")})`);
      return soundEffect(
        {
          prompt: input.prompt,
          ...(input.duration_seconds !== undefined
            ? { duration_seconds: input.duration_seconds }
            : {}),
          ...(input.format ? { format: input.format } : {}),
        },
        ctx,
        "elevenlabs_sound_effect",
        model,
      );
    },
  }),
  defineProvider({
    ...base,
    capability: "voice.clone",
    models: () => [IVC_MODEL],
    estimate: (input) => (input.model && input.model !== IVC_MODEL ? null : estimateClone()),
    run: async (input, ctx) => {
      if (input.model && input.model !== IVC_MODEL)
        throw unsupported(`voice cloning with the model "${input.model.slice(0, 64)}"`);
      const r = await cloneVoice(
        {
          name: input.name,
          artifact_ids: input.artifact_ids,
          ...(input.description ? { description: input.description } : {}),
        },
        ctx,
      );
      return { ...r, model: IVC_MODEL };
    },
  }),
];
