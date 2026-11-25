import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackContext } from "plughive/pack";
import { describe, expect, it } from "vitest";
import { providers } from "../../../packs/replicate/capabilities.js";
import pack from "../../../packs/replicate/index.js";
import { CAPABILITY_SCHEMAS } from "../../../src/core/capabilities/schemas.js";
import {
  boundFetch,
  bytesResponse,
  memLibrary,
  packTools,
  routerFetch,
  tempDir,
} from "../provider-support.js";
import { fakeCtx, jsonResponse } from "../support.js";

type Cap = keyof typeof CAPABILITY_SCHEMAS;

const find = (cap: Cap) => {
  const p = providers.find((x) => x.capability === cap);
  if (!p) throw new Error(`no ${cap} provider`);
  return p as unknown as { run(input: unknown, ctx: PackContext): Promise<unknown> };
};

const KEY = "r8_test_token_not_real";
const API = "https://api.replicate.com/v1";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0]);
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));

const MODELS: Record<string, string> = {
  "google/nano-banana": "model_nano_banana.json",
  "topazlabs/image-upscale": "model_image_upscale.json",
  "recraft-ai/recraft-remove-background": "model_recraft_remove_background.json",
  "sync/lipsync-2": "model_lipsync_2.json",
  "topazlabs/video-upscale": "model_video_upscale.json",
  "ryan5453/demucs": "model_demucs.json",
  "firtoz/trellis": "model_trellis.json",
  "zsxkib/mmaudio": "model_mmaudio.json",
};
const GLB = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0]);

async function setup(fetch: PackContext["fetch"]) {
  const lib = memLibrary({ packId: "replicate" });
  lib.put("img1", "image/png", PNG);
  lib.put("img2", "image/png", PNG);
  lib.put("vid1", "video/mp4", MP4);
  lib.put("aud1", "audio/mpeg", MP3);
  const base = fakeCtx({
    packId: "replicate",
    dataDir: tempDir("plughive-replicate-tasks-"),
    secrets: { REPLICATE_API_TOKEN: KEY },
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

/** Model lookup, prediction create, one poll and the output download for an official model. */
function run(model: string, final: Record<string, unknown>) {
  const esc = model.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  return routerFetch([
    {
      method: "GET",
      match: new RegExp(`^GET https://api\\.replicate\\.com/v1/models/${esc}$`),
      reply: () => jsonResponse(fixture(MODELS[model]!)),
    },
    {
      method: "POST",
      match: new RegExp(`/models/${esc}/predictions$`),
      reply: () => jsonResponse(prediction("starting"), 201),
    },
    {
      // Community models run by version.
      method: "POST",
      match: /^POST https:\/\/api\.replicate\.com\/v1\/predictions$/,
      reply: () => jsonResponse(prediction("starting"), 201),
    },
    {
      method: "GET",
      match: /\/predictions\/p1$/,
      reply: () => jsonResponse(prediction("succeeded", final)),
    },
    {
      match: /^GET https:\/\/replicate\.delivery\//,
      reply: ({ url }) =>
        url.endsWith(".mp4")
          ? bytesResponse(MP4, "video/mp4")
          : url.endsWith(".mp3")
            ? bytesResponse(MP3, "audio/mpeg")
            : url.endsWith(".glb")
              ? bytesResponse(GLB, "model/gltf-binary")
              : bytesResponse(PNG, "image/png"),
    },
  ]);
}

function submitted(fetch: ReturnType<typeof routerFetch>) {
  const post = fetch.calls.find((c) => c.method === "POST");
  if (!post?.body) throw new Error("no prediction");
  return JSON.parse(post.body).input;
}

async function call(cap: Cap, input: unknown, ctx: PackContext) {
  const out = await find(cap).run(CAPABILITY_SCHEMAS[cap].input.parse(input), ctx);
  return CAPABILITY_SCHEMAS[cap].output.parse(out) as {
    artifacts: { mime: string; stem?: string }[];
    model: string;
    warnings?: string[];
    provider: string;
  };
}

async function refusal(cap: Cap, model: string, input: unknown) {
  const fetch = run(model, {});
  const { ctx } = await setup(fetch);
  const err = await find(cap)
    .run(CAPABILITY_SCHEMAS[cap].input.parse(input), ctx)
    .catch((e: unknown) => e);
  expect(fetch.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  return err;
}

const UNSUPPORTED = { name: "CapabilityError", retryable: true, code: "UNSUPPORTED_OPTION" };
const out = (name: string) => ({ output: `https://replicate.delivery/xezq/abc/${name}` });

describe("replicate media task providers", () => {
  it("image.edit sends the image and references as image_input", async () => {
    const model = "google/nano-banana";
    const fetch = run(model, out("e.png"));
    const { ctx } = await setup(fetch);
    const res = await call(
      "image.edit",
      { artifact_id: "img1", reference_ids: ["img2"], prompt: "make it blue", aspect_ratio: "1:1" },
      ctx,
    );
    const body = submitted(fetch);
    expect(body.prompt).toBe("make it blue");
    expect(body.aspect_ratio).toBe("1:1");
    expect(body.image_input).toHaveLength(2);
    expect(body.image_input[0]).toMatch(/^data:image\/png;base64,/);
    expect(res).toMatchObject({ provider: "replicate", model });
    expect(res.artifacts).toHaveLength(1);
  });

  it("image.edit refuses a mask and n>1, before any prediction", async () => {
    const model = "google/nano-banana";
    expect(
      await refusal("image.edit", model, { artifact_id: "img1", prompt: "x", mask_id: "img2" }),
    ).toMatchObject(UNSUPPORTED);
    expect(
      await refusal("image.edit", model, { artifact_id: "img1", prompt: "x", n: 2 }),
    ).toMatchObject(UNSUPPORTED);
  });

  it("image.upscale maps the scale onto Topaz's factor names", async () => {
    const model = "topazlabs/image-upscale";
    const fetch = run(model, out("u.png"));
    const { ctx } = await setup(fetch);
    const res = await call("image.upscale", { artifact_id: "img1", scale: 2 }, ctx);
    expect(submitted(fetch)).toMatchObject({ upscale_factor: "2x" });
    expect(submitted(fetch).image).toMatch(/^data:image\/png/);
    expect(res).toMatchObject({ provider: "replicate", model });
    expect(await refusal("image.upscale", model, { artifact_id: "img1", scale: 3 })).toMatchObject(
      UNSUPPORTED,
    );
  });

  it("image.remove_background returns the cut-out image", async () => {
    const model = "recraft-ai/recraft-remove-background";
    const fetch = run(model, out("cut.png"));
    const { ctx } = await setup(fetch);
    const res = await call("image.remove_background", { artifact_id: "img1" }, ctx);
    expect(Object.keys(submitted(fetch))).toEqual(["image"]);
    expect(res.artifacts[0]?.mime).toBe("image/png");
  });

  it("video.lipsync sends video and audio, and refuses a still image", async () => {
    const model = "sync/lipsync-2";
    const fetch = run(model, out("ls.mp4"));
    const { ctx } = await setup(fetch);
    const res = await call("video.lipsync", { artifact_id: "vid1", audio_id: "aud1" }, ctx);
    const body = submitted(fetch);
    expect(body.video).toMatch(/^data:video\/mp4/);
    expect(body.audio).toMatch(/^data:audio\/mpeg/);
    expect(res.artifacts[0]?.mime).toBe("video/mp4");
    expect(
      await refusal("video.lipsync", model, { artifact_id: "img1", audio_id: "aud1" }),
    ).toMatchObject(UNSUPPORTED);
  });

  it("video.upscale maps the factor onto Topaz's target resolution", async () => {
    const model = "topazlabs/video-upscale";
    const fetch = run(model, out("up.mp4"));
    const { ctx } = await setup(fetch);
    const res = await call("video.upscale", { artifact_id: "vid1", scale: 4 }, ctx);
    const body = submitted(fetch);
    expect(body.video).toMatch(/^data:video\/mp4/);
    expect(body.target_resolution).toBe("4k");
    expect(res.artifacts[0]?.mime).toBe("video/mp4");
    expect(res.warnings?.[0]).toMatch(/source height is unknown/);
    expect(await refusal("video.upscale", model, { artifact_id: "img1" })).toMatchObject(
      UNSUPPORTED,
    );
  });

  it("separate_stems labels each stem by its output key and honours two_stems", async () => {
    const model = "ryan5453/demucs";
    const fetch = run(model, {
      output: {
        vocals: "https://replicate.delivery/xezq/abc/vocals.mp3",
        no_vocals: "https://replicate.delivery/xezq/abc/no_vocals.mp3",
        drums: null,
      },
    });
    const { ctx } = await setup(fetch);
    const res = await call(
      "audio.separate_stems",
      { artifact_id: "aud1", two_stems: "vocals", format: "wav" },
      ctx,
    );
    const post = fetch.calls.find((c) => c.method === "POST");
    // The pinned version and field names are those of the live model's schema.
    expect(JSON.parse(post?.body ?? "{}").version).toBe(
      "ff5ad47d2685b27c0f820ee134c4394140804f08fa755cb20c846459faa4b337",
    );
    expect(submitted(fetch)).toMatchObject({ isolate_stem: "vocals", format: "wav" });
    expect(res.artifacts.map((a) => a.stem).sort()).toEqual(["no_vocals", "vocals"]);
  });

  it("3d.generate sends the image as a list, asks for the mesh and keeps only the model file", async () => {
    const model = "firtoz/trellis";
    const fetch = run(model, {
      output: {
        model_file: "https://replicate.delivery/xezq/abc/mesh.glb",
        color_video: "https://replicate.delivery/xezq/abc/turn.mp4",
      },
    });
    const { ctx } = await setup(fetch);
    const res = await call("3d.generate", { artifact_id: "img1" }, ctx);
    const body = submitted(fetch);
    expect(body.images).toHaveLength(1);
    expect(body.generate_model).toBe(true);
    expect(res.artifacts).toHaveLength(1);
    expect(res.artifacts[0]?.mime).toBe("model/gltf-binary");
    // Text-only and non-GLB requests go to a provider that can honour them.
    expect(await refusal("3d.generate", model, { prompt: "a chair" })).toMatchObject(UNSUPPORTED);
    expect(
      await refusal("3d.generate", model, { artifact_id: "img1", format: "obj" }),
    ).toMatchObject(UNSUPPORTED);
  });

  it("sound.effect sends the prompt and duration, and refuses an out-of-range length", async () => {
    const model = "zsxkib/mmaudio";
    const fetch = run(model, out("boom.mp3"));
    const { ctx } = await setup(fetch);
    const res = await call("sound.effect", { prompt: "a door creaks", duration_seconds: 4 }, ctx);
    expect(submitted(fetch)).toEqual({ prompt: "a door creaks", duration: 4 });
    expect(res.artifacts[0]?.mime).toBe("audio/mpeg");
    expect(
      await refusal("sound.effect", model, { prompt: "x", duration_seconds: 0.5 }),
    ).toMatchObject(UNSUPPORTED);
    expect(await refusal("sound.effect", model, { prompt: "x", format: "wav" })).toMatchObject(
      UNSUPPORTED,
    );
  });

  it("a failed prediction is not retryable", async () => {
    const fetch = run("sync/lipsync-2", { status: "failed", error: "no face found" });
    const { ctx } = await setup(fetch);
    const err = (await find("video.lipsync")
      .run({ artifact_id: "vid1", audio_id: "aud1" }, ctx)
      .catch((e: unknown) => e)) as { name?: string; retryable?: boolean };
    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe("CapabilityError");
    expect(err.retryable).not.toBe(true);
  });
});
