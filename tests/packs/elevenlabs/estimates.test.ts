// The spend-policy estimate hooks on the ElevenLabs capability providers: a
// static table from elevenlabs.io/pricing/api, scaled by characters or
// seconds; null for models not in the table. No requests.
import type { PackContext } from "plughive/pack";
import { describe, expect, it } from "vitest";
import { providers } from "../../../packs/elevenlabs/capabilities.js";
import { CAPABILITY_SCHEMAS } from "../../../src/core/capabilities/schemas.js";
import { memLibrary, routerFetch } from "../provider-support.js";
import { fakeCtx } from "../support.js";

type Cap = keyof typeof CAPABILITY_SCHEMAS;
type Est = { usd: number; basis: string } | null;
const TABLE = "static table (elevenlabs.io/pricing/api, 2026-11)";

function setup() {
  const lib = memLibrary();
  const fetch = routerFetch([]);
  const ctx = fakeCtx({ packId: "elevenlabs", secrets: {}, fetch, library: lib.library });
  return { ctx, lib, fetch };
}

async function estimate(cap: Cap, input: unknown, ctx: PackContext): Promise<Est> {
  const p = providers.find((x) => x.capability === cap) as unknown as {
    estimate?: (input: unknown, ctx: PackContext) => Promise<Est> | Est;
  };
  expect(p.estimate).toBeTypeOf("function");
  return (await p.estimate!(CAPABILITY_SCHEMAS[cap].input.parse(input), ctx)) ?? null;
}

describe("elevenlabs estimates", () => {
  it("every provider has an estimate", () => {
    for (const p of providers)
      expect((p as { estimate?: unknown }).estimate).toBeTypeOf("function");
  });

  it("speech.generate: per 1K characters by model", async () => {
    const { ctx, fetch } = setup();
    expect(await estimate("speech.generate", { text: "a".repeat(1000) }, ctx)).toEqual({
      usd: 0.08,
      basis: TABLE,
    });
    expect((await estimate("speech.generate", { text: "a".repeat(2500) }, ctx))?.usd).toBe(0.2);
    expect(
      (
        await estimate(
          "speech.generate",
          { text: "a".repeat(1000), model: "eleven_flash_v2_5" },
          ctx,
        )
      )?.usd,
    ).toBe(0.04);
    expect(
      await estimate("speech.generate", { text: "a", model: "eleven_unknown" }, ctx),
    ).toBeNull();
    expect(fetch.calls).toHaveLength(0);
  });

  it("music.generate: per second; null when the model picks the length", async () => {
    const { ctx } = setup();
    expect(await estimate("music.generate", { prompt: "jazz", duration_seconds: 60 }, ctx)).toEqual(
      {
        usd: 0.15,
        basis: TABLE,
      },
    );
    expect(
      (await estimate("music.generate", { prompt: "jazz", duration_seconds: 120 }, ctx))?.usd,
    ).toBe(0.3);
    expect(await estimate("music.generate", { prompt: "jazz" }, ctx)).toBeNull();
    expect(
      await estimate(
        "music.generate",
        { prompt: "jazz", duration_seconds: 60, model: "music_unknown" },
        ctx,
      ),
    ).toBeNull();
  });
  it("sound.effect: per second, the 30 s maximum when the length is left out", async () => {
    const { ctx } = setup();
    expect(await estimate("sound.effect", { prompt: "door", duration_seconds: 10 }, ctx)).toEqual({
      usd: 0.02,
      basis: TABLE,
    });
    expect(
      (await estimate("sound.effect", { prompt: "door", duration_seconds: 5 }, ctx))?.usd,
    ).toBe(0.01);
    expect(await estimate("sound.effect", { prompt: "door" }, ctx)).toEqual({
      usd: 0.06,
      basis: `${TABLE}, 30 s maximum`,
    });
    expect(await estimate("sound.effect", { prompt: "door", model: "acme_sfx" }, ctx)).toBeNull();
  });
  it("audio.transcribe: per hour of the recorded length; null when it is unknown", async () => {
    const { ctx, lib } = setup();
    lib.put("art_a", "audio/mpeg", new Uint8Array(400_000));
    expect(await estimate("audio.transcribe", { artifact_id: "art_a" }, ctx)).toBeNull();
    ((await lib.library.get("art_a")) as { meta: unknown }).meta = { duration_seconds: 1800 };
    expect(await estimate("audio.transcribe", { artifact_id: "art_a" }, ctx)).toEqual({
      usd: 0.11,
      basis: TABLE,
    });
    ((await lib.library.get("art_a")) as { meta: unknown }).meta = { duration: 3600 };
    expect((await estimate("audio.transcribe", { artifact_id: "art_a" }, ctx))?.usd).toBe(0.22);
    expect(await estimate("audio.transcribe", { artifact_id: "art_missing" }, ctx)).toBeNull();
    expect(
      await estimate("audio.transcribe", { artifact_id: "art_a", model: "scribe_unknown" }, ctx),
    ).toBeNull();
  });
  it("voice.clone: no per-clone price", async () => {
    const { ctx } = setup();
    const r = await estimate("voice.clone", { name: "me", artifact_ids: ["art_1"] }, ctx);
    expect(r).toEqual({ usd: 0, basis: `${TABLE}, no per-clone price` });
    expect(r!.basis.length).toBeLessThanOrEqual(80);
  });
});
