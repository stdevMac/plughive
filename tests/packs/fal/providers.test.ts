import type { PackContext } from "plughive/pack";
import { afterEach, describe, expect, it } from "vitest";
import { providers } from "../../../packs/fal/capabilities.js";
import pack from "../../../packs/fal/index.js";
import { CAPABILITY_SCHEMAS } from "../../../src/core/capabilities/schemas.js";
import {
  boundFetch,
  bytesResponse,
  loadPacksOffline,
  memLibrary,
  packTools,
  routerFetch,
  tempDir,
} from "../provider-support.js";
import { fakeCtx, jsonResponse } from "../support.js";

const find = (cap: string) => {
  const p = providers.find((x) => x.capability === cap);
  if (!p) throw new Error(`no ${cap} provider`);
  return p as unknown as {
    capability: string;
    id: string;
    priority?: number;
    isConfigured(ctx: PackContext): boolean | Promise<boolean>;
    models?(ctx: PackContext): readonly string[] | Promise<readonly string[]>;
    run(input: unknown, ctx: PackContext): Promise<unknown>;
  };
};

const KEY = "fal-test-key-not-real";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const dirs: string[] = [];
afterEach(() => {
  dirs.length = 0;
});

async function setup(fetch: PackContext["fetch"], secrets: Record<string, string> = {}) {
  const dir = tempDir("plughive-fal-prov-");
  dirs.push(dir);
  const lib = memLibrary({ packId: "fal" });
  const base = fakeCtx({
    packId: "fal",
    dataDir: dir,
    secrets,
    settings: { models: "" },
    fetch,
    library: lib.library,
  });
  const { ctx } = await packTools(pack, base);
  (ctx as PackContext & { fal: { pollInitialMs: number } }).fal.pollInitialMs = 1;
  return { ctx: { ...ctx, fetch: boundFetch(fetch, ctx.signal) } as PackContext };
}

describe("fal capability providers", () => {
  it("are registered in the loaded pack with the expected priority", async () => {
    const h = await loadPacksOffline();
    try {
      const info = (await h.loader.listPacks()).find((p: { id: string }) => p.id === "fal")!;
      expect([...info.providers].sort()).toEqual([
        "3d.generate:fal",
        "audio.separate_stems:fal",
        "audio.transcribe:fal",
        "image.edit:fal",
        "image.generate:fal",
        "image.remove_background:fal",
        "image.upscale:fal",
        "music.generate:fal",
        "sound.effect:fal",
        "speech.generate:fal",
        "video.generate:fal",
        "video.lipsync:fal",
        "video.upscale:fal",
      ]);
    } finally {
      await h.close();
    }
    for (const p of providers) {
      expect(p.id).toBe("fal");
      expect(p.priority).toBe(45);
    }
  });

  it("isConfigured follows FAL_KEY", async () => {
    const off = await setup(routerFetch([]));
    const on = await setup(routerFetch([]), { FAL_KEY: KEY });
    for (const p of providers) {
      expect(await p.isConfigured(off.ctx as never)).toBe(false);
      expect(await p.isConfigured(on.ctx as never)).toBe(true);
    }
  });

  it("lists the default model so explicit routing finds it", async () => {
    const { ctx } = await setup(routerFetch([]), { FAL_KEY: KEY });
    expect(await find("image.generate").models!(ctx)).toContain("fal-ai/nano-banana-pro");
  });

  it("image.generate returns the canonical output shape", async () => {
    const id = "req-9";
    const base = `https://queue.fal.run/fal-ai/nano-banana-pro/requests/${id}`;
    const fetch = routerFetch([
      {
        method: "POST",
        match: /^POST https:\/\/queue\.fal\.run\/fal-ai\/nano-banana-pro$/,
        reply: () =>
          jsonResponse({
            request_id: id,
            status_url: `${base}/status`,
            response_url: base,
            cancel_url: `${base}/cancel`,
          }),
      },
      { match: /\/status$/, reply: () => jsonResponse({ status: "COMPLETED" }) },
      {
        method: "GET",
        match: /requests\/req-9$/,
        reply: () =>
          jsonResponse({
            images: [{ url: "https://v3b.fal.media/files/a.png", content_type: "image/png" }],
          }),
      },
      { match: /^GET https:\/\/v3b\.fal\.media\//, reply: () => bytesResponse(PNG, "image/png") },
    ]);
    const { ctx } = await setup(fetch, { FAL_KEY: KEY });
    const out = await find("image.generate").run(
      CAPABILITY_SCHEMAS["image.generate"].input.parse({ prompt: "a lighthouse" }),
      ctx,
    );
    const parsed = CAPABILITY_SCHEMAS["image.generate"].output.parse(out);
    expect(parsed).toMatchObject({ provider: "fal", model: "fal-ai/nano-banana-pro" });
    expect(parsed.artifacts).toHaveLength(1);
  });

  it("refuses an input the model cannot honour with a retryable error, before any request", async () => {
    const fetch = routerFetch([]);
    const { ctx } = await setup(fetch, { FAL_KEY: KEY });
    const err = await find("image.generate")
      .run({ prompt: "x", aspect_ratio: "7:3" }, ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      name: "CapabilityError",
      retryable: true,
      code: "UNSUPPORTED_OPTION",
    });
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("fal cost estimates", () => {
  const priceRoute = (prices: Record<string, { unit_price: number; unit: string }>) => ({
    method: "GET",
    match: /^GET https:\/\/api\.fal\.ai\/v1\/models\/pricing\?/,
    reply: ({ url }: { url: string }) => {
      const ids = new URL(url).searchParams.getAll("endpoint_id");
      return jsonResponse({
        prices: ids
          .filter((id) => prices[id])
          .map((id) => ({ endpoint_id: id, currency: "USD", ...prices[id] })),
      });
    },
  });
  const estimate = (cap: string, input: object, ctx: PackContext) =>
    (
      find(cap) as unknown as {
        estimate(i: unknown, c: PackContext): Promise<{ usd: number; basis: string } | null>;
      }
    ).estimate(CAPABILITY_SCHEMAS[cap as keyof typeof CAPABILITY_SCHEMAS].input.parse(input), ctx);

  it("every provider can estimate", () => {
    for (const p of providers)
      expect(typeof (p as { estimate?: unknown }).estimate).toBe("function");
  });

  it("multiplies fal's unit price by images, seconds or characters", async () => {
    const fetch = routerFetch([
      priceRoute({
        "fal-ai/nano-banana-pro": { unit_price: 0.15, unit: "image" },
        "fal-ai/kling-video/v3/pro/text-to-video": { unit_price: 0.1, unit: "second" },
        "fal-ai/minimax/speech-2.8-hd": { unit_price: 0.1, unit: "1000 characters" },
        "fal-ai/hunyuan-3d/v3.1/pro/text-to-3d": { unit_price: 0.375, unit: "generation" },
      }),
    ]);
    const { ctx } = await setup(fetch, { FAL_KEY: KEY });
    expect(await estimate("image.generate", { prompt: "a cat", n: 2 }, ctx)).toMatchObject({
      usd: 0.3,
      basis: expect.stringMatching(/fal price API/),
    });
    expect(
      await estimate("video.generate", { prompt: "waves", duration_seconds: 10 }, ctx),
    ).toMatchObject({ usd: 1 });
    expect(await estimate("speech.generate", { text: "x".repeat(500) }, ctx)).toMatchObject({
      usd: 0.05,
    });
    expect(await estimate("3d.generate", { prompt: "a chair" }, ctx)).toMatchObject({ usd: 0.375 });
    // Prices are cached: asking again does not call fal.
    const before = fetch.calls.length;
    await estimate("image.generate", { prompt: "a dog" }, ctx);
    expect(fetch.calls.length).toBe(before);
    for (const c of fetch.calls) expect(c.headers.authorization).toMatch(/^Key /);
  });

  it("works out the length the way the run sends it", async () => {
    const fetch = routerFetch([
      priceRoute({
        "fal-ai/kling-video/v3/pro/text-to-video": { unit_price: 0.1, unit: "second" },
        "fal-ai/elevenlabs/music": { unit_price: 0.01, unit: "second" },
        "fal-ai/elevenlabs/sound-effects/v2": { unit_price: 0.002, unit: "second" },
      }),
    ]);
    const { ctx } = await setup(fetch, { FAL_KEY: KEY });
    const kling = { model: "fal-ai/kling-video/v3/pro/text-to-video", prompt: "waves" };
    // Kling allows 3-15 s: 20 s is sent as 15, 8 as 8, and no length uses the 5 s default.
    expect(await estimate("video.generate", { ...kling, duration_seconds: 20 }, ctx)).toMatchObject(
      { usd: 1.5 },
    );
    expect(await estimate("video.generate", { ...kling, duration_seconds: 8 }, ctx)).toMatchObject({
      usd: 0.8,
    });
    expect(await estimate("video.generate", kling, ctx)).toMatchObject({ usd: 0.5 });
    // ElevenLabs music is sent in ms; without a length the model picks one, so the cost is unknown.
    const music = { model: "fal-ai/elevenlabs/music", prompt: "jazz" };
    expect(await estimate("music.generate", { ...music, duration_seconds: 30 }, ctx)).toMatchObject(
      { usd: 0.3 },
    );
    expect(await estimate("music.generate", music, ctx)).toBeNull();
    const sound = { model: "fal-ai/elevenlabs/sound-effects/v2", prompt: "door" };
    expect(await estimate("sound.effect", { ...sound, duration_seconds: 5 }, ctx)).toMatchObject({
      usd: 0.01,
    });
    expect(await estimate("sound.effect", sound, ctx)).toBeNull();
  });

  it("is null when the count, the unit or the key is unknown", async () => {
    const fetch = routerFetch([
      priceRoute({
        "fal-ai/wizper": { unit_price: 0.5, unit: "audio minute" },
        "fal-ai/seedvr/upscale/image": { unit_price: 0.001, unit: "megapixel" },
      }),
    ]);
    const { ctx } = await setup(fetch, { FAL_KEY: KEY });
    expect(await estimate("audio.transcribe", { artifact_id: "a1" }, ctx)).toBeNull();
    expect(await estimate("image.upscale", { artifact_id: "a1" }, ctx)).toBeNull();
    // No price listed for the model.
    expect(await estimate("image.remove_background", { artifact_id: "a1" }, ctx)).toBeNull();
    const nokey = await setup(routerFetch([]));
    expect(await estimate("image.generate", { prompt: "a cat" }, nokey.ctx)).toBeNull();
  });

  it("is null when fal's price API fails", async () => {
    const fetch = routerFetch([
      { match: /models\/pricing/, reply: () => jsonResponse({ error: "down" }, 500) },
    ]);
    const { ctx } = await setup(fetch, { FAL_KEY: KEY });
    expect(await estimate("image.generate", { prompt: "a cat" }, ctx)).toBeNull();
  });
});
