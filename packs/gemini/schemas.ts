// packs/gemini/schemas.ts
import { z } from "plughive/pack";

const artifactId = z.string().min(1).max(128);
const modelId = z.string().regex(/^[A-Za-z0-9._-]{1,80}$/, "model ids use letters, digits, . _ -");

export const imageSchema = z.object({
  prompt: z.string().min(1).max(8000),
  model: modelId.optional().describe("Default gemini-nano-banana-2.1. See gemini_list_models."),
  aspect_ratio: z
    .string()
    .regex(/^\d{1,2}:\d{1,2}$/, "use a ratio such as 1:1, 16:9, 9:16")
    .optional(),
  image_size: z.enum(["1K", "2K", "4K"]).optional().describe("Default 1K. 4K costs about 3x."),
  mime_type: z.enum(["image/jpeg", "image/png"]).optional(),
  n: z
    .number()
    .int()
    .min(1)
    .max(4)
    .optional()
    .describe("Images to make, one request each. Default 1."),
  image_inputs: z
    .array(artifactId)
    .max(6)
    .optional()
    .describe("Library artifact ids to edit or use as references."),
  seed: z.number().int().optional().describe("Ignored: the Interactions API has no seed."),
});

export const videoSchema = z.object({
  prompt: z.string().min(1).max(8000),
  model: modelId.optional(),
  aspect_ratio: z.enum(["16:9", "9:16"]).optional(),
  duration_seconds: z.number().int().min(3).max(15).optional().describe("3 to 15, default 10."),
  resolution: z.enum(["360p", "720p", "1080p", "4k"]).optional().describe("Default 720p."),
  image_input: artifactId.optional().describe("Library image artifact id used as the first frame."),
  end_image_input: artifactId
    .optional()
    .describe("Library image artifact id used as the last frame."),
});

export const speechSchema = z.object({
  text: z.string().min(1).max(8000),
  voice: z.string().min(1).max(40).optional().describe("Prebuilt voice name, default Kore."),
  model: modelId.optional(),
  format: z.enum(["wav"]).optional(),
  sample_rate: z.union([z.literal(24000), z.literal(16000), z.literal(8000)]).optional(),
  style: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Delivery style such as cheerful or whispered."),
  speakers: z
    .array(z.object({ speaker: z.string().min(1).max(40), voice: z.string().min(1).max(40) }))
    .min(2)
    .max(2)
    .optional()
    .describe("Two named speakers; use their names as line prefixes in text."),
});

export const musicSchema = z.object({
  prompt: z.string().min(1).max(4000),
  model: modelId.optional(),
  duration_seconds: z
    .number()
    .int()
    .min(5)
    .max(180)
    .optional()
    .describe("A hint only; the model decides length."),
  format: z.enum(["mp3", "wav"]).optional(),
});

export const transcribeSchema = z.object({
  artifact_id: artifactId.describe("Library audio (or video) artifact id, up to 15 MB."),
  language: z.string().min(2).max(40).optional(),
  model: modelId.optional(),
  speakers: z.boolean().optional().describe("Label speakers."),
  timestamps: z.boolean().optional().describe("Return MM:SS timestamps per segment."),
});

export const chatSchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["system", "user", "assistant"]),
        content: z.string().min(1).max(200_000),
      }),
    )
    .min(1)
    .max(100),
  model: modelId.optional().describe("Default gemini-4-hydrogen."),
  max_tokens: z.number().int().min(1).max(65_536).optional(),
  temperature: z.number().min(0).max(2).optional(),
  json: z.boolean().optional().describe("Ask for a JSON reply."),
});

export const listModelsSchema = z.object({
  filter: z.string().max(80).optional().describe("Substring of the model id or name."),
  refresh: z.boolean().optional().describe("Bypass the 10 minute cache."),
});

export const collectSchema = z.object({
  interaction_id: z
    .string()
    .regex(/^[A-Za-z0-9_.:-]{1,200}$/, "pass the interaction id an earlier call returned")
    .describe("The interaction id a video or music call returned or named in its error."),
});
