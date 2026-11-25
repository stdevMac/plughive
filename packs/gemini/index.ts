// packs/gemini/index.ts
import { definePack, defineTool } from "plughive/pack";
import { providers } from "./capabilities.js";
import { LIFETIME_FETCH } from "./client.js";
import {
  DEFAULTS,
  MODELS,
  chat,
  collectInteraction,
  generateImage,
  generateMusic,
  generateSpeech,
  generateVideo,
  listModels,
  transcribe,
} from "./ops.js";
import {
  chatSchema,
  collectSchema,
  imageSchema,
  listModelsSchema,
  musicSchema,
  speechSchema,
  transcribeSchema,
  videoSchema,
} from "./schemas.js";

const SECRETS = ["GEMINI_API_KEY"] as const;
const paid = { readOnlyHint: false, destructiveHint: false, openWorldHint: true } as const;
/** These tools call the billed Gemini API directly (not through the capability router), so the policy gate needs the "paid" tag to see them. */
const PAID = ["gemini", "paid"] as const;

const listModelsTool = defineTool({
  name: "gemini_list_models",
  description:
    "List Gemini models from the live API (cached 10 min) plus the curated ids this pack defaults to per task " +
    "(image, video, speech, music, transcribe, chat). Use before picking a non-default model.",
  secrets: SECRETS,
  input: listModelsSchema,
  annotations: { readOnlyHint: true, openWorldHint: true },
  async run(input, ctx) {
    const { models, cached } = await listModels(ctx, input.refresh ?? false);
    const f = input.filter?.toLowerCase();
    const live = (
      f ? models.filter((m) => `${m.id} ${m.name}`.toLowerCase().includes(f)) : models
    ).slice(0, 200);
    return {
      cached,
      count: live.length,
      live,
      curated: MODELS,
      defaults: DEFAULTS,
      note: "The live list may omit Interactions-only models (image, video, music); the curated ids come from the docs.",
    };
  },
});

const imageTool = defineTool({
  name: "gemini_generate_image",
  description:
    "Generate or edit images with Gemini (Nano Banana). Default model gemini-nano-banana-2.1; about $0.034 per 1K image, " +
    "$0.05 at 2K, $0.11 at 4K. Pass image_inputs (library artifact ids) to edit or combine pictures. Saves to the library.",
  capability: "image.generate",
  secrets: SECRETS,
  longRunning: true,
  input: imageSchema,
  tags: PAID,
  annotations: paid,
  run: (input, ctx) => generateImage(input, ctx, "gemini_generate_image"),
});

const videoTool = defineTool({
  name: "gemini_generate_video",
  description:
    "Generate a 3 to 15 second video with Gemini Omni (gemini-omni-1.2-flash). About $0.07 per second at 720p, " +
    "$0.10 at 1080p, $0.21 at 4k. Optional image_input (first frame) and end_image_input (last frame) are library artifact ids. Takes minutes; " +
    "a job that outlives the wait is not cancelled, collect it with gemini_get_interaction.",
  capability: "video.generate",
  secrets: SECRETS,
  longRunning: true,
  input: videoSchema,
  tags: PAID,
  annotations: paid,
  run: (input, ctx) => generateVideo(input, ctx, "gemini_generate_video"),
});

const speechTool = defineTool({
  name: "gemini_generate_speech",
  description:
    "Text to speech with Gemini TTS (default gemini-3.8-flash-tts, voice Kore). Returns a 24 kHz mono WAV. " +
    "Use `style` for delivery, or `speakers` (two named voices) for a dialogue.",
  capability: "speech.generate",
  secrets: SECRETS,
  input: speechSchema,
  tags: PAID,
  annotations: paid,
  run: (input, ctx) => generateSpeech(input, ctx, "gemini_generate_speech"),
});

const musicTool = defineTool({
  name: "gemini_generate_music",
  description:
    "Generate music with Lyria. lyria-3.5 makes a full song (about 2 min, $0.08); lyria-3-clip-preview a 30 s clip ($0.04). " +
    "Length cannot be set exactly. Returns MP3 (or WAV) in the library plus any lyrics text. A job that outlives the wait can be collected with gemini_get_interaction.",
  capability: "music.generate",
  secrets: SECRETS,
  longRunning: true,
  input: musicSchema,
  tags: PAID,
  annotations: paid,
  run: (input, ctx) => generateMusic(input, ctx, "gemini_generate_music"),
});

const transcribeTool = defineTool({
  name: "gemini_transcribe",
  description:
    "Transcribe a library audio or video artifact (up to 15 MB) with gemini-3.5-transcribe. Set speakers and/or timestamps for segments.",
  capability: "audio.transcribe",
  secrets: SECRETS,
  longRunning: true,
  input: transcribeSchema,
  tags: PAID,
  annotations: { readOnlyHint: false, openWorldHint: true },
  run: (input, ctx) => transcribe(input, ctx),
});

const chatTool = defineTool({
  name: "gemini_chat",
  description:
    "Chat completion with a Gemini text model (default gemini-4-hydrogen; gemini-4-carbon for hard reasoning, gemini-3.5-flash-lite for cheap bulk). " +
    "Set json=true for a JSON reply. Returns text and token usage.",
  capability: "chat",
  secrets: SECRETS,
  input: chatSchema,
  // A paid call on the user's key, so not read-only.
  tags: PAID,
  annotations: paid,
  run: (input, ctx) => chat(input, ctx),
});

const collectTool = defineTool({
  name: "gemini_get_interaction",
  description:
    "Collect a Gemini video or music job by its interaction id (returned by gemini_generate_video / gemini_generate_music, " +
    "or named in their timeout or cancel error). Saves the finished output to the library, or reports that it is still running. " +
    "Never resubmits the job, so it does not bill again.",
  secrets: SECRETS,
  input: collectSchema,
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  run: (input, ctx) => collectInteraction(input, ctx),
});

export default definePack({
  // The per-call ctx.fetch stops working once a call is cancelled; the fetch
  // captured here lives as long as the pack, so cancel requests still go out.
  setup(ctx) {
    return { [LIFETIME_FETCH]: ctx.fetch };
  },
  tools: [
    listModelsTool,
    imageTool,
    videoTool,
    speechTool,
    musicTool,
    transcribeTool,
    chatTool,
    collectTool,
  ],
  providers,
});
