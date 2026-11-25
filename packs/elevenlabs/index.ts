// packs/elevenlabs/index.ts
import { definePack, defineTool } from "plughive/pack";
import { providers } from "./capabilities.js";
import {
  LIFETIME_FETCH,
  dub,
  getDub,
  isolateVoice,
  listModels,
  listVoices,
  music,
  soundEffect,
  textToSpeech,
  transcribe,
  usage,
} from "./ops.js";
import {
  dubSchema,
  getDubSchema,
  isolateSchema,
  listModelsSchema,
  listVoicesSchema,
  musicSchema,
  sfxSchema,
  transcribeSchema,
  ttsSchema,
  usageSchema,
} from "./schemas.js";

const SECRETS = ["ELEVENLABS_API_KEY"] as const;
const paid = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
// These tools call the billed ElevenLabs API directly (not through the capability
// router), so the policy gate needs the "paid" tag to see them.
const PAID = ["elevenlabs", "paid"] as const;
const readOnly = { readOnlyHint: true, openWorldHint: true } as const;

export default definePack({
  providers,
  tools: [
    defineTool({
      name: "elevenlabs_list_models",
      description:
        "List ElevenLabs speech models (cached 10 min) with language counts and text limits, plus this pack's defaults.",
      secrets: SECRETS,
      input: listModelsSchema,
      annotations: readOnly,
      run: (input, ctx) => listModels(input, ctx),
    }),
    defineTool({
      name: "elevenlabs_list_voices",
      description:
        "Search the voices available to this key. Filter by search text, category, gender, accent or use_case. " +
        "Returns compact rows (id, name, labels, preview_url); pass an id to elevenlabs_text_to_speech.",
      secrets: SECRETS,
      input: listVoicesSchema,
      annotations: readOnly,
      run: (input, ctx) => listVoices(input, ctx),
    }),
    defineTool({
      name: "elevenlabs_text_to_speech",
      description:
        "Speak text with an ElevenLabs voice (default model eleven_multilingual_v2, up to 5000 characters). " +
        "Costs credits per character; the result reports characters_used. Saves MP3 or WAV to the library.",
      capability: "speech.generate",
      secrets: SECRETS,
      input: ttsSchema,
      tags: PAID,
      annotations: paid,
      run: (input, ctx) => textToSpeech(input, ctx),
    }),
    defineTool({
      name: "elevenlabs_sound_effect",
      description:
        "Generate a sound effect from a text description, 0.5 to 30 seconds. Saves audio to the library.",
      secrets: SECRETS,
      input: sfxSchema,
      tags: PAID,
      annotations: paid,
      run: (input, ctx) => soundEffect(input, ctx),
    }),
    defineTool({
      name: "elevenlabs_music",
      description:
        "Compose music from a prompt (model music_v2_5), 3 to 600 seconds, optionally instrumental only. " +
        "Can take over a minute. Saves MP3 to the library and returns the song_id.",
      capability: "music.generate",
      secrets: SECRETS,
      longRunning: true,
      input: musicSchema,
      tags: PAID,
      annotations: paid,
      run: (input, ctx) => music(input, ctx),
    }),
    defineTool({
      name: "elevenlabs_dub",
      description:
        "Dub a library audio or video artifact (up to 50 MB) into another language, keeping the speakers' voices. " +
        "Submits a job, polls until done, then saves the dubbed audio as FLAC (audio only, even for video input). Takes minutes and uses credits per minute of media. " +
        "If it outlives max_wait_seconds the job keeps running and is billed: collect it with elevenlabs_get_dub instead of dubbing again.",
      secrets: SECRETS,
      longRunning: true,
      input: dubSchema,
      tags: PAID,
      annotations: paid,
      run: (input, ctx) => dub(input, ctx),
    }),
    defineTool({
      name: "elevenlabs_get_dub",
      description:
        "Collect an earlier dubbing project by its id (for example after elevenlabs_dub timed out). " +
        "Reports the status while it runs; once completed, downloads the dubbed FLAC into the library. Never submits a new job.",
      secrets: SECRETS,
      input: getDubSchema,
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      run: (input, ctx) => getDub(input, ctx),
    }),
    defineTool({
      name: "elevenlabs_transcribe",
      description:
        "Transcribe a library audio or video artifact (up to 50 MB) with Scribe. Set diarize for speaker labels or timestamps for timed segments.",
      capability: "audio.transcribe",
      secrets: SECRETS,
      longRunning: true,
      input: transcribeSchema,
      tags: PAID,
      annotations: paid,
      run: (input, ctx) => transcribe(input, ctx),
    }),
    defineTool({
      name: "elevenlabs_isolate_voice",
      description:
        "Remove background noise and music from a library audio or video artifact, keeping only the voice. Saves audio to the library.",
      secrets: SECRETS,
      longRunning: true,
      input: isolateSchema,
      tags: PAID,
      annotations: paid,
      run: (input, ctx) => isolateVoice(input, ctx),
    }),
    defineTool({
      name: "elevenlabs_usage",
      description:
        "Show the subscription tier, characters used and remaining, and when the quota resets. Check before large jobs.",
      secrets: SECRETS,
      input: usageSchema,
      annotations: readOnly,
      run: (_input, ctx) => usage(ctx),
    }),
  ],
  setup(ctx) {
    // A fetch bound to the pack lifetime, so the cleanup DELETE after a cancel still goes out.
    return { [LIFETIME_FETCH]: ctx.fetch };
  },
});
