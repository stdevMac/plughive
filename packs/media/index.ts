// packs/media/index.ts
//
// Provider-neutral media tools over ctx.capabilities. This pack holds no
// secrets and reaches no network: the router picks a provider pack (explicit
// provider or model, then the user's preference order, then priority) and
// runs it with THAT pack's context. Only retryable failures fall back, and
// only before a provider has accepted the job.
import {
  AudioSeparateStemsInputSchema,
  AudioTranscribeInputSchema,
  CAPABILITY_NAMES,
  CapabilityError,
  type CapabilityName,
  ChatInputSchema,
  DocumentConvertInputSchema,
  DocumentParseInputSchema,
  ImageEditInputSchema,
  ImageGenerateInputSchema,
  ImageRemoveBackgroundInputSchema,
  ImageUpscaleInputSchema,
  MediaTranscriptInputSchema,
  MusicGenerateInputSchema,
  type PackContext,
  SoundEffectInputSchema,
  SpeechGenerateInputSchema,
  TextEmbedInputSchema,
  TextRerankInputSchema,
  TextTranslateInputSchema,
  ThreeDGenerateInputSchema,
  VideoGenerateInputSchema,
  VideoLipsyncInputSchema,
  VideoUpscaleInputSchema,
  VoiceCloneInputSchema,
  WebFetchInputSchema,
  WebSearchInputSchema,
  definePack,
  defineTool,
  z,
} from "plughive/pack";

const providerField = z
  .string()
  .regex(/^[a-z][a-z0-9_-]{0,39}$/, "provider ids are lowercase letters, digits, _ and -")
  .optional()
  .describe(
    "Run only this provider (no fallback), such as gemini, elevenlabs or local. Omit to route automatically. list_media_providers shows the ids.",
  );

// Not part of any capability input (those schemas are strict): taken out here
// and handed to the router, which skips providers that cost more or cannot
// say what they cost (docs/spend-and-approvals.md).
const maxCostField = z
  .number()
  .min(0)
  .max(10_000)
  .optional()
  .describe(
    "Most this one call may cost, in USD. Providers estimated above it, or with no estimate, are skipped; local providers count as 0.",
  );

// Not part of any capability input either: `cache: false` asks for a fresh
// paid call instead of a saved result of the same call.
const cacheField = z
  .boolean()
  .optional()
  .describe(
    "Paid results are reused for 24 h when the same call is made again (marked cached: true, no new charge). Pass false for a fresh take.",
  );

const routeFields = { provider: providerField, max_cost_usd: maxCostField, cache: cacheField };

const LIST_HINT = "Call list_media_providers to see which providers are installed and set up.";

/** Run a capability, adding a pointer to list_media_providers when nothing can serve it. */
async function route<C extends CapabilityName>(
  ctx: PackContext,
  capability: C,
  input: Record<string, unknown> & {
    provider?: string | undefined;
    max_cost_usd?: number | undefined;
    cache?: boolean | undefined;
  },
) {
  const { provider, max_cost_usd: maxCostUsd, cache, ...rest } = input;
  const opts = {
    ...(provider ? { provider } : {}),
    ...(maxCostUsd !== undefined ? { maxCostUsd } : {}),
    ...(cache === false ? { cache: false } : {}),
  };
  try {
    // biome-ignore lint/suspicious/noExplicitAny: the router validates against the capability schema
    return await ctx.capabilities.run(capability, rest as any, opts);
  } catch (err) {
    if (
      err instanceof CapabilityError &&
      (err.code === "NO_PROVIDER" ||
        err.code === "UNKNOWN_PROVIDER" ||
        err.code === "NO_PROVIDER_FOR_MODEL")
    ) {
      throw new CapabilityError(`${err.message.replace(/[.\s]+$/, "")}. ${LIST_HINT}`, {
        code: err.code,
      });
    }
    throw err;
  }
}

const generateImage = defineTool({
  name: "generate_image",
  description:
    "Generate or edit images with the best configured provider. Pass image_inputs (library artifact ids) to edit or use references. Returns saved library artifacts.",
  capability: "image.generate",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: ImageGenerateInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "image.generate", input),
});

const generateVideo = defineTool({
  name: "generate_video",
  description:
    "Generate a short video clip with the best configured provider, optionally from a first and last frame (library image artifact ids). Returns a saved library artifact.",
  capability: "video.generate",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: VideoGenerateInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "video.generate", input),
});

const generateSpeech = defineTool({
  name: "generate_speech",
  description:
    "Turn text into spoken audio with the best configured provider (voice and model are provider ids). Returns a saved library artifact.",
  capability: "speech.generate",
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: SpeechGenerateInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "speech.generate", input),
});

const generateMusic = defineTool({
  name: "generate_music",
  description:
    "Generate music from a text prompt with the best configured provider. Returns a saved library artifact.",
  capability: "music.generate",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: MusicGenerateInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "music.generate", input),
});

const transcribeAudio = defineTool({
  name: "transcribe_audio",
  description:
    "Transcribe an audio or video library artifact to text, optionally with timestamps and speaker labels, with the best configured provider.",
  capability: "audio.transcribe",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: AudioTranscribeInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "audio.transcribe", input),
});

const chat = defineTool({
  name: "chat",
  description:
    "Send messages to a chat model through the best configured provider. Set json for a JSON reply.",
  capability: "chat",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: ChatInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "chat", input),
});

const editImage = defineTool({
  name: "edit_image",
  description:
    "Edit a library image from a text instruction (change, add or remove things; optional mask and reference images) with the best configured provider. Returns saved library artifacts.",
  capability: "image.edit",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: ImageEditInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "image.edit", input),
});

const upscaleImage = defineTool({
  name: "upscale_image",
  description:
    "Upscale a library image 2x to 4x with the best configured provider (local Real-ESRGAN first when installed). Returns a saved library artifact.",
  capability: "image.upscale",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: ImageUpscaleInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "image.upscale", input),
});

const removeBackground = defineTool({
  name: "remove_background",
  description:
    "Cut the subject out of a library image onto a transparent background (PNG) with the best configured provider. Returns a saved library artifact.",
  capability: "image.remove_background",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: ImageRemoveBackgroundInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "image.remove_background", input),
});

const upscaleVideo = defineTool({
  name: "upscale_video",
  description:
    "Upscale a library video 2x to 4x with the best configured provider (local ffmpeg resizes; AI providers restore detail). Returns a saved library artifact.",
  capability: "video.upscale",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: VideoUpscaleInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "video.upscale", input),
});

const lipsyncVideo = defineTool({
  name: "lipsync_video",
  description:
    "Make the face in a library video (or image) speak a library audio track, with the best configured provider. Returns a saved library artifact.",
  capability: "video.lipsync",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: VideoLipsyncInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "video.lipsync", input),
});

const separateStems = defineTool({
  name: "separate_stems",
  description:
    "Split a library song into stems (vocals, drums, bass, other; or two_stems for vocals and instrumental) with the best configured provider. Returns one saved artifact per stem.",
  capability: "audio.separate_stems",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: AudioSeparateStemsInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "audio.separate_stems", input),
});

const cloneVoice = defineTool({
  name: "clone_voice",
  description:
    "Create a reusable voice from library audio samples of one speaker. Only clone voices you have permission to use. Returns the new voice_id for generate_speech.",
  capability: "voice.clone",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: VoiceCloneInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "voice.clone", input),
});

const generateSoundEffect = defineTool({
  name: "generate_sound_effect",
  description:
    "Generate a sound effect from a text description with the best configured provider. Returns a saved library artifact.",
  capability: "sound.effect",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: SoundEffectInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "sound.effect", input),
});

const generate3d = defineTool({
  name: "generate_3d",
  description:
    "Generate a 3D model (GLB by default) from a text prompt, a library image, or both, with the best configured provider. Returns a saved library artifact.",
  capability: "3d.generate",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: ThreeDGenerateInputSchema.extend(routeFields),
  run: (input, ctx) => {
    if (!input.prompt && !input.artifact_id) {
      throw new CapabilityError("Give a prompt, an image artifact_id, or both.", {
        code: "INVALID_INPUT",
      });
    }
    return route(ctx, "3d.generate", input);
  },
});

const parseDocument = defineTool({
  name: "parse_document",
  description:
    "Extract the text of a library PDF or image as Markdown or plain text (OCR for scans) with the best configured provider.",
  capability: "document.parse",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: DocumentParseInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "document.parse", input),
});

const convertDocument = defineTool({
  name: "convert_document",
  description:
    "Convert a library document to another format (pdf, docx, html, md, ...) with the best configured provider (LibreOffice or pandoc locally). Returns a saved library artifact.",
  capability: "document.convert",
  longRunning: true,
  annotations: { readOnlyHint: false, openWorldHint: true },
  input: DocumentConvertInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "document.convert", input),
});

const translateText = defineTool({
  name: "translate_text",
  description:
    "Translate text into another language with the best configured provider (DeepL, a chat model, or a local Ollama model).",
  capability: "text.translate",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: TextTranslateInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "text.translate", input),
});

const embedText = defineTool({
  name: "embed_text",
  description:
    "Turn texts into embedding vectors with the best configured provider. Use the same provider and model for texts you compare.",
  capability: "text.embed",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: TextEmbedInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "text.embed", input),
});

const rerankText = defineTool({
  name: "rerank_text",
  description:
    "Order documents by relevance to a query with the best configured provider. Returns indexes into documents with scores, best first.",
  capability: "text.rerank",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: TextRerankInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "text.rerank", input),
});

const searchWeb = defineTool({
  name: "search_web",
  description:
    "Search the web with the best configured search provider (Exa, Tavily, Brave, Parallel, Firecrawl). Returns titles, URLs and snippets.",
  capability: "web.search",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: WebSearchInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "web.search", input),
});

const fetchWeb = defineTool({
  name: "fetch_web",
  description:
    "Fetch a web page as clean Markdown (or text or HTML) with the best configured provider (a local browser, Jina or Firecrawl).",
  capability: "web.fetch",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: WebFetchInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "web.fetch", input),
});

const getMediaTranscript = defineTool({
  name: "get_media_transcript",
  description:
    "Get the transcript of an online video or podcast by URL (YouTube and others) with the best configured provider: published captions when there are any, otherwise a transcription.",
  capability: "media.transcript",
  longRunning: true,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: MediaTranscriptInputSchema.extend(routeFields),
  run: (input, ctx) => route(ctx, "media.transcript", input),
});

const listMediaProviders = defineTool({
  name: "list_media_providers",
  description:
    "List the providers behind the media tools: which are set up, their priority, models and cooldowns, per capability.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  input: z.object({
    capability: z.enum(CAPABILITY_NAMES).optional().describe("Only this capability."),
  }),
  async run(input, ctx) {
    const rows = await ctx.capabilities.list(input.capability);
    const caps = input.capability ? [input.capability] : [...CAPABILITY_NAMES];
    return {
      capabilities: caps.map((capability) => {
        const providers = rows
          .filter((r) => r.capability === capability)
          .map((r) => ({
            id: r.id,
            pack: r.pack,
            configured: r.configured,
            priority: r.priority,
            preferred: r.preferred,
            auto_route: r.autoRoute,
            cooling_down_until: r.coolingDownUntil,
            models: r.models,
          }));
        return {
          capability,
          ready: providers.some((p) => p.configured && p.auto_route && !p.cooling_down_until),
          providers,
        };
      }),
    };
  },
});

export default definePack({
  tools: [
    generateImage,
    generateVideo,
    generateSpeech,
    generateMusic,
    transcribeAudio,
    chat,
    editImage,
    upscaleImage,
    removeBackground,
    upscaleVideo,
    lipsyncVideo,
    separateStems,
    cloneVoice,
    generateSoundEffect,
    generate3d,
    parseDocument,
    convertDocument,
    translateText,
    embedText,
    rerankText,
    searchWeb,
    fetchWeb,
    getMediaTranscript,
    listMediaProviders,
  ],
});
