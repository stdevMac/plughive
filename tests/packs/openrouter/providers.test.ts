import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackContext } from "plughive/pack";
import { afterEach, describe, expect, it } from "vitest";
import { providers } from "../../../packs/openrouter/capabilities.js";
import pack from "../../../packs/openrouter/index.js";
import { CAPABILITY_SCHEMAS } from "../../../src/core/capabilities/schemas.js";
import {
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

const KEY = "sk-or-test-not-real";
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const VIDEOS = fixture("videos_models.json");
const IMAGES = fixture("images_models.json");
const SPEECH = fixture("speech_models.json");
const dirs: string[] = [];
afterEach(() => {
  dirs.length = 0;
});

const catalogRoutes = [
  {
    match: /^GET https:\/\/openrouter\.ai\/api\/v1\/videos\/models$/,
    reply: () => jsonResponse(VIDEOS),
  },
  {
    match: /^GET https:\/\/openrouter\.ai\/api\/v1\/images\/models$/,
    reply: () => jsonResponse(IMAGES),
  },
  {
    match: /^GET https:\/\/openrouter\.ai\/api\/v1\/audio\/speech\/models$/,
    reply: () => jsonResponse(SPEECH),
  },
];

async function setup(fetch: PackContext["fetch"], secrets: Record<string, string> = {}) {
  const dir = tempDir("plughive-openrouter-prov-");
  dirs.push(dir);
  const lib = memLibrary();
  const base = fakeCtx({
    packId: "openrouter",
    dataDir: dir,
    secrets,
    settings: { models: "" },
    fetch,
    library: lib.library,
  });
  const { ctx } = await packTools(pack, base);
  (ctx as PackContext & { openrouter: { pollInitialMs: number } }).openrouter.pollInitialMs = 1;
  return { ctx: { ...ctx, fetch } as PackContext };
}

describe("openrouter capability providers", () => {
  it("are registered in the loaded pack with chat above media", async () => {
    const h = await loadPacksOffline();
    try {
      const info = (await h.loader.listPacks()).find((p: { id: string }) => p.id === "openrouter")!;
      expect([...info.providers].sort()).toEqual([
        "audio.transcribe:openrouter",
        "chat:openrouter",
        "image.edit:openrouter",
        "image.generate:openrouter",
        "speech.generate:openrouter",
        "text.embed:openrouter",
        "text.translate:openrouter",
        "video.generate:openrouter",
      ]);
    } finally {
      await h.close();
    }
    for (const p of providers) {
      expect(p.id).toBe("openrouter");
      expect(p.priority).toBe(p.capability === "chat" ? 70 : 40);
    }
  });

  it("isConfigured follows OPENROUTER_API_KEY", async () => {
    const off = await setup(routerFetch([]));
    const on = await setup(routerFetch([]), { OPENROUTER_API_KEY: KEY });
    for (const p of providers) {
      expect(await p.isConfigured(off.ctx as never)).toBe(false);
      expect(await p.isConfigured(on.ctx as never)).toBe(true);
    }
  });

  it("chat returns the canonical output shape", async () => {
    const fetch = routerFetch([
      {
        match: /^POST https:\/\/openrouter\.ai\/api\/v1\/chat\/completions$/,
        reply: () =>
          jsonResponse({
            model: "minimax/minimax-m2.7",
            choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3, cost: 0.0001 },
          }),
      },
    ]);
    const { ctx } = await setup(fetch, { OPENROUTER_API_KEY: KEY });
    const out = await find("chat").run(
      CAPABILITY_SCHEMAS.chat.input.parse({ messages: [{ role: "user", content: "hello" }] }),
      ctx,
    );
    const parsed = CAPABILITY_SCHEMAS.chat.output.parse(out);
    expect(parsed).toMatchObject({ text: "hi", provider: "openrouter" });
  });

  it("speech.generate returns the canonical output shape with an audio artifact", async () => {
    const fetch = routerFetch([
      ...catalogRoutes,
      {
        match: /^POST https:\/\/openrouter\.ai\/api\/v1\/audio\/speech$/,
        reply: () => bytesResponse(new Uint8Array([0xff, 0xfb, 1]), "audio/mpeg"),
      },
    ]);
    const { ctx } = await setup(fetch, { OPENROUTER_API_KEY: KEY });
    const out = await find("speech.generate").run(
      CAPABILITY_SCHEMAS["speech.generate"].input.parse({ text: "hello" }),
      ctx,
    );
    const parsed = CAPABILITY_SCHEMAS["speech.generate"].output.parse(out);
    expect(parsed).toMatchObject({ provider: "openrouter" });
    expect(parsed.artifacts[0]!.mime).toBe("audio/mpeg");
  });

  it("refuses an input the model cannot honour with a retryable error, before any POST", async () => {
    const fetch = routerFetch(catalogRoutes);
    const { ctx } = await setup(fetch, { OPENROUTER_API_KEY: KEY });
    const err = await find("image.generate")
      .run({ prompt: "x", seed: 1 }, ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      name: "CapabilityError",
      retryable: true,
      code: "UNSUPPORTED_OPTION",
    });
    expect(fetch.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
