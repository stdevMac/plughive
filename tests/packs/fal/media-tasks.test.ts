import type { PackContext } from "plughive/pack";
import { describe, expect, it } from "vitest";
import { providers } from "../../../packs/fal/capabilities.js";
import { parseSpec } from "../../../packs/fal/client.js";
import pack from "../../../packs/fal/index.js";
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
  return p as unknown as {
    models?(ctx: PackContext): readonly string[] | Promise<readonly string[]>;
    run(input: unknown, ctx: PackContext): Promise<unknown>;
  };
};

const KEY = "fal-test-key-not-real";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
const MP3 = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0]);

async function setup(fetch: PackContext["fetch"]) {
  const lib = memLibrary({ packId: "fal" });
  lib.put("img1", "image/png", PNG);
  lib.put("img2", "image/png", PNG);
  lib.put("vid1", "video/mp4", MP4);
  lib.put("aud1", "audio/mpeg", MP3);
  const base = fakeCtx({
    packId: "fal",
    dataDir: tempDir("plughive-fal-tasks-"),
    secrets: { FAL_KEY: KEY },
    settings: { models: "" },
    fetch,
    library: lib.library,
  });
  const { ctx } = await packTools(pack, base);
  (ctx as PackContext & { fal: { pollInitialMs: number } }).fal.pollInitialMs = 1;
  return { ctx: { ...ctx, fetch: boundFetch(fetch, ctx.signal) } as PackContext };
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Queue submit, one status poll, the result and the CDN downloads for one model. */
function queue(model: string, result: unknown) {
  const id = "req-1";
  const base = `https://queue.fal.run/${model}/requests/${id}`;
  return routerFetch([
    {
      method: "POST",
      match: new RegExp(`^POST https://queue\\.fal\\.run/${esc(model)}$`),
      reply: () =>
        jsonResponse({
          request_id: id,
          status_url: `${base}/status`,
          response_url: base,
          cancel_url: `${base}/cancel`,
        }),
    },
    { match: /\/status$/, reply: () => jsonResponse({ status: "COMPLETED" }) },
    { method: "GET", match: /requests\/req-1$/, reply: () => jsonResponse(result) },
    {
      match: /^GET https:\/\/v3b\.fal\.media\//,
      reply: ({ url }) =>
        url.endsWith(".mp4")
          ? bytesResponse(MP4, "video/mp4")
          : url.endsWith(".mp3")
            ? bytesResponse(MP3, "audio/mpeg")
            : url.endsWith(".glb")
              ? bytesResponse(PNG, "model/gltf-binary")
              : bytesResponse(PNG, "image/png"),
    },
  ]);
}

const file = (name: string, type: string) => ({
  url: `https://v3b.fal.media/files/${name}`,
  content_type: type,
});

function submitted(fetch: ReturnType<typeof routerFetch>) {
  const post = fetch.calls.find((c) => c.method === "POST");
  if (!post?.body) throw new Error("no submit");
  return JSON.parse(post.body);
}

async function call(cap: Cap, input: unknown, ctx: PackContext) {
  const out = await find(cap).run(CAPABILITY_SCHEMAS[cap].input.parse(input), ctx);
  return CAPABILITY_SCHEMAS[cap].output.parse(out) as {
    artifacts: { id: string; mime: string; stem?: string }[];
    model: string;
    provider: string;
  };
}

async function refusal(cap: Cap, input: unknown) {
  const fetch = routerFetch([]);
  const { ctx } = await setup(fetch);
  const err = await find(cap)
    .run(CAPABILITY_SCHEMAS[cap].input.parse(input), ctx)
    .catch((e: unknown) => e);
  expect(fetch.calls).toHaveLength(0);
  return err;
}

const UNSUPPORTED = { name: "CapabilityError", retryable: true, code: "UNSUPPORTED_OPTION" };

describe("fal media task providers", () => {
  it("does not list task models as image or music generators", async () => {
    const { ctx } = await setup(routerFetch([]));
    const image = await find("image.generate").models!(ctx);
    expect(image).not.toContain("fal-ai/seedvr/upscale/image");
    expect(image).not.toContain("fal-ai/bria/background/remove");
    expect(await find("music.generate").models!(ctx)).not.toContain(
      "fal-ai/elevenlabs/sound-effects/v2",
    );
    expect(await find("image.upscale").models!(ctx)).toContain("fal-ai/seedvr/upscale/image");
  });

  it("image.edit sends the image and references to the edit model", async () => {
    const model = "fal-ai/nano-banana-pro/edit";
    const fetch = queue(model, { images: [file("e.png", "image/png")] });
    const { ctx } = await setup(fetch);
    const out = await call(
      "image.edit",
      { artifact_id: "img1", reference_ids: ["img2"], prompt: "make it blue" },
      ctx,
    );
    const body = submitted(fetch);
    expect(body.prompt).toBe("make it blue");
    expect(body.image_urls).toHaveLength(2);
    expect(body.image_urls[0]).toMatch(/^data:image\/png;base64,/);
    expect(out).toMatchObject({ provider: "fal", model });
    expect(out.artifacts).toHaveLength(1);
  });

  it("image.edit refuses a mask the model cannot take, before any request", async () => {
    expect(
      await refusal("image.edit", { artifact_id: "img1", prompt: "x", mask_id: "img2" }),
    ).toMatchObject(UNSUPPORTED);
  });

  it("image.upscale sets the factor and returns only the image", async () => {
    const model = "fal-ai/seedvr/upscale/image";
    const fetch = queue(model, { image: file("u.png", "image/png"), seed: 1 });
    const { ctx } = await setup(fetch);
    const out = await call("image.upscale", { artifact_id: "img1", scale: 3 }, ctx);
    expect(submitted(fetch)).toMatchObject({ upscale_factor: 3, upscale_mode: "factor" });
    expect(out).toMatchObject({ provider: "fal", model });
    expect(out.artifacts).toHaveLength(1);
  });

  it("image.remove_background returns the cut-out image", async () => {
    const model = "fal-ai/bria/background/remove";
    const fetch = queue(model, { image: file("cut.png", "image/png") });
    const { ctx } = await setup(fetch);
    const out = await call("image.remove_background", { artifact_id: "img1" }, ctx);
    expect(submitted(fetch).image_url).toMatch(/^data:image\/png/);
    expect(out.artifacts).toHaveLength(1);
  });

  it("video.upscale sets the factor on the video model", async () => {
    const model = "fal-ai/seedvr/upscale/video";
    const fetch = queue(model, { video: file("up.mp4", "video/mp4"), seed: 2 });
    const { ctx } = await setup(fetch);
    const out = await call("video.upscale", { artifact_id: "vid1" }, ctx);
    expect(submitted(fetch)).toMatchObject({ upscale_factor: 2, upscale_mode: "factor" });
    expect(out.artifacts[0]?.mime).toBe("video/mp4");
  });

  it("video.lipsync sends video and audio, and refuses a still image", async () => {
    const model = "fal-ai/sync-lipsync/v2";
    const fetch = queue(model, { video: file("ls.mp4", "video/mp4") });
    const { ctx } = await setup(fetch);
    const out = await call("video.lipsync", { artifact_id: "vid1", audio_id: "aud1" }, ctx);
    const body = submitted(fetch);
    expect(body.video_url).toMatch(/^data:video\/mp4/);
    expect(body.audio_url).toMatch(/^data:audio\/mpeg/);
    expect(out).toMatchObject({ model });
    expect(await refusal("video.lipsync", { artifact_id: "img1", audio_id: "aud1" })).toMatchObject(
      UNSUPPORTED,
    );
  });

  it("a finished job without the expected file fails without retry", async () => {
    const fetch = queue("fal-ai/sync-lipsync/v2", { video: null });
    const { ctx } = await setup(fetch);
    const err = (await find("video.lipsync")
      .run({ artifact_id: "vid1", audio_id: "aud1" }, ctx)
      .catch((e: unknown) => e)) as { name?: string; retryable?: boolean };
    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe("CapabilityError");
    expect(err.retryable).not.toBe(true);
  });

  it("audio.separate_stems tags each artifact with its stem", async () => {
    const model = "fal-ai/demucs";
    const fetch = queue(model, {
      vocals: file("vocals.mp3", "audio/mpeg"),
      drums: file("drums.mp3", "audio/mpeg"),
      bass: null,
      other: file("other.mp3", "audio/mpeg"),
      guitar: null,
      piano: null,
    });
    const { ctx } = await setup(fetch);
    const out = await call("audio.separate_stems", { artifact_id: "aud1", format: "mp3" }, ctx);
    expect(submitted(fetch)).toMatchObject({ output_format: "mp3" });
    expect(out.artifacts.map((a) => a.stem).sort()).toEqual(["drums", "other", "vocals"]);
  });

  it("audio.separate_stems refuses two_stems, which demucs on fal cannot do", async () => {
    expect(
      await refusal("audio.separate_stems", { artifact_id: "aud1", two_stems: "vocals" }),
    ).toMatchObject(UNSUPPORTED);
  });

  it("3d.generate picks text- or image-to-3D and returns the requested format", async () => {
    const text = "fal-ai/hunyuan-3d/v3.1/pro/text-to-3d";
    const result = {
      model_glb: file("m.glb", "model/gltf-binary"),
      model_urls: { glb: file("m2.glb", "model/gltf-binary"), obj: file("m.obj", "model/obj") },
      thumbnail: file("t.png", "image/png"),
      seed: 1,
    };
    const fetch = queue(text, result);
    const { ctx } = await setup(fetch);
    const out = await call("3d.generate", { prompt: "a teapot" }, ctx);
    expect(submitted(fetch)).toEqual({ prompt: "a teapot" });
    expect(out).toMatchObject({ provider: "fal", model: text });
    expect(out.artifacts).toHaveLength(1);

    const image = "fal-ai/hunyuan-3d/v3.1/pro/image-to-3d";
    const fetch2 = queue(image, result);
    const s2 = await setup(fetch2);
    const out2 = await call("3d.generate", { artifact_id: "img1" }, s2.ctx);
    expect(submitted(fetch2).input_image_url).toMatch(/^data:image\/png/);
    expect(out2.model).toBe(image);
  });

  it("3d.generate refuses an empty request and an image model given a prompt", async () => {
    const empty = await refusal("3d.generate", {});
    expect(empty).toMatchObject({
      name: "CapabilityError",
      retryable: true,
      code: "INVALID_INPUT",
    });
    expect(await refusal("3d.generate", { prompt: "x", artifact_id: "img1" })).toMatchObject(
      UNSUPPORTED,
    );
  });

  it("sound.effect maps prompt, duration and mp3 onto the ElevenLabs model", async () => {
    const model = "fal-ai/elevenlabs/sound-effects/v2";
    const fetch = queue(model, { audio: file("fx.mp3", "audio/mpeg") });
    const { ctx } = await setup(fetch);
    const out = await call(
      "sound.effect",
      { prompt: "a door creaks", duration_seconds: 3, format: "mp3" },
      ctx,
    );
    expect(submitted(fetch)).toEqual({
      text: "a door creaks",
      duration_seconds: 3,
      output_format: "mp3_44100_128",
    });
    expect(out.artifacts[0]?.mime).toBe("audio/mpeg");
  });

  it("sound.effect refuses wav on the ElevenLabs model", async () => {
    expect(await refusal("sound.effect", { prompt: "boom", format: "wav" })).toMatchObject(
      UNSUPPORTED,
    );
  });

  it("reads a spec whose operation is filed under an alias path", () => {
    const spec = parseSpec({
      endpoint_id: "fal-ai/x/text-to-3d",
      metadata: { display_name: "X", category: "text-to-3d", description: "", status: "active" },
      openapi: {
        paths: {
          "/fal-ai/x-alias/text-to-3d": {
            post: {
              requestBody: {
                content: {
                  "application/json": {
                    schema: { type: "object", properties: { prompt: { type: "string" } } },
                  },
                },
              },
            },
          },
          "/fal-ai/x-alias/text-to-3d/requests/{request_id}": {
            get: {
              responses: {
                "200": {
                  content: {
                    "application/json": {
                      schema: { type: "object", properties: { model_glb: { type: "object" } } },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    expect(spec?.input?.properties).toHaveProperty("prompt");
    expect(spec?.output?.properties).toHaveProperty("model_glb");
  });
});
