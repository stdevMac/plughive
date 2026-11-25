// packs/replicate/estimates.ts
//
// What a capability call will cost, before it runs (the spend policy's
// `estimate` hook). Replicate has no price API, so this is a static table for
// the pack's default models. Prices were read from each model page on
// replicate.com (the page's billing table, or its "costs approximately $X to
// run" line for models billed by GPU time) in 2026-11:
//
//   https://replicate.com/black-forest-labs/flux-schnell     $3 per 1,000 output images
//   https://replicate.com/google/nano-banana                 $0.039 per output image
//   https://replicate.com/minimax/video-01                   $0.50 per output video
//   https://replicate.com/minimax/speech-02-hd               $0.10 per 1,000 input tokens (characters)
//   https://replicate.com/meta/musicgen                      ~$0.050 per run (A100 80GB, 8 s default)
//   https://replicate.com/topazlabs/image-upscale            $0.05 per 24 output MP, tiers to 512 MP
//   https://replicate.com/recraft-ai/recraft-remove-background  $0.01 per output image
//   https://replicate.com/sync/lipsync-2                     $0.05 per second of output video
//   https://replicate.com/topazlabs/video-upscale            per 5 s: 720p60 $0.053, 1080p60 $0.187, 4K60 $0.747
//   https://replicate.com/firtoz/trellis                     ~$0.040 per run (A100 80GB)
//   https://replicate.com/zsxkib/mmaudio                     ~$0.0086 per run (L40S, 8 s default)
//
// openai/whisper and ryan5453/demucs bill GPU time that grows with the
// uploaded recording, which is not known before the call, so they have no
// entry. Any other model has no entry either, so its estimate is null ("cost unknown"), as
// is a price that needs a length the library does not record. GPU-time models
// left without a duration run their documented 8 s default; an unknown image or
// video size is priced at the dearest tier.
import type { PackContext } from "plughive/pack";
import { checkArtifactId } from "./common.js";

export interface Estimate {
  usd: number;
  basis: string;
}

const TABLE = "static table (replicate.com model pages, 2026-11)";

type Price =
  /** Per output image (scaled by n). */
  | { per: "image"; usd: number }
  /** One flat price per output video. */
  | { per: "video"; usd: number }
  /** Per input character. */
  | { per: "char"; usd: number }
  /** Billed by GPU time: the page's typical run, scaled up when asked for longer output than `seconds`. */
  | { per: "run"; usd: number; seconds?: number }
  /** Per second of output video, the length taken from the input artifact. */
  | { per: "output_second"; usd: number }
  /** Topaz image upscale: tiers by output megapixels. */
  | { per: "upscale_image" }
  /** Topaz video upscale: per 5 s by output resolution (60 fps figures). */
  | { per: "upscale_video" };

export const PRICES: Readonly<Record<string, Price>> = {
  "black-forest-labs/flux-schnell": { per: "image", usd: 0.003 },
  "google/nano-banana": { per: "image", usd: 0.039 },
  "minimax/video-01": { per: "video", usd: 0.5 },
  "minimax/speech-02-hd": { per: "char", usd: 0.0001 },
  "meta/musicgen": { per: "run", usd: 0.05, seconds: 8 },
  "topazlabs/image-upscale": { per: "upscale_image" },
  "recraft-ai/recraft-remove-background": { per: "image", usd: 0.01 },
  "sync/lipsync-2": { per: "output_second", usd: 0.05 },
  "topazlabs/video-upscale": { per: "upscale_video" },
  "firtoz/trellis": { per: "run", usd: 0.04 },
  "zsxkib/mmaudio": { per: "run", usd: 0.0086, seconds: 8 },
};

/** Output megapixels -> price, from the topazlabs/image-upscale billing table. */
const IMAGE_UPSCALE_TIERS: readonly [number, number][] = [
  [24, 0.05],
  [48, 0.1],
  [60, 0.15],
  [96, 0.2],
  [132, 0.24],
  [168, 0.29],
  [336, 0.53],
  [512, 0.82],
];
/** Output height -> price per 5 s at 60 fps (the higher of the 30/60 fps rows). */
const VIDEO_UPSCALE_PER_5S: readonly [number, number][] = [
  [720, 0.053],
  [1080, 0.187],
  [2160, 0.747],
];

const round6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** The table key for a model ref ("owner/name" or "owner/name:<version>"). */
function priceOf(model: string): Price | undefined {
  return PRICES[model.split(":")[0] ?? ""];
}

const num = (v: unknown): number | null => (typeof v === "number" && v > 0 ? v : null);

async function metaOf(
  ctx: PackContext,
  id: string | undefined,
): Promise<Record<string, unknown> | null> {
  if (!id) return null;
  try {
    return (await ctx.library.get(checkArtifactId(id)))?.meta ?? null;
  } catch {
    return null;
  }
}

/** Seconds of a library audio or video, when its metadata records them. */
function durationOf(meta: Record<string, unknown> | null): number | null {
  if (!meta) return null;
  return num(meta.duration_seconds) ?? num(meta.duration) ?? num(meta.seconds);
}

function heightOf(meta: Record<string, unknown> | null): number | null {
  return num(meta?.height) ?? num((meta?.video as { height?: unknown } | undefined)?.height);
}

function megapixelsOf(meta: Record<string, unknown> | null): number | null {
  const w = num(meta?.width);
  const h = num(meta?.height);
  return w && h ? (w * h) / 1e6 : null;
}

export interface EstimateInput {
  model?: string | undefined;
  n?: number | undefined;
  text?: string | undefined;
  duration_seconds?: number | undefined;
  scale?: number | undefined;
  artifact_id?: string | undefined;
  audio_id?: string | undefined;
}

/**
 * The estimate for one call to `model` (already defaulted by the caller).
 * Null when the model is not in the table, or its price needs a length the
 * library does not record.
 */
export async function estimateFor(
  model: string,
  input: EstimateInput,
  ctx: PackContext,
  defaultScale = 2,
): Promise<Estimate | null> {
  const price = priceOf(model);
  if (!price) return null;
  switch (price.per) {
    case "image":
      return { usd: round6(price.usd * (input.n ?? 1)), basis: TABLE };
    case "video":
      return { usd: price.usd, basis: TABLE };
    case "char":
      return { usd: round6(price.usd * (input.text?.length ?? 0)), basis: TABLE };
    case "run": {
      const factor =
        price.seconds && input.duration_seconds && input.duration_seconds > price.seconds
          ? input.duration_seconds / price.seconds
          : 1;
      return { usd: round6(price.usd * factor), basis: `${TABLE}, typical run` };
    }
    case "output_second": {
      // The output runs as long as the video or the audio, depending on the
      // sync mode: the longer of the two is the upper bound, so both must be known.
      const video = durationOf(await metaOf(ctx, input.artifact_id));
      const audio = durationOf(await metaOf(ctx, input.audio_id));
      if (video === null || audio === null) return null;
      return { usd: round6(price.usd * Math.max(video, audio)), basis: TABLE };
    }
    case "upscale_image": {
      const scale = input.scale ?? defaultScale;
      const known = megapixelsOf(await metaOf(ctx, input.artifact_id));
      // An unknown source size is priced at the dearest tier (an upper bound).
      const top = IMAGE_UPSCALE_TIERS.at(-1)!;
      if (known === null) return { usd: top[1], basis: `${TABLE}, size unknown: top tier` };
      const outMp = known * scale * scale;
      const tier = IMAGE_UPSCALE_TIERS.find(([mp]) => outMp <= mp) ?? top;
      return { usd: tier[1], basis: TABLE };
    }
    case "upscale_video": {
      const meta = await metaOf(ctx, input.artifact_id);
      const seconds = durationOf(meta);
      if (seconds === null) return null;
      // An unknown height is priced at the dearest (4K) tier, an upper bound.
      const height = heightOf(meta);
      const top = VIDEO_UPSCALE_PER_5S.at(-1)!;
      const target =
        height === null ? Number.POSITIVE_INFINITY : height * (input.scale ?? defaultScale);
      const tier = VIDEO_UPSCALE_PER_5S.find(([h]) => target <= h) ?? top;
      return { usd: round6((tier[1] * Math.ceil(seconds)) / 5), basis: `${TABLE}, 60 fps` };
    }
  }
}
