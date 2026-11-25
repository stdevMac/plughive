import { fileURLToPath } from "node:url";
import { type AnyToolDefinition, CAPABILITY_NAMES, CapabilityError } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { providers as elevenProviders } from "../../../packs/elevenlabs/capabilities.js";
import { providers as geminiProviders } from "../../../packs/gemini/capabilities.js";
import { providers as localProviders } from "../../../packs/local/capabilities.js";
import { statsSeconds, stderrTail } from "../../../packs/local/lib/ffmpeg.js";
import mediaPack from "../../../packs/media/index.js";
import type { HostCapabilities } from "../../../src/core/packs/context.js";
import { failure } from "../provider-support.js";

const packDir = (id: string) => fileURLToPath(new URL(`../../../packs/${id}`, import.meta.url));
const harnesses: TestContext[] = [];
afterEach(async () => {
  for (const t of harnesses.splice(0)) await t.dispose();
});

function tool(name: string): AnyToolDefinition {
  const tools = mediaPack.tools;
  if (!Array.isArray(tools)) throw new Error("expected a static tool list");
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`${name} missing`);
  return t;
}

/** A capability router mock: `has` defaults to true, `list` rows are loosely typed. */
interface TestRouter {
  run: (...args: Parameters<HostCapabilities["run"]>) => Promise<unknown>;
  list: (...args: Parameters<HostCapabilities["list"]>) => Promise<object[]>;
  has?: HostCapabilities["has"];
}

function mediaCtx(router: TestRouter, toolName: string) {
  const capabilityRouter = { has: () => true, ...router } as HostCapabilities;
  const t = createTestContext({ packDir: packDir("media"), capabilityRouter });
  harnesses.push(t);
  return t.forTool(toolName);
}

describe("media pack", () => {
  it("declares the long-running tools and one capability per tool", () => {
    const expected: Record<string, [string | undefined, boolean]> = {
      generate_image: ["image.generate", true],
      generate_video: ["video.generate", true],
      generate_speech: ["speech.generate", false],
      generate_music: ["music.generate", true],
      transcribe_audio: ["audio.transcribe", true],
      chat: ["chat", false],
      edit_image: ["image.edit", true],
      upscale_image: ["image.upscale", true],
      remove_background: ["image.remove_background", true],
      upscale_video: ["video.upscale", true],
      lipsync_video: ["video.lipsync", true],
      separate_stems: ["audio.separate_stems", true],
      clone_voice: ["voice.clone", true],
      generate_sound_effect: ["sound.effect", true],
      generate_3d: ["3d.generate", true],
      parse_document: ["document.parse", true],
      convert_document: ["document.convert", true],
      translate_text: ["text.translate", false],
      embed_text: ["text.embed", false],
      rerank_text: ["text.rerank", false],
      search_web: ["web.search", false],
      fetch_web: ["web.fetch", false],
      get_media_transcript: ["media.transcript", true],
      list_media_providers: [undefined, false],
    };
    expect(mediaPack.tools).toHaveLength(Object.keys(expected).length);
    for (const [name, [cap, long]] of Object.entries(expected)) {
      const t = tool(name) as AnyToolDefinition & { capability?: string; longRunning?: boolean };
      expect(t.capability).toBe(cap);
      expect(Boolean(t.longRunning)).toBe(long);
    }
  });

  it("routes through ctx.capabilities, passing provider as a run option", async () => {
    const router = {
      run: vi.fn(async () => ({
        artifacts: [{ id: "a", url: "/a", mime: "image/png" }],
        model: "m",
        provider: "gemini",
      })),
      list: vi.fn(async () => []),
    };
    const t = tool("generate_image");
    const out = await t.run(
      t.input.parse({ prompt: "a cat", provider: "gemini", n: 2 }),
      mediaCtx(router, "generate_image"),
    );
    expect(out).toMatchObject({ provider: "gemini" });
    const [cap, input, opts, caller] = router.run.mock.calls[0] as unknown as unknown[];
    expect(cap).toBe("image.generate");
    expect(input).toEqual({ prompt: "a cat", n: 2 });
    expect(opts).toEqual({ provider: "gemini" });
    expect(caller).toMatchObject({ pack: "media", tool: "generate_image" });

    await t.run(t.input.parse({ prompt: "x" }), mediaCtx(router, "generate_image"));
    expect((router.run.mock.calls[1] as unknown as unknown[])[2]).toEqual({});
    expect(() => t.input.parse({ prompt: "x", provider: "Not Valid" })).toThrow();
  });

  it("adds a pointer to list_media_providers when nothing can serve the call", async () => {
    const router = {
      run: vi.fn(async () => {
        throw new CapabilityError(
          "no music.generate provider is set up. Any of these enables it: elevenlabs: set ELEVENLABS_API_KEY",
          {
            code: "NO_PROVIDER",
          },
        );
      }),
      list: vi.fn(async () => []),
    };
    const t = tool("generate_music");
    const err = await failure(
      t.run(t.input.parse({ prompt: "lofi" }), mediaCtx(router, "generate_music")),
    );
    expect(err).toBeInstanceOf(CapabilityError);
    expect((err as CapabilityError).code).toBe("NO_PROVIDER");
    expect(err.message).toContain("ELEVENLABS_API_KEY");
    expect(err.message).toContain("list_media_providers");

    // Other failures pass through untouched.
    router.run.mockImplementationOnce(async () => {
      throw new Error("upstream broke");
    });
    await expect(
      t.run(t.input.parse({ prompt: "lofi" }), mediaCtx(router, "generate_music")),
    ).rejects.toThrow(/^upstream broke$/);
  });

  it("list_media_providers groups providers by capability", async () => {
    const row = (capability: string, id: string, extra: object = {}) => ({
      capability,
      id,
      pack: id,
      priority: 50,
      configured: true,
      models: ["m"],
      coolingDownUntil: null,
      preferred: null,
      autoRoute: true,
      ...extra,
    });
    const router = {
      run: vi.fn(),
      list: vi.fn(async () => [
        row("image.generate", "gemini"),
        row("image.generate", "local", { configured: false, priority: 10 }),
        row("chat", "local", { coolingDownUntil: "2026-01-01T00:00:00.000Z" }),
      ]),
    };
    const t = tool("list_media_providers");
    const out = (await t.run(t.input.parse({}), mediaCtx(router, "list_media_providers"))) as {
      capabilities: {
        capability: string;
        ready: boolean;
        providers: { id: string; auto_route: boolean }[];
      }[];
    };
    expect(out.capabilities.map((c) => c.capability)).toEqual([...CAPABILITY_NAMES]);
    const image = out.capabilities[0];
    expect(image).toMatchObject({ ready: true });
    expect(image?.providers.map((p) => p.id)).toEqual(["gemini", "local"]);
    expect(out.capabilities.find((c) => c.capability === "chat")?.ready).toBe(false);
    expect(out.capabilities.find((c) => c.capability === "video.generate")).toEqual({
      capability: "video.generate",
      ready: false,
      providers: [],
    });
    const one = (await t.run(
      t.input.parse({ capability: "chat" }),
      mediaCtx(router, "list_media_providers"),
    )) as {
      capabilities: unknown[];
    };
    expect(one.capabilities).toHaveLength(1);
  });
});

describe("provider definitions", () => {
  const caps = (list: readonly { capability: string }[]) => list.map((p) => p.capability).sort();

  it("gemini (50), elevenlabs (60) and local (10) serve the expected capabilities, each with a setup hint", () => {
    expect(caps(geminiProviders)).toEqual(
      [
        "audio.transcribe",
        "chat",
        "image.edit",
        "image.generate",
        "music.generate",
        "speech.generate",
        "text.translate",
        "video.generate",
      ].sort(),
    );
    expect(caps(elevenProviders)).toEqual([
      "audio.transcribe",
      "music.generate",
      "sound.effect",
      "speech.generate",
      "voice.clone",
    ]);
    expect(caps(localProviders)).toEqual([
      "audio.separate_stems",
      "audio.transcribe",
      "chat",
      "document.convert",
      "document.parse",
      "image.edit",
      "image.generate",
      "image.remove_background",
      "image.upscale",
      "media.transcript",
      "speech.generate",
      "text.embed",
      "text.rerank",
      "text.translate",
      "video.upscale",
    ]);
    for (const [list, id, priority] of [
      [geminiProviders, "gemini", 50],
      [elevenProviders, "elevenlabs", 60],
      [localProviders, "local", 10],
    ] as const) {
      for (const p of list) {
        expect(p.id).toBe(id);
        expect(p.priority).toBe(priority);
        expect(p.setupHint).toEqual(expect.any(String));
        expect(p.setupHint).not.toMatch(/—/);
      }
    }
  });

  it("elevenlabs is configured exactly when its key is set", async () => {
    const withKey = createTestContext({
      packDir: packDir("elevenlabs"),
      secrets: { ELEVENLABS_API_KEY: "fixture" },
    });
    const without = createTestContext({ packDir: packDir("elevenlabs") });
    harnesses.push(withKey, without);
    const p = elevenProviders[0];
    expect(await p?.isConfigured(withKey.forTool("x") as never)).toBe(true);
    expect(await p?.isConfigured(without.forTool("x") as never)).toBe(false);
  });

  it("refuses unsupported options with a retryable error before any request", async () => {
    const fetch = vi.fn(async () => new Response("{}"));
    const t = createTestContext({
      packDir: packDir("elevenlabs"),
      secrets: { ELEVENLABS_API_KEY: "fixture" },
      fetch,
    });
    harnesses.push(t);
    const speech = elevenProviders.find((p) => p.capability === "speech.generate");
    const err = await Promise.resolve()
      .then(() => speech?.run({ text: "hi", format: "flac" } as never, t.forTool("x") as never))
      .catch((e) => e);
    expect(err).toBeInstanceOf(CapabilityError);
    expect(err.retryable).toBe(true);

    const localImage = localProviders.find((p) => p.capability === "image.generate");
    const e2 = await Promise.resolve()
      .then(() => localImage?.run({ prompt: "x", image_inputs: ["a1"] } as never, {} as never))
      .catch((e) => e);
    expect(e2).toBeInstanceOf(CapabilityError);
    expect(e2.retryable).toBe(true);

    const geminiVideo = geminiProviders.find((p) => p.capability === "video.generate");
    const e3 = await Promise.resolve()
      .then(() => geminiVideo?.run({ prompt: "x", aspect_ratio: "1:1" } as never, {} as never))
      .catch((e) => e);
    expect(e3).toBeInstanceOf(CapabilityError);
    expect(e3.retryable).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("ffmpeg progress lines", () => {
  it("statsSeconds reads -stats lines only", () => {
    expect(
      statsSeconds(
        "frame=  120 fps=60 q=28.0 size=     256kB time=00:01:02.50 bitrate= 33.5kbits/s speed=2.0x",
      ),
    ).toBe(62.5);
    expect(statsSeconds("size=N/A time=01:00:00.00 bitrate=N/A speed=1x")).toBe(3600);
    expect(statsSeconds("Duration: 00:00:10.00, start: 0.000000")).toBeNull();
    expect(statsSeconds("time=00:00:01.00 with no stats markers")).toBeNull();
  });

  it("stderrTail drops progress lines", () => {
    const err = [
      "Input #0, wav",
      "size=  1kB time=00:00:01.00 bitrate=1kbits/s speed=1x",
      "Error opening output file",
    ].join("\r");
    expect(stderrTail(err)).toBe("Input #0, wav | Error opening output file");
  });
});

describe("spend estimates and max_cost_usd", () => {
  type Estimating = { estimate?: (input: never, ctx: never) => unknown };
  const find = (list: readonly { capability: string }[], cap: string) => {
    const p = list.find((x) => x.capability === cap);
    if (!p) throw new Error(`${cap} missing`);
    return p as Estimating;
  };
  const est = (p: Estimating, input: object) => p.estimate?.(input as never, {} as never);

  it("media tools accept max_cost_usd and hand it to the router as a run option", async () => {
    const router = {
      run: vi.fn(async () => ({
        artifacts: [{ id: "a", url: "/a", mime: "image/png" }],
        model: "m",
        provider: "local",
      })),
      list: vi.fn(async () => []),
    };
    const t = tool("generate_image");
    await t.run(
      t.input.parse({ prompt: "a cat", max_cost_usd: 0.05 }),
      mediaCtx(router, "generate_image"),
    );
    const [, input, opts] = router.run.mock.calls[0] as unknown as unknown[];
    expect(input).toEqual({ prompt: "a cat" });
    expect(opts).toEqual({ maxCostUsd: 0.05 });
    expect(() => t.input.parse({ prompt: "x", max_cost_usd: -1 })).toThrow();
    expect(() => t.input.parse({ prompt: "x", max_cost_usd: "1" })).toThrow();
  });

  it("every routed media tool accepts provider, max_cost_usd and cache: false as run options", async () => {
    const tools = mediaPack.tools as AnyToolDefinition[];
    const routed = tools.filter((t) => t.capability !== undefined);
    expect(routed.length).toBeGreaterThanOrEqual(23);
    for (const t of routed) {
      const shape = (t.input as unknown as { shape: Record<string, unknown> }).shape;
      expect(Object.keys(shape), t.name).toEqual(
        expect.arrayContaining(["provider", "max_cost_usd", "cache"]),
      );
    }
    const router = {
      run: vi.fn(async () => ({
        artifacts: [{ id: "a", url: "/a", mime: "image/png" }],
        model: "m",
        provider: "fal",
      })),
      list: vi.fn(async () => []),
    };
    const t = tool("edit_image");
    await t.run(
      t.input.parse({
        artifact_id: "img1",
        prompt: "make it blue",
        max_cost_usd: 0.1,
        cache: false,
      }),
      mediaCtx(router, "edit_image"),
    );
    const [, input, opts] = router.run.mock.calls[0] as unknown as unknown[];
    expect(input).toEqual({ artifact_id: "img1", prompt: "make it blue" });
    expect(opts).toEqual({ maxCostUsd: 0.1, cache: false });
    await t.run(
      t.input.parse({ artifact_id: "img1", prompt: "make it blue", cache: true }),
      mediaCtx(router, "edit_image"),
    );
    expect((router.run.mock.calls[1] as unknown as unknown[])[2]).toEqual({});
  });

  it("local providers estimate 0; gemini estimates images, video and music from its table", async () => {
    for (const p of localProviders)
      expect(await est(p as Estimating, {})).toMatchObject({ usd: 0 });
    const image = find(geminiProviders, "image.generate");
    expect(await est(image, { prompt: "x", n: 2 })).toMatchObject({
      usd: 0.0672,
      basis: expect.stringContaining("static table"),
    });
    const video = find(geminiProviders, "video.generate");
    const hd = { prompt: "x", resolution: "1080p", duration_seconds: 5 };
    expect(await est(video, hd)).toMatchObject({ usd: 0.52 });
    // The default: 10 s at 720p.
    expect(await est(video, { prompt: "x" })).toMatchObject({ usd: 0.7 });
    const music = find(geminiProviders, "music.generate");
    expect(await est(music, { prompt: "x", duration_seconds: 20 })).toMatchObject({ usd: 0.04 });
    expect(await est(music, { prompt: "x", model: "lyria-3-pro-preview" })).toBeNull();
    // Token-priced: no estimate, so a max_cost_usd skips them.
    for (const cap of ["speech.generate", "audio.transcribe", "chat"]) {
      expect(find(geminiProviders, cap).estimate).toBeUndefined();
    }
  });
});
