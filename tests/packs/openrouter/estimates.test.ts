// The spend-policy estimate hooks on the OpenRouter capability providers:
// prices from the catalog (video pricing_skus) or the /models row (cached),
// scaled by tokens, images, seconds or characters; null when unknown.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackContext } from "plughive/pack";
import { describe, expect, it } from "vitest";
import { providers } from "../../../packs/openrouter/capabilities.js";
import pack from "../../../packs/openrouter/index.js";
import { CAPABILITY_SCHEMAS } from "../../../src/core/capabilities/schemas.js";
import { memLibrary, packTools, routerFetch, tempDir } from "../provider-support.js";
import { fakeCtx, jsonResponse } from "../support.js";

type Cap = keyof typeof CAPABILITY_SCHEMAS;
type Est = { usd: number; basis: string } | null;

const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

/** /models rows by id (the search answers with the row whose id was asked). */
const ROWS: Record<string, Record<string, unknown>> = {
  "minimax/minimax-m2.7": {
    pricing: { prompt: "0.0000006", completion: "0.0000018" },
    architecture: { output_modalities: ["text"] },
  },
  "acme/priced-request": {
    pricing: { prompt: "0.000001", completion: "0.000002", request: "0.005" },
    architecture: { output_modalities: ["text"] },
  },
  "acme/varies": {
    pricing: { prompt: "-1", completion: "-1" },
    architecture: { output_modalities: ["text"] },
  },
  "openai/text-embedding-3-small": {
    pricing: { prompt: "0.00000002", completion: "0" },
    architecture: { output_modalities: ["embeddings"] },
  },
  "google/gemini-nano-banana-2.1": fixture("models_search.json").data[0],
  "elevenlabs/eleven-v3": {
    pricing: { prompt: "0.00008", completion: "0" },
    architecture: { output_modalities: ["speech"] },
  },
  "elevenlabs/scribe-v2": {
    pricing: { prompt: "0.0000611111", completion: "0" },
    architecture: { output_modalities: ["transcription"] },
  },
};

function routes() {
  return routerFetch([
    {
      match: /^GET https:\/\/openrouter\.ai\/api\/v1\/videos\/models$/,
      reply: () => jsonResponse(fixture("videos_models.json")),
    },
    {
      match: /^GET https:\/\/openrouter\.ai\/api\/v1\/images\/models$/,
      reply: () => jsonResponse(fixture("images_models.json")),
    },
    {
      match: /^GET https:\/\/openrouter\.ai\/api\/v1\/audio\/speech\/models$/,
      reply: () => jsonResponse(fixture("speech_models.json")),
    },
    {
      match: /^GET https:\/\/openrouter\.ai\/api\/v1\/models\?/,
      reply: ({ url }) => {
        const q = new URL(url).searchParams.get("q") ?? "";
        const row = ROWS[q];
        return jsonResponse({ data: row ? [{ ...row, id: q, name: q }] : [] });
      },
    },
  ]);
}

async function setup() {
  const fetch = routes();
  const lib = memLibrary();
  const base = fakeCtx({
    packId: "openrouter",
    dataDir: tempDir("plughive-openrouter-est-"),
    secrets: {},
    settings: { models: "" },
    fetch,
    library: lib.library,
  });
  const { ctx } = await packTools(pack, base);
  return { ctx: { ...ctx, fetch } as PackContext, lib, fetch };
}

async function estimate(cap: Cap, input: unknown, ctx: PackContext, parse = true): Promise<Est> {
  const p = providers.find((x) => x.capability === cap) as unknown as {
    estimate?: (input: unknown, ctx: PackContext) => Promise<Est> | Est;
  };
  expect(p.estimate).toBeTypeOf("function");
  const args = parse ? CAPABILITY_SCHEMAS[cap].input.parse(input) : input;
  return (await p.estimate!(args, ctx)) ?? null;
}

describe("openrouter estimates", () => {
  it("every provider has an estimate", () => {
    for (const p of providers)
      expect((p as { estimate?: unknown }).estimate).toBeTypeOf("function");
  });

  it("chat: prompt UTF-8 bytes (an upper bound on tokens) plus max_tokens, at the /models row prices", async () => {
    const { ctx } = await setup();
    const messages = [{ role: "user", content: "x".repeat(4000) }];
    const r = await estimate("chat", { messages, max_tokens: 1000 }, ctx);
    // at most 4000 prompt tokens x 0.0000006 + 1000 completion x 0.0000018
    expect(r?.usd).toBeCloseTo(0.0042, 6);
    expect(r?.basis).toBe("OpenRouter price (live)");
    expect(r!.basis.length).toBeLessThanOrEqual(80);
    // Scales with the prompt and the output; the next lookup is served from the cache.
    const twice = await estimate(
      "chat",
      { messages: [{ role: "user", content: "x".repeat(8000) }], max_tokens: 2000 },
      ctx,
    );
    expect(twice?.usd).toBeCloseTo(0.0084, 6);
    expect(twice?.basis).toBe("OpenRouter price (cache)");
    // Without max_tokens the output length is unknown: no estimate.
    expect(await estimate("chat", { messages }, ctx)).toBeNull();
    // Non-ASCII text counts every byte.
    const accented = await estimate(
      "chat",
      { messages: [{ role: "user", content: "é".repeat(500) }], max_tokens: 1 },
      ctx,
    );
    expect(accented?.usd).toBeCloseTo(1000 * 0.0000006 + 0.0000018, 5);
    // An image or file part has no token count before the call: no estimate
    // (the chat schema takes text only today; this guards a wider schema).
    const withImage = [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this?" },
          { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
        ],
      },
    ];
    expect(await estimate("chat", { messages: withImage, max_tokens: 10 }, ctx, false)).toBeNull();
  });
  it("chat: adds a per-request price; null for unknown or varying prices", async () => {
    const { ctx } = await setup();
    const messages = [{ role: "user", content: "abcd" }];
    const r = await estimate(
      "chat",
      { messages, model: "acme/priced-request", max_tokens: 10 },
      ctx,
    );
    expect(r?.usd).toBeCloseTo(4 * 0.000001 + 10 * 0.000002 + 0.005, 6);
    expect(
      await estimate("chat", { messages, model: "acme/unknown", max_tokens: 10 }, ctx),
    ).toBeNull();
    expect(
      await estimate("chat", { messages, model: "acme/varies", max_tokens: 10 }, ctx),
    ).toBeNull();
  });

  it("text.translate: no estimate (the output length is unknown before the call)", async () => {
    const { ctx, fetch } = await setup();
    const before = fetch.calls.length;
    expect(
      await estimate("text.translate", { text: "hello", target_language: "fr" }, ctx),
    ).toBeNull();
    expect(fetch.calls.length).toBe(before);
  });
  it("text.embed: input tokens at the prompt price", async () => {
    const { ctx } = await setup();
    const r = await estimate("text.embed", { texts: ["a".repeat(400), "b".repeat(400)] }, ctx);
    expect(r?.usd).toBeCloseTo(800 * 0.00000002, 9);
    expect(r?.basis).toBe("OpenRouter price (live)");
    expect(await estimate("text.embed", { texts: ["a"], model: "acme/nope" }, ctx)).toBeNull();
  });

  it("image.generate and image.edit: per image, scaled by n", async () => {
    const { ctx } = await setup();
    const one = await estimate("image.generate", { prompt: "a cat" }, ctx);
    // ~1290 output tokens x $0.00003 + at most 5 prompt tokens x $0.0000015
    expect(one?.usd).toBeCloseTo(1290 * 0.00003 + 5 * 0.0000015, 5);
    expect(one?.basis).toBe("OpenRouter price (live), ~1290 tokens per image");
    const four = await estimate("image.generate", { prompt: "a cat", n: 4 }, ctx);
    expect(four?.usd).toBeCloseTo(4 * 1290 * 0.00003 + 5 * 0.0000015, 5);
    const edit = await estimate("image.edit", { artifact_id: "art_1", prompt: "a cat", n: 2 }, ctx);
    expect(edit?.usd).toBeCloseTo(2 * 1290 * 0.00003 + 5 * 0.0000015, 5);
    expect(
      await estimate("image.generate", { prompt: "x", model: "acme/unknown-image" }, ctx),
    ).toBeNull();
  });

  it("video.generate: per second from pricing_skus, by resolution and length", async () => {
    const { ctx } = await setup();
    // veo-3.1-fast: with audio is the higher SKU; no length asked: the longest allowed (8 of 4/6/8).
    const d = await estimate("video.generate", { prompt: "waves" }, ctx);
    expect(d?.usd).toBeCloseTo(0.12 * 8, 6);
    expect(d?.basis).toBe("OpenRouter price (live), 8 s, the longest allowed");
    const r = await estimate("video.generate", { prompt: "waves", duration_seconds: 4 }, ctx);
    expect(r?.usd).toBeCloseTo(0.12 * 4, 6);
    expect(r?.basis).toBe("OpenRouter price (cache), 4 s");
    const k4 = await estimate(
      "video.generate",
      { prompt: "w", duration_seconds: 6, resolution: "4k" },
      ctx,
    );
    expect(k4?.usd).toBeCloseTo(0.3 * 6, 6);
    const p720 = await estimate(
      "video.generate",
      { prompt: "w", duration_seconds: 5, resolution: "720p" },
      ctx,
    );
    expect(p720?.usd).toBeCloseTo(0.1 * 4, 6); // 5 s snaps to 4 (first nearest)
    // Token-priced (seedance) and unknown models have no estimate.
    expect(
      await estimate("video.generate", { prompt: "w", model: "bytedance/seedance-2.0" }, ctx),
    ).toBeNull();
    expect(await estimate("video.generate", { prompt: "w", model: "acme/nope" }, ctx)).toBeNull();
  });

  it("speech.generate: per character", async () => {
    const { ctx } = await setup();
    const r = await estimate("speech.generate", { text: "z".repeat(1000) }, ctx);
    expect(r?.usd).toBeCloseTo(0.08, 6);
    expect(r?.basis).toBe("OpenRouter price (live), per character");
    const r2 = await estimate("speech.generate", { text: "z".repeat(2500) }, ctx);
    expect(r2?.usd).toBeCloseTo(0.2, 6);
    expect(await estimate("speech.generate", { text: "z", model: "acme/nope" }, ctx)).toBeNull();
  });

  it("audio.transcribe: per second of the artifact's recorded length; null when unknown", async () => {
    const { ctx, lib } = await setup();
    lib.put("art_a", "audio/mpeg", new Uint8Array(40_000));
    expect(await estimate("audio.transcribe", { artifact_id: "art_a" }, ctx)).toBeNull();
    ((await lib.library.get("art_a")) as { meta: unknown }).meta = { duration_seconds: 3600 };
    const hour = await estimate("audio.transcribe", { artifact_id: "art_a" }, ctx);
    expect(hour?.usd).toBeCloseTo(0.22, 4);
    // The null call above already fetched the price, so this one is served from the cache.
    expect(hour?.basis).toBe("OpenRouter price (cache)");
    ((await lib.library.get("art_a")) as { meta: unknown }).meta = { duration_seconds: 1800 };
    expect((await estimate("audio.transcribe", { artifact_id: "art_a" }, ctx))?.usd).toBeCloseTo(
      0.11,
      4,
    );
    expect(await estimate("audio.transcribe", { artifact_id: "art_missing" }, ctx)).toBeNull();
    expect(
      await estimate("audio.transcribe", { artifact_id: "art_a", model: "acme/nope" }, ctx),
    ).toBeNull();
  });
});
