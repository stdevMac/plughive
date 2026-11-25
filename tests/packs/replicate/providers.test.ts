import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackContext } from "plughive/pack";
import { afterEach, describe, expect, it } from "vitest";
import { providers } from "../../../packs/replicate/capabilities.js";
import pack from "../../../packs/replicate/index.js";
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

const KEY = "r8_test_token_not_real";
const MODEL = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "model_flux_schnell.json"), "utf8"),
);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4]);
const API = "https://api.replicate.com/v1";
const dirs: string[] = [];
afterEach(() => {
  dirs.length = 0;
});

async function setup(fetch: PackContext["fetch"], secrets: Record<string, string> = {}) {
  const dir = tempDir("plughive-replicate-prov-");
  dirs.push(dir);
  const lib = memLibrary({ packId: "replicate" });
  const base = fakeCtx({
    packId: "replicate",
    dataDir: dir,
    secrets,
    settings: { models: "" },
    fetch,
    library: lib.library,
  });
  const { ctx } = await packTools(pack, base);
  (ctx as PackContext & { replicate: { pollInitialMs: number } }).replicate.pollInitialMs = 1;
  return { ctx: { ...ctx, fetch: boundFetch(fetch, ctx.signal) } as PackContext };
}

const prediction = (status: string, extra: Record<string, unknown> = {}) => ({
  id: "p1",
  status,
  output: null,
  error: null,
  logs: "",
  urls: { get: `${API}/predictions/p1`, cancel: `${API}/predictions/p1/cancel` },
  ...extra,
});

const modelRoute = {
  method: "GET",
  match: /^GET https:\/\/api\.replicate\.com\/v1\/models\/black-forest-labs\/flux-schnell$/,
  reply: () => jsonResponse(MODEL),
};

describe("replicate capability providers", () => {
  it("are registered in the loaded pack with the expected priority", async () => {
    const h = await loadPacksOffline();
    try {
      const info = (await h.loader.listPacks()).find((p: { id: string }) => p.id === "replicate")!;
      expect([...info.providers].sort()).toEqual([
        "3d.generate:replicate",
        "audio.separate_stems:replicate",
        "audio.transcribe:replicate",
        "image.edit:replicate",
        "image.generate:replicate",
        "image.remove_background:replicate",
        "image.upscale:replicate",
        "music.generate:replicate",
        "sound.effect:replicate",
        "speech.generate:replicate",
        "video.generate:replicate",
        "video.lipsync:replicate",
        "video.upscale:replicate",
      ]);
    } finally {
      await h.close();
    }
    for (const p of providers) {
      expect(p.id).toBe("replicate");
      expect(p.priority).toBe(35);
    }
  });

  it("isConfigured follows REPLICATE_API_TOKEN", async () => {
    const off = await setup(routerFetch([]));
    const on = await setup(routerFetch([]), { REPLICATE_API_TOKEN: KEY });
    for (const p of providers) {
      expect(await p.isConfigured(off.ctx as never)).toBe(false);
      expect(await p.isConfigured(on.ctx as never)).toBe(true);
    }
  });

  it("image.generate returns the canonical output shape", async () => {
    const fetch = routerFetch([
      modelRoute,
      {
        method: "POST",
        match: /\/models\/black-forest-labs\/flux-schnell\/predictions$/,
        reply: () => jsonResponse(prediction("starting"), 201),
      },
      {
        method: "GET",
        match: /\/predictions\/p1$/,
        reply: () =>
          jsonResponse(
            prediction("succeeded", { output: ["https://replicate.delivery/xezq/abc/out-0.webp"] }),
          ),
      },
      {
        match: /^GET https:\/\/replicate\.delivery\//,
        reply: () => bytesResponse(WEBP, "image/webp"),
      },
    ]);
    const { ctx } = await setup(fetch, { REPLICATE_API_TOKEN: KEY });
    const out = await find("image.generate").run(
      CAPABILITY_SCHEMAS["image.generate"].input.parse({ prompt: "a lighthouse" }),
      ctx,
    );
    const parsed = CAPABILITY_SCHEMAS["image.generate"].output.parse(out);
    expect(parsed).toMatchObject({
      provider: "replicate",
      model: "black-forest-labs/flux-schnell",
    });
    expect(parsed.artifacts).toHaveLength(1);
  });

  it("refuses an input the model cannot honour with a retryable error, before any prediction", async () => {
    const fetch = routerFetch([modelRoute]);
    const { ctx } = await setup(fetch, { REPLICATE_API_TOKEN: KEY });
    const err = await find("image.generate")
      .run({ prompt: "x", aspect_ratio: "7:3" }, ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      name: "CapabilityError",
      retryable: true,
      code: "UNSUPPORTED_OPTION",
    });
    expect(fetch.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});
