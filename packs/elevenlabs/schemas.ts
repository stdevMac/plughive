// packs/elevenlabs/schemas.ts
import { z } from "plughive/pack";

const artifactId = z.string().min(1).max(128);
const providerId = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, "ids use letters, digits, _ and -");
const lang = z
  .string()
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?$/, "use a language code such as en, es, pt-BR");

export const listModelsSchema = z.object({
  refresh: z.boolean().optional().describe("Bypass the 10 minute cache."),
});

export const listVoicesSchema = z.object({
  search: z.string().max(80).optional().describe("Match on name, description or labels."),
  category: z.enum(["premade", "cloned", "generated", "professional"]).optional(),
  gender: z.string().max(20).optional().describe("Label filter, such as male or female."),
  accent: z.string().max(40).optional().describe("Label filter, such as american or british."),
  use_case: z
    .string()
    .max(40)
    .optional()
    .describe("Label filter, such as narration or conversational."),
  limit: z.number().int().min(1).max(100).optional().describe("Default 20."),
  page_token: z.string().max(500).optional().describe("next_page_token from a previous call."),
});

export const ttsSchema = z.object({
  text: z.string().min(1).max(5000),
  voice: providerId
    .optional()
    .describe("Voice id from elevenlabs_list_voices. Default is a premade narrator."),
  model: providerId
    .optional()
    .describe(
      "Default eleven_multilingual_v2. eleven_v3 is most expressive; eleven_flash_v2_5 is fastest.",
    ),
  format: z.enum(["mp3", "wav"]).optional().describe("Default mp3."),
  language_code: lang.optional().describe("Force the language (flash and v3 models)."),
  stability: z.number().min(0).max(1).optional(),
  similarity_boost: z.number().min(0).max(1).optional(),
  style: z.number().min(0).max(1).optional(),
  speed: z.number().min(0.7).max(1.2).optional(),
  seed: z.number().int().min(0).max(4_294_967_295).optional(),
});

export const sfxSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(450)
    .describe("Describe the sound, e.g. 'heavy wooden door creaking open'."),
  duration_seconds: z
    .number()
    .min(0.5)
    .max(30)
    .optional()
    .describe("0.5 to 30. Omit to let the model decide."),
  prompt_influence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("Higher follows the prompt more literally. Default 0.3."),
  loop: z.boolean().optional(),
  format: z.enum(["mp3", "wav"]).optional(),
});

export const musicSchema = z.object({
  prompt: z.string().min(1).max(4100),
  duration_seconds: z
    .number()
    .min(3)
    .max(600)
    .optional()
    .describe("3 to 600. Omit to let the model decide."),
  instrumental: z.boolean().optional().describe("Force no vocals. Default false."),
  model: providerId.optional().describe("Default music_v2_5."),
});

export const dubSchema = z.object({
  artifact_id: artifactId.describe("Library audio or video artifact, up to 50 MB."),
  target_language: lang,
  source_language: lang.optional().describe("Omit to auto-detect."),
  max_wait_seconds: z
    .number()
    .int()
    .min(30)
    .max(1800)
    .optional()
    .describe("Give up polling after this long. Default 900."),
});

export const getDubSchema = z.object({
  dubbing_id: z
    .string()
    .regex(
      /^[A-Za-z0-9_-]{1,120}$/,
      "Use the dubbing project id from an earlier elevenlabs_dub error or result.",
    )
    .describe("Dubbing project id returned by elevenlabs_dub (also named in its timeout error)."),
  target_language: lang.optional().describe("Language to collect when the project has several."),
});

export const transcribeSchema = z.object({
  artifact_id: artifactId.describe("Library audio or video artifact, up to 50 MB."),
  language: lang.optional().describe("Omit to auto-detect."),
  model: providerId.optional().describe("Default scribe_v3."),
  diarize: z.boolean().optional().describe("Label speakers."),
  timestamps: z.boolean().optional().describe("Return segments with start and end seconds."),
});

export const isolateSchema = z.object({
  artifact_id: artifactId.describe("Library audio or video artifact, up to 50 MB."),
});

export const usageSchema = z.object({});
