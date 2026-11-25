// The spend-policy estimate hooks on the Replicate capability providers: a
// static price table for the default models, scaled by n, characters,
// seconds or output size; null for models not in the table. No requests.
import type { PackContext } from "plughive/pack";
import { describe, expect, it } from "vitest";
import { CAPABILITY_DEFAULTS, providers } from "../../../packs/replicate/capabilities.js";
import { PRICES } from "../../../packs/replicate/estimates.js";
import { CAPABILITY_SCHEMAS } from "../../../src/core/capabilities/schemas.js";
import { memLibrary, routerFetch } from "../provider-support.js";
import { fakeCtx } from "../support.js";

type Cap = keyof typeof CAPABILITY_SCHEMAS;
type Est = { usd: number; basis: string } | null;
const TABLE = "static table (replicate.com model pages, 2026-11)";

function setup() {
  const lib = memLibrary();
  // Any request fails the test: estimates come from the table alone.
  const fetch = routerFetch([]);
  const ctx = fakeCtx({ packId: "replicate", secrets: {}, fetch, library: lib.library });
  const withMeta = (id: string, mime: string, meta: Record<string, unknown> | null) => {
    lib.put(id, mime, new Uint8Array(10));
    return lib.library.get(id).then((r) => {
      (r as { meta: unknown }).meta = meta;
    });
  };
  return { ctx, withMeta, fetch };
}

async function estimate(cap: Cap, input: unknown, ctx: PackContext): Promise<Est> {
  const p = providers.find((x) => x.capability === cap) as unknown as {
    estimate?: (input: unknown, ctx: PackContext) => Promise<Est> | Est;
  };
  expect(p.estimate).toBeTypeOf("function");
  return (await p.estimate!(CAPABILITY_SCHEMAS[cap].input.parse(input), ctx)) ?? null;
}

describe("replicate estimates", () => {
  it("every provider has an estimate and every default model a price", () => {
    for (const p of providers)
      expect((p as { estimate?: unknown }).estimate).toBeTypeOf("function");
    // Whisper and demucs bill GPU time that grows with the recording: no price.
    const unpriced = new Set(["openai/whisper", "ryan5453/demucs"]);
    for (const m of Object.values(CAPABILITY_DEFAULTS)) {
      if (unpriced.has(m)) expect(PRICES[m]).toBeUndefined();
      else expect(PRICES[m]).toBeDefined();
    }
  });

  it("image.generate: per image, scaled by n; the edit model with input images", async () => {
    const { ctx, fetch } = setup();
    expect(await estimate("image.generate", { prompt: "a cat" }, ctx)).toEqual({
      usd: 0.003,
      basis: TABLE,
    });
    expect((await estimate("image.generate", { prompt: "a cat", n: 4 }, ctx))?.usd).toBe(0.012);
    const edit = await estimate(
      "image.generate",
      { prompt: "a cat", image_inputs: ["art_1"], n: 2 },
      ctx,
    );
    expect(edit?.usd).toBe(0.078);
    // A pinned version still matches its model.
    const pinned = await estimate(
      "image.generate",
      { prompt: "x", model: "black-forest-labs/flux-schnell:abc123" },
      ctx,
    );
    expect(pinned?.usd).toBe(0.003);
    expect(
      await estimate("image.generate", { prompt: "x", model: "acme/unknown" }, ctx),
    ).toBeNull();
    expect(fetch.calls).toHaveLength(0);
  });

  it("image.edit and image.remove_background: per image", async () => {
    const { ctx } = setup();
    expect(
      (await estimate("image.edit", { artifact_id: "art_1", prompt: "x", n: 3 }, ctx))?.usd,
    ).toBe(0.117);
    expect(await estimate("image.remove_background", { artifact_id: "art_1" }, ctx)).toEqual({
      usd: 0.01,
      basis: TABLE,
    });
    expect(
      await estimate("image.edit", { artifact_id: "art_1", prompt: "x", model: "acme/x" }, ctx),
    ).toBeNull();
  });

  it("video.generate: flat per video", async () => {
    const { ctx } = setup();
    expect(await estimate("video.generate", { prompt: "waves" }, ctx)).toEqual({
      usd: 0.5,
      basis: TABLE,
    });
    expect(await estimate("video.generate", { prompt: "waves", model: "acme/v" }, ctx)).toBeNull();
  });

  it("speech.generate: per character", async () => {
    const { ctx } = setup();
    expect(await estimate("speech.generate", { text: "a".repeat(1000) }, ctx)).toEqual({
      usd: 0.1,
      basis: TABLE,
    });
    expect((await estimate("speech.generate", { text: "a".repeat(2500) }, ctx))?.usd).toBe(0.25);
    expect(await estimate("speech.generate", { text: "a", model: "acme/tts" }, ctx)).toBeNull();
  });

  it("GPU-time models: the typical run, scaled up for longer output", async () => {
    const { ctx } = setup();
    expect(await estimate("music.generate", { prompt: "jazz" }, ctx)).toEqual({
      usd: 0.05,
      basis: `${TABLE}, typical run`,
    });
    expect(
      (await estimate("music.generate", { prompt: "jazz", duration_seconds: 32 }, ctx))?.usd,
    ).toBe(0.2);
    expect(
      (await estimate("sound.effect", { prompt: "door", duration_seconds: 16 }, ctx))?.usd,
    ).toBe(0.0172);
    // Billed by GPU time that grows with the uploaded recording: unknown.
    expect(await estimate("audio.transcribe", { artifact_id: "art_1" }, ctx)).toBeNull();
    expect(await estimate("audio.separate_stems", { artifact_id: "art_1" }, ctx)).toBeNull();
    expect((await estimate("3d.generate", { artifact_id: "art_1" }, ctx))?.usd).toBe(0.04);
    expect(await estimate("music.generate", { prompt: "jazz", model: "acme/m" }, ctx)).toBeNull();
  });

  it("image.upscale: by output megapixels; the top tier when the source size is unknown", async () => {
    const { ctx, withMeta } = setup();
    const unknown = await estimate("image.upscale", { artifact_id: "art_none" }, ctx);
    expect(unknown).toEqual({ usd: 0.82, basis: `${TABLE}, size unknown: top tier` });
    await withMeta("art_small", "image/png", { width: 1000, height: 1000 });
    expect(await estimate("image.upscale", { artifact_id: "art_small", scale: 2 }, ctx)).toEqual({
      usd: 0.05,
      basis: TABLE,
    });
    expect((await estimate("image.upscale", { artifact_id: "art_small" }, ctx))?.usd).toBe(0.05); // 16 MP
    await withMeta("art_mid", "image/png", { width: 2000, height: 2000 });
    expect((await estimate("image.upscale", { artifact_id: "art_mid" }, ctx))?.usd).toBe(0.2); // 64 MP -> 96
    await withMeta("art_big", "image/png", { width: 4000, height: 3000 });
    expect((await estimate("image.upscale", { artifact_id: "art_big", scale: 4 }, ctx))?.usd).toBe(
      0.53,
    ); // 192 MP -> 336
    expect(
      await estimate("image.upscale", { artifact_id: "art_big", model: "acme/up" }, ctx),
    ).toBeNull();
  });
  it("video.lipsync: per second of the longer input; null unless both lengths are known", async () => {
    const { ctx, withMeta } = setup();
    await withMeta("art_v", "video/mp4", { duration_seconds: 20 });
    await withMeta("art_a", "audio/mpeg", { duration: 12.5 });
    expect(
      await estimate("video.lipsync", { artifact_id: "art_v", audio_id: "art_a" }, ctx),
    ).toEqual({ usd: 1, basis: TABLE });
    await withMeta("art_l", "audio/mpeg", { duration: 30 });
    expect(
      (await estimate("video.lipsync", { artifact_id: "art_v", audio_id: "art_l" }, ctx))?.usd,
    ).toBe(1.5);
    await withMeta("art_n", "audio/mpeg", null);
    expect(
      await estimate("video.lipsync", { artifact_id: "art_v", audio_id: "art_n" }, ctx),
    ).toBeNull();
  });
  it("video.upscale: per 5 s by output height; null without a known length", async () => {
    const { ctx, withMeta } = setup();
    await withMeta("art_v", "video/mp4", { duration_seconds: 10, height: 540 });
    // 540 x 2 = 1080p: $0.187 per 5 s.
    expect(await estimate("video.upscale", { artifact_id: "art_v" }, ctx)).toEqual({
      usd: 0.374,
      basis: `${TABLE}, 60 fps`,
    });
    expect((await estimate("video.upscale", { artifact_id: "art_v", scale: 4 }, ctx))?.usd).toBe(
      1.494,
    );
    await withMeta("art_s", "video/mp4", { duration_seconds: 10, height: 360 });
    expect((await estimate("video.upscale", { artifact_id: "art_s" }, ctx))?.usd).toBe(0.106); // 720p
    // Unknown height: the 4K tier, an upper bound.
    await withMeta("art_h", "video/mp4", { duration_seconds: 10 });
    expect((await estimate("video.upscale", { artifact_id: "art_h" }, ctx))?.usd).toBe(1.494);
    await withMeta("art_u", "video/mp4", null);
    expect(await estimate("video.upscale", { artifact_id: "art_u" }, ctx)).toBeNull();
  });
});
