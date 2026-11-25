// packs/elevenlabs/estimates.ts
//
// What a capability call will cost, before it runs (the spend policy's
// `estimate` hook). A static table from https://elevenlabs.io/pricing/api,
// read 2026-11 (dollar list prices are the same on every self-serve plan):
//
//   Text to speech   v4, v3, Multilingual v2      $0.08 per 1K characters
//                    Flash / Turbo (v2.5, v2)      $0.04 per 1K characters
//   Speech to text   Scribe v3 / v2 batch $0.20 per hour, realtime $0.22: the
//                    higher $0.22 is used
//   Music            Eleven Music                  $0.15 per minute (null
//                    without duration_seconds: the model picks the length)
//   Sound effects                                  $0.12 per minute (30 s, the
//                    API maximum, when the call leaves the length open)
//   Voice cloning    instant cloning has no per-clone price (it comes with
//                    the plan), so it is $0
//
// A model not in the table has no estimate (null), nor has a call whose length
// is unknown before it runs (never an assumed default).
import type { PackContext } from "plughive/pack";
import { DEFAULTS } from "./ops.js";

export interface Estimate {
  usd: number;
  basis: string;
}

const TABLE = "static table (elevenlabs.io/pricing/api, 2026-11)";

/** USD per character, by TTS model id. */
export const TTS_PER_CHAR: Readonly<Record<string, number>> = {
  eleven_v4: 0.00008,
  eleven_v3: 0.00008,
  eleven_multilingual_v2: 0.00008,
  eleven_flash_v2_5: 0.00004,
  eleven_turbo_v2_5: 0.00004,
  eleven_flash_v2: 0.00004,
  eleven_turbo_v2: 0.00004,
};
/** USD per second of audio, by transcription model id. */
export const STT_PER_SECOND: Readonly<Record<string, number>> = {
  scribe_v3: 0.22 / 3600,
  scribe_v2: 0.22 / 3600,
  scribe_v1: 0.22 / 3600,
};
/** USD per second of music, by music model id. */
export const MUSIC_PER_SECOND: Readonly<Record<string, number>> = {
  music_v2_5: 0.15 / 60,
  music_v2: 0.15 / 60,
  music_v1: 0.15 / 60,
};
export const SFX_PER_SECOND = 0.12 / 60;
/** The longest sound effect the API makes: the upper bound when the call leaves the length to the model. */
export const SFX_MAX_SECONDS = 30;

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

export function estimateSpeech(input: {
  text: string;
  model?: string | undefined;
}): Estimate | null {
  const rate = TTS_PER_CHAR[input.model ?? DEFAULTS.tts_model];
  return rate === undefined ? null : { usd: round6(rate * input.text.length), basis: TABLE };
}

export function estimateMusic(input: {
  model?: string | undefined;
  duration_seconds?: number | undefined;
}): Estimate | null {
  const rate = MUSIC_PER_SECOND[input.model ?? DEFAULTS.music_model];
  if (rate === undefined) return null;
  // Without a length the model picks one, so the cost is unknown.
  if (input.duration_seconds === undefined) return null;
  return { usd: round6(rate * input.duration_seconds), basis: TABLE };
}

export function estimateSoundEffect(input: { duration_seconds?: number | undefined }): Estimate {
  const seconds = input.duration_seconds ?? SFX_MAX_SECONDS;
  return {
    usd: round6(SFX_PER_SECOND * seconds),
    basis: input.duration_seconds ? TABLE : `${TABLE}, ${SFX_MAX_SECONDS} s maximum`,
  };
}

/**
 * Transcription is priced by audio length, from the library's recorded
 * duration. Null when the file or its length is unknown.
 */
export async function estimateTranscribe(
  input: { artifact_id: string; model?: string | undefined },
  ctx: PackContext,
): Promise<Estimate | null> {
  const rate = STT_PER_SECOND[input.model ?? DEFAULTS.stt_model];
  if (rate === undefined) return null;
  let rec: Awaited<ReturnType<PackContext["library"]["get"]>>;
  try {
    rec = await ctx.library.get(input.artifact_id);
  } catch {
    return null;
  }
  if (!rec) return null;
  const meta = rec.meta ?? {};
  const known = [meta.duration_seconds, meta.duration].find(
    (v): v is number => typeof v === "number" && v > 0,
  );
  return known === undefined ? null : { usd: round6(rate * known), basis: TABLE };
}

export function estimateClone(): Estimate {
  return { usd: 0, basis: `${TABLE}, no per-clone price` };
}
