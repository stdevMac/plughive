// src/core/capabilities/schemas.ts
//
// The normalised shapes of each capability, shared by every provider and by
// the `media` pack. Exported through `plughive/pack`. Pure zod: no daemon
// state. Reconciled from the gemini, elevenlabs and local packs: a field is
// here when at least two providers understand it, or when it is the obvious
// common knob (model, format). Provider-specific options stay on the
// provider's own tools (gemini_generate_image, elevenlabs_tts, ...).
//
// Inputs are plain objects (unknown keys are dropped). Outputs are loose
// objects: a provider may add fields (lyrics, characters_used, ...), and the
// router only checks the common part.
import { z } from "zod";

/** Every capability the router knows. */
export const CAPABILITY_NAMES = [
  "image.generate",
  "video.generate",
  "speech.generate",
  "music.generate",
  "audio.transcribe",
  "chat",
  "image.edit",
  "image.upscale",
  "image.remove_background",
  "video.upscale",
  "video.lipsync",
  "audio.separate_stems",
  "voice.clone",
  "sound.effect",
  "3d.generate",
  "document.parse",
  "document.convert",
  "text.translate",
  "text.embed",
  "text.rerank",
  "web.search",
  "web.fetch",
  "media.transcript",
] as const;

export type CapabilityName = (typeof CAPABILITY_NAMES)[number];

export function isCapabilityName(name: unknown): name is CapabilityName {
  return typeof name === "string" && (CAPABILITY_NAMES as readonly string[]).includes(name);
}

const artifactId = z.string().min(1).max(128);
const modelId = z
  .string()
  .regex(/^[A-Za-z0-9._:/@-]{1,120}$/, "model ids use letters, digits and . _ : / @ -");

// --- outputs ----------------------------------------------------------------

/** One saved artifact, as every media capability returns it. */
export const CapabilityArtifactSchema = z.looseObject({
  id: z.string().min(1),
  url: z.string().min(1),
  mime: z.string().min(1),
});

/** Common part of every media result. */
export const MediaResultSchema = z.looseObject({
  artifacts: z.array(CapabilityArtifactSchema).min(1),
  model: z.string(),
  provider: z.string(),
  cost_usd: z.number().nullable().optional(),
});

// --- image.generate -------------------------------------------------------------

export const ImageGenerateInputSchema = z.object({
  prompt: z.string().min(1).max(8000),
  model: modelId.optional().describe("Provider model id. Omit for the provider default."),
  aspect_ratio: z
    .string()
    .regex(/^\d{1,2}:\d{1,2}$/, "use a ratio such as 1:1, 16:9, 9:16")
    .optional(),
  n: z.number().int().min(1).max(4).optional().describe("Images to make. Default 1."),
  seed: z.number().int().optional().describe("Ignored by providers without seeds."),
  image_inputs: z
    .array(artifactId)
    .max(6)
    .optional()
    .describe("Library artifact ids to edit or use as references (providers that support it)."),
});
export const ImageGenerateOutputSchema = MediaResultSchema;

// --- video.generate -------------------------------------------------------------

export const VideoGenerateInputSchema = z.object({
  prompt: z.string().min(1).max(8000),
  model: modelId.optional(),
  aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).optional(),
  duration_seconds: z.number().int().min(1).max(60).optional(),
  resolution: z.enum(["360p", "480p", "720p", "1080p", "4k"]).optional(),
  image_input: artifactId.optional().describe("Library image artifact id used as the first frame."),
  end_image_input: artifactId
    .optional()
    .describe("Library image artifact id used as the last frame."),
});
export const VideoGenerateOutputSchema = MediaResultSchema;

// --- speech.generate ------------------------------------------------------------

export const SpeechGenerateInputSchema = z.object({
  text: z.string().min(1).max(8000),
  voice: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Provider voice name or id. Omit for the provider default."),
  model: modelId.optional(),
  format: z.enum(["mp3", "wav", "flac", "opus"]).optional(),
  language: z.string().min(2).max(16).optional().describe("Language code, such as en or pt-BR."),
});
export const SpeechGenerateOutputSchema = MediaResultSchema;

// --- music.generate -------------------------------------------------------------

export const MusicGenerateInputSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model: modelId.optional(),
  duration_seconds: z.number().min(3).max(600).optional().describe("A hint for some providers."),
  instrumental: z.boolean().optional(),
  format: z.enum(["mp3", "wav"]).optional(),
});
export const MusicGenerateOutputSchema = MediaResultSchema;

// --- audio.transcribe -----------------------------------------------------------

export const TranscriptSegmentSchema = z.looseObject({
  start: z.union([z.number(), z.string()]).optional(),
  end: z.union([z.number(), z.string()]).optional(),
  text: z.string(),
  speaker: z.string().optional(),
});

export const AudioTranscribeInputSchema = z.object({
  artifact_id: artifactId.describe("Library audio or video artifact id."),
  language: z.string().min(2).max(40).optional(),
  model: modelId.optional(),
  timestamps: z.boolean().optional().describe("Return segments with timestamps."),
  speakers: z.boolean().optional().describe("Label speakers (providers that support it)."),
});
export const AudioTranscribeOutputSchema = z.looseObject({
  text: z.string(),
  segments: z.array(TranscriptSegmentSchema).optional(),
  language: z.string().nullable().optional(),
  model: z.string().optional(),
  provider: z.string(),
});

// --- chat -------------------------------------------------------------------------

export const ChatMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1).max(200_000),
});

export const ChatInputSchema = z.object({
  messages: z.array(ChatMessageSchema).min(1).max(100),
  model: modelId.optional(),
  max_tokens: z.number().int().min(1).max(65_536).optional(),
  temperature: z.number().min(0).max(2).optional(),
  json: z.boolean().optional().describe("Ask for a JSON reply."),
});
export const ChatOutputSchema = z.looseObject({
  text: z.string(),
  model: z.string(),
  provider: z.string(),
  usage: z
    .looseObject({
      input_tokens: z.number().optional(),
      output_tokens: z.number().optional(),
    })
    .optional(),
  cost_usd: z.number().nullable().optional(),
});

// --- image.edit / image.upscale / image.remove_background --------------------------

export const ImageEditInputSchema = z.object({
  artifact_id: artifactId.describe("Library image artifact id to edit."),
  prompt: z.string().min(1).max(8000).describe("What to change."),
  reference_ids: z
    .array(artifactId)
    .max(6)
    .optional()
    .describe("More library image ids used as references (providers that support it)."),
  mask_id: artifactId
    .optional()
    .describe(
      "Library image id of a mask: white is edited, black is kept (providers that support it).",
    ),
  model: modelId.optional(),
  n: z.number().int().min(1).max(4).optional(),
  seed: z.number().int().optional(),
  aspect_ratio: z
    .string()
    .regex(/^\d{1,2}:\d{1,2}$/, "use a ratio such as 1:1, 16:9, 9:16")
    .optional(),
});
export const ImageEditOutputSchema = MediaResultSchema;

export const ImageUpscaleInputSchema = z.object({
  artifact_id: artifactId.describe("Library image artifact id."),
  scale: z.number().int().min(2).max(4).optional().describe("Upscale factor, 2 to 4. Default 4."),
  model: modelId.optional(),
});
export const ImageUpscaleOutputSchema = MediaResultSchema;

export const ImageRemoveBackgroundInputSchema = z.object({
  artifact_id: artifactId.describe("Library image artifact id."),
  model: modelId.optional(),
});
export const ImageRemoveBackgroundOutputSchema = MediaResultSchema;

// --- video.upscale / video.lipsync -------------------------------------------------

export const VideoUpscaleInputSchema = z.object({
  artifact_id: artifactId.describe("Library video artifact id."),
  scale: z.number().int().min(2).max(4).optional().describe("Upscale factor, 2 to 4. Default 2."),
  model: modelId.optional(),
});
export const VideoUpscaleOutputSchema = MediaResultSchema;

export const VideoLipsyncInputSchema = z.object({
  artifact_id: artifactId.describe("Library video (or face image) artifact id."),
  audio_id: artifactId.describe("Library audio artifact id with the speech to sync to."),
  model: modelId.optional(),
});
export const VideoLipsyncOutputSchema = MediaResultSchema;

// --- audio.separate_stems ----------------------------------------------------------

export const STEM_NAMES = ["vocals", "drums", "bass", "other", "piano", "guitar"] as const;

export const AudioSeparateStemsInputSchema = z.object({
  artifact_id: artifactId.describe("Library audio or video artifact id."),
  two_stems: z
    .enum(STEM_NAMES)
    .optional()
    .describe(
      "Split into this stem and everything else (vocals gives a vocal and an instrumental track).",
    ),
  model: modelId.optional(),
  format: z.enum(["mp3", "wav"]).optional(),
});
/** One artifact per stem; each artifact may carry `stem` (vocals, drums, ...). */
export const AudioSeparateStemsOutputSchema = MediaResultSchema;

// --- voice.clone / sound.effect ----------------------------------------------------

export const VoiceCloneInputSchema = z.object({
  name: z.string().min(1).max(100).describe("Name for the new voice."),
  artifact_ids: z
    .array(artifactId)
    .min(1)
    .max(25)
    .describe(
      "Library audio artifact ids with clean speech of the voice (a minute or more helps).",
    ),
  description: z.string().max(500).optional(),
  model: modelId.optional(),
});
export const VoiceCloneOutputSchema = z.looseObject({
  voice_id: z.string().min(1),
  name: z.string(),
  provider: z.string(),
  model: z.string().optional(),
  cost_usd: z.number().nullable().optional(),
});

export const SoundEffectInputSchema = z.object({
  prompt: z.string().min(1).max(1000).describe("The sound, such as 'a door creaks open slowly'."),
  duration_seconds: z.number().min(0.5).max(30).optional(),
  model: modelId.optional(),
  format: z.enum(["mp3", "wav"]).optional(),
});
export const SoundEffectOutputSchema = MediaResultSchema;

// --- 3d.generate --------------------------------------------------------------------

export const ThreeDGenerateInputSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .optional()
    .describe("Text description. Give this, an image, or both."),
  artifact_id: artifactId.optional().describe("Library image artifact id to build the model from."),
  model: modelId.optional(),
  format: z.enum(["glb", "obj", "fbx", "usdz"]).optional().describe("Default glb."),
});
export const ThreeDGenerateOutputSchema = MediaResultSchema;

// --- document.parse / document.convert ----------------------------------------------

export const DocumentParseInputSchema = z.object({
  artifact_id: artifactId.describe("Library PDF or image artifact id."),
  format: z.enum(["markdown", "text"]).optional().describe("Default markdown."),
  language: z
    .string()
    .regex(/^[a-z]{2,3}([+_-][A-Za-z]{2,8})*$/, "a language code such as en, de or eng+deu")
    .optional()
    .describe("Language hint for OCR."),
  model: modelId.optional(),
});
export const DocumentParseOutputSchema = z.looseObject({
  text: z.string(),
  format: z.enum(["markdown", "text"]),
  pages: z.number().int().nonnegative().optional(),
  artifacts: z.array(CapabilityArtifactSchema).optional(),
  model: z.string().optional(),
  provider: z.string(),
  cost_usd: z.number().nullable().optional(),
});

export const DOCUMENT_FORMATS = [
  "pdf",
  "docx",
  "odt",
  "rtf",
  "html",
  "md",
  "txt",
  "epub",
  "pptx",
  "xlsx",
  "csv",
] as const;

export const DocumentConvertInputSchema = z.object({
  artifact_id: artifactId.describe("Library document artifact id."),
  to: z.enum(DOCUMENT_FORMATS).describe("Target format."),
  model: modelId.optional(),
});
export const DocumentConvertOutputSchema = MediaResultSchema;

// --- text.translate / text.embed / text.rerank ---------------------------------------

const languageCode = z
  .string()
  .regex(/^[A-Za-z]{2,3}([_-][A-Za-z0-9]{2,8})?$/, "a language code such as en, de or pt-BR");

export const TextTranslateInputSchema = z.object({
  text: z.string().min(1).max(100_000),
  target_language: languageCode.describe("Language code to translate into, such as de or pt-BR."),
  source_language: languageCode.optional().describe("Omit to detect."),
  formality: z.enum(["default", "more", "less"]).optional(),
  model: modelId.optional(),
});
export const TextTranslateOutputSchema = z.looseObject({
  text: z.string(),
  detected_source_language: z.string().nullable().optional(),
  model: z.string().optional(),
  provider: z.string(),
  cost_usd: z.number().nullable().optional(),
});

export const TextEmbedInputSchema = z.object({
  texts: z.array(z.string().min(1).max(32_000)).min(1).max(256),
  model: modelId.optional(),
  dimensions: z.number().int().min(16).max(8192).optional(),
  input_type: z
    .enum(["query", "document"])
    .optional()
    .describe("Some models embed queries and documents differently."),
});
export const TextEmbedOutputSchema = z.looseObject({
  embeddings: z.array(z.array(z.number())).min(1),
  model: z.string(),
  dimensions: z.number().int().positive(),
  provider: z.string(),
  cost_usd: z.number().nullable().optional(),
});

export const TextRerankInputSchema = z.object({
  query: z.string().min(1).max(8000),
  documents: z.array(z.string().min(1).max(32_000)).min(1).max(1000),
  top_n: z.number().int().min(1).max(1000).optional(),
  model: modelId.optional(),
});
export const TextRerankOutputSchema = z.looseObject({
  /** Best first; `index` points into the input documents. */
  results: z.array(z.looseObject({ index: z.number().int().nonnegative(), score: z.number() })),
  model: z.string(),
  provider: z.string(),
  cost_usd: z.number().nullable().optional(),
});

// --- web.search / web.fetch ------------------------------------------------------------

const domain = z
  .string()
  .regex(/^(?=.{1,253}$)[A-Za-z0-9.-]+\.[A-Za-z]{2,63}$/, "a domain such as example.com");

export const WebSearchInputSchema = z.object({
  query: z.string().min(1).max(2000),
  max_results: z.number().int().min(1).max(50).optional().describe("Default 10."),
  include_domains: z.array(domain).max(20).optional(),
  exclude_domains: z.array(domain).max(20).optional(),
  recency: z.enum(["day", "week", "month", "year"]).optional(),
  country: z
    .string()
    .regex(/^[A-Za-z]{2}$/, "a two-letter country code")
    .optional(),
  model: modelId.optional(),
});
export const WebSearchResultSchema = z.looseObject({
  title: z.string(),
  url: z.string().min(1),
  snippet: z.string().optional(),
  published_at: z.string().nullable().optional(),
});
export const WebSearchOutputSchema = z.looseObject({
  results: z.array(WebSearchResultSchema),
  model: z.string().optional(),
  provider: z.string(),
  cost_usd: z.number().nullable().optional(),
});

export const WebFetchInputSchema = z.object({
  url: z.url({ protocol: /^https?$/ }).max(8192),
  format: z.enum(["markdown", "text", "html"]).optional().describe("Default markdown."),
  max_chars: z.number().int().min(100).max(1_000_000).optional().describe("Default 100000."),
  model: modelId.optional(),
});
export const WebFetchOutputSchema = z.looseObject({
  url: z.string(),
  title: z.string().nullable().optional(),
  content: z.string(),
  format: z.enum(["markdown", "text", "html"]),
  truncated: z.boolean().optional(),
  model: z.string().optional(),
  provider: z.string(),
  cost_usd: z.number().nullable().optional(),
});

// --- media.transcript --------------------------------------------------------------------

export const MediaTranscriptInputSchema = z.object({
  url: z
    .url({ protocol: /^https?$/ })
    .max(8192)
    .describe("Video or podcast page URL (YouTube, Vimeo, ...)."),
  language: z.string().min(2).max(16).optional().describe("Preferred transcript language."),
  timestamps: z.boolean().optional().describe("Return segments with timestamps."),
  model: modelId.optional(),
});
export const MediaTranscriptOutputSchema = z.looseObject({
  text: z.string(),
  segments: z.array(TranscriptSegmentSchema).optional(),
  language: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  model: z.string().optional(),
  provider: z.string(),
  cost_usd: z.number().nullable().optional(),
});

// --- registry ---------------------------------------------------------------------

export const CAPABILITY_SCHEMAS = {
  "image.generate": { input: ImageGenerateInputSchema, output: ImageGenerateOutputSchema },
  "video.generate": { input: VideoGenerateInputSchema, output: VideoGenerateOutputSchema },
  "speech.generate": { input: SpeechGenerateInputSchema, output: SpeechGenerateOutputSchema },
  "music.generate": { input: MusicGenerateInputSchema, output: MusicGenerateOutputSchema },
  "audio.transcribe": { input: AudioTranscribeInputSchema, output: AudioTranscribeOutputSchema },
  chat: { input: ChatInputSchema, output: ChatOutputSchema },
  "image.edit": { input: ImageEditInputSchema, output: ImageEditOutputSchema },
  "image.upscale": { input: ImageUpscaleInputSchema, output: ImageUpscaleOutputSchema },
  "image.remove_background": {
    input: ImageRemoveBackgroundInputSchema,
    output: ImageRemoveBackgroundOutputSchema,
  },
  "video.upscale": { input: VideoUpscaleInputSchema, output: VideoUpscaleOutputSchema },
  "video.lipsync": { input: VideoLipsyncInputSchema, output: VideoLipsyncOutputSchema },
  "audio.separate_stems": {
    input: AudioSeparateStemsInputSchema,
    output: AudioSeparateStemsOutputSchema,
  },
  "voice.clone": { input: VoiceCloneInputSchema, output: VoiceCloneOutputSchema },
  "sound.effect": { input: SoundEffectInputSchema, output: SoundEffectOutputSchema },
  "3d.generate": { input: ThreeDGenerateInputSchema, output: ThreeDGenerateOutputSchema },
  "document.parse": { input: DocumentParseInputSchema, output: DocumentParseOutputSchema },
  "document.convert": { input: DocumentConvertInputSchema, output: DocumentConvertOutputSchema },
  "text.translate": { input: TextTranslateInputSchema, output: TextTranslateOutputSchema },
  "text.embed": { input: TextEmbedInputSchema, output: TextEmbedOutputSchema },
  "text.rerank": { input: TextRerankInputSchema, output: TextRerankOutputSchema },
  "web.search": { input: WebSearchInputSchema, output: WebSearchOutputSchema },
  "web.fetch": { input: WebFetchInputSchema, output: WebFetchOutputSchema },
  "media.transcript": { input: MediaTranscriptInputSchema, output: MediaTranscriptOutputSchema },
} as const satisfies Record<CapabilityName, { input: z.ZodType; output: z.ZodType }>;

export type CapabilityInput<C extends CapabilityName> = z.input<
  (typeof CAPABILITY_SCHEMAS)[C]["input"]
>;
/** What a provider's `run` receives: the validated, normalised input. */
export type CapabilityParsedInput<C extends CapabilityName> = z.output<
  (typeof CAPABILITY_SCHEMAS)[C]["input"]
>;
export type CapabilityOutput<C extends CapabilityName> = z.output<
  (typeof CAPABILITY_SCHEMAS)[C]["output"]
>;
