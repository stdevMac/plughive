import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackContext } from "plughive/pack";
import { describe, expect, it } from "vitest";
import { capabilities } from "../../../packs/openrouter/capabilities.js";
import {
  inputSchema,
  parseCatalog,
  parseGeneralRow,
  parseVideoJob,
} from "../../../packs/openrouter/client.js";
import { toZod } from "../../../packs/openrouter/common.js";
import pack from "../../../packs/openrouter/index.js";
import {
  type OpenRouterRuntime,
  seedCatalog,
  withLocalPatterns,
} from "../../../packs/openrouter/runtime.js";
import {
  bytesResponse,
  failure,
  findTool,
  loadPacksOffline,
  memLibrary,
  packTools,
  routerFetch,
  tempDir,
} from "../provider-support.js";
import { fakeCtx, jsonResponse, loadBuiltinPacks } from "../support.js";

const KEY = "sk-or-test-not-real";
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
const VIDEOS = fixture("videos_models.json");
const IMAGES = fixture("images_models.json");
const SPEECH = fixture("speech_models.json");
const SEARCH = fixture("models_search.json");
const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const API = "https://openrouter.ai/api/v1";

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

async function setup(opts: {
  fetch: PackContext["fetch"];
  secrets?: Record<string, string>;
  settings?: Record<string, unknown>;
  dir?: string;
}) {
  const lib = memLibrary();
  const base = fakeCtx({
    packId: "openrouter",
    dataDir: opts.dir ?? tempDir("plughive-openrouter-"),
    secrets: opts.secrets ?? {},
    settings: { models: "", ...opts.settings },
    fetch: opts.fetch,
    library: lib.library,
  });
  const { tools, ctx } = await packTools(pack, base);
  const rt = (ctx as PackContext & { openrouter: OpenRouterRuntime }).openrouter;
  rt.pollInitialMs = 1;
  const call = (extra: Partial<PackContext> = {}) =>
    ({ ...ctx, fetch: opts.fetch, ...extra }) as PackContext;
  return { tools, ctx, rt, lib, call };
}

function videoRoutes(statuses: string[], extra: Record<string, unknown> = {}) {
  let i = 0;
  return [
    ...catalogRoutes,
    {
      match: /^POST https:\/\/openrouter\.ai\/api\/v1\/videos$/,
      reply: () =>
        jsonResponse({ id: "vid_1", polling_url: `${API}/videos/vid_1`, status: "pending" }, 202),
    },
    {
      match: /^GET https:\/\/openrouter\.ai\/api\/v1\/videos\/vid_1$/,
      reply: () => {
        const status = statuses[Math.min(i++, statuses.length - 1)]!;
        return jsonResponse({
          id: "vid_1",
          status,
          progress: status === "completed" ? 100 : 40,
          ...(status === "completed"
            ? { unsigned_urls: [`${API}/videos/vid_1/content?index=0`], usage: { cost: 0.8 } }
            : {}),
          ...extra,
        });
      },
    },
    {
      match: /^GET https:\/\/openrouter\.ai\/api\/v1\/videos\/vid_1\/content\?index=0$/,
      reply: () => bytesResponse(MP4, "video/mp4"),
    },
  ];
}

describe("openrouter catalogs", () => {
  it("parses the video catalog into params", () => {
    const rows = parseCatalog("video", VIDEOS);
    expect(rows.map((r) => r.id)).toEqual([
      "heygen/heygen-avatar-6-turbo",
      "bytedance/seedance-2.5-flash",
      "google/veo-3.1-fast",
    ]);
    const veo = rows[2]!;
    expect(veo.params.duration).toEqual({ type: "enum", values: [4, 6, 8] });
    expect(veo.params.resolution).toEqual({ type: "enum", values: ["720p", "1080p", "4K"] });
    expect(veo.params.generate_audio).toEqual({ type: "boolean" });
    expect(veo.frame_images).toEqual(["first_frame", "last_frame"]);
    const seedance = rows[1]!;
    expect(seedance.auto_duration).toBe(true);
    expect((seedance.params.duration as { values: number[] }).values).not.toContain(-1);
    expect(rows[0]!.params.duration).toBeUndefined();
    expect(rows[0]!.params.seed).toBeUndefined();
  });

  it("parses image and speech catalogs and general rows", () => {
    const img = parseCatalog("image", IMAGES);
    expect(img[1]!.params.n).toEqual({ type: "range", min: 1, max: 10 });
    expect(img[1]!.params.output_format).toEqual({ type: "enum", values: ["png", "jpeg", "webp"] });
    const sp = parseCatalog("speech", SPEECH);
    expect(sp[0]!.id).toBe("elevenlabs/eleven-v3");
    expect(sp[0]!.kind).toBe("speech");
    const general = SEARCH.data.map(parseGeneralRow);
    expect(general.map((g: any) => g.kind)).toEqual(["image", "transcription"]);
  });

  it("drops rows with unsafe ids", () => {
    const rows = parseCatalog("video", {
      data: [{ id: "../etc/passwd" }, { id: "a/b?x=1" }, { id: "ok/model" }],
    });
    expect(rows.map((r) => r.id)).toEqual(["ok/model"]);
  });

  it("ships a snapshot with the default models", () => {
    expect(seedCatalog("video").some((e) => e.id === "google/veo-3.1-fast")).toBe(true);
    expect(seedCatalog("image").some((e) => e.id === "openai/gpt-image-2")).toBe(true);
    expect(seedCatalog("speech").some((e) => e.id === "elevenlabs/eleven-v3")).toBe(true);
  });

  it("parses video job states", () => {
    expect(parseVideoJob({ data: { id: "v", status: "in_progress", progress: 30 } })).toMatchObject(
      { id: "v", status: "in_progress", progress: 30 },
    );
  });
});

describe("openrouter schema synthesis", () => {
  it("builds an exact zod schema for a video model", () => {
    const veo = parseCatalog("video", VIDEOS)[2]!;
    const s = inputSchema(veo);
    const c = withLocalPatterns(toZod(s), s);
    expect(c.exact).toBe(true);
    expect(c.zod.safeParse({ prompt: "x", duration: 8, resolution: "1080p" }).success).toBe(true);
    expect(c.zod.safeParse({ prompt: "x", duration: 5 }).success).toBe(false);
    expect(c.zod.safeParse({ prompt: "x", resolution: "8K" }).success).toBe(false);
    expect(c.zod.safeParse({ prompt: "x", first_frame: "artifact:abc" }).success).toBe(true);
    expect(c.zod.safeParse({ prompt: "x", first_frame: "file:///etc/passwd" }).success).toBe(false);
    expect(c.zod.safeParse({ prompt: "x", bogus: 1 }).success).toBe(false);
    expect(c.zod.safeParse({}).success).toBe(false);
  });

  it("bounds image params and the number of references", () => {
    const banana = parseCatalog("image", IMAGES)[0]!;
    const c = toZod(inputSchema(banana));
    expect(c.zod.safeParse({ prompt: "x", n: 2 }).success).toBe(false);
    expect(c.zod.safeParse({ prompt: "x", resolution: "2K", aspect_ratio: "21:9" }).success).toBe(
      true,
    );
    const refs = Array.from({ length: 15 }, (_, i) => `artifact:a${i}`);
    expect(c.zod.safeParse({ prompt: "x", input_references: refs }).success).toBe(false);
    const gpt = toZod(inputSchema(parseCatalog("image", IMAGES)[1]!));
    expect(gpt.zod.safeParse({ prompt: "x", n: 3, output_compression: 80 }).success).toBe(true);
    expect(gpt.zod.safeParse({ prompt: "x", n: 1.5 }).success).toBe(false);
  });
});

describe("openrouter_search_models and describe", () => {
  it("filters a media catalog without a key and caches it", async () => {
    const fetch = routerFetch(catalogRoutes);
    const { tools, call } = await setup({ fetch });
    const search = findTool(tools, "openrouter_search_models");
    const r = (await search.run(
      search.input.parse({ query: "veo", modality: "video" }),
      call(),
    )) as any;
    expect(r.source).toBe("live");
    expect(r.models.map((m: any) => m.id)).toEqual(["google/veo-3.1-fast"]);
    const again = (await search.run(search.input.parse({ modality: "video" }), call())) as any;
    expect(again.source).toBe("cache");
    expect(again.total).toBe(3);
    expect(fetch.calls).toHaveLength(1);
    expect(fetch.calls[0]!.headers.authorization).toBeUndefined();
  });

  it("falls back to the snapshot when the catalog is unreachable", async () => {
    const fetch = routerFetch([]);
    const { tools, call } = await setup({ fetch });
    const search = findTool(tools, "openrouter_search_models");
    const r = (await search.run(
      search.input.parse({ query: "veo", modality: "video" }),
      call(),
    )) as any;
    expect(r.source).toBe("snapshot");
    expect(r.models.some((m: any) => m.id === "google/veo-3.1-fast")).toBe(true);
    // O5: the snapshot fallback is labelled with its date.
    expect(r.source_note).toMatch(/snapshot dated 2026-11-24/);
  });

  it("describe refetches the catalog even when search cached it", async () => {
    const fetch = routerFetch(catalogRoutes);
    const { tools, call } = await setup({ fetch });
    const search = findTool(tools, "openrouter_search_models");
    await search.run(search.input.parse({ modality: "video" }), call());
    const d = findTool(tools, "openrouter_describe_model");
    const r = (await d.run(d.input.parse({ model: "google/veo-3.1-fast" }), call())) as any;
    expect(r.source).toBe("live");
    expect(fetch.calls.filter((c) => c.url.endsWith("/videos/models"))).toHaveLength(2);
  });

  it("searches the main list for transcription models", async () => {
    const fetch = routerFetch([
      {
        match: /^GET https:\/\/openrouter\.ai\/api\/v1\/models\?/,
        reply: () => jsonResponse(SEARCH),
      },
    ]);
    const { tools, call } = await setup({ fetch });
    const search = findTool(tools, "openrouter_search_models");
    const r = (await search.run(
      search.input.parse({ query: "grok", modality: "transcription" }),
      call(),
    )) as any;
    expect(r.models.map((m: any) => m.kind)).toContain("transcription");
    const url = new URL(fetch.calls[0]!.url);
    expect(url.searchParams.get("output_modalities")).toBe("transcription");
    expect(url.searchParams.get("q")).toBe("grok");
  });

  it("describes a model with its schema, pricing and an example call", async () => {
    const fetch = routerFetch(catalogRoutes);
    const { tools, call } = await setup({ fetch, settings: { models: "google/veo-3.1-fast" } });
    const d = findTool(tools, "openrouter_describe_model");
    const r = (await d.run(d.input.parse({ model: "google/veo-3.1-fast" }), call())) as any;
    expect(r.kind).toBe("video");
    expect(r.pricing.duration_seconds_with_audio).toBe("0.12");
    expect(r.input_schema.properties.duration.enum).toEqual([4, 6, 8]);
    expect(r.example_call.tool).toBe("openrouter_run");
    expect(r.example_call.arguments.input.prompt).toBeTypeOf("string");
    expect(r.per_model_tool).toBe("openrouter_google_veo_3_1_fast");
    expect(r.provider_passthrough_parameters).toContain("negativePrompt");
  });

  it("names per_model_tool only when that tool is registered", async () => {
    const fetch = routerFetch(catalogRoutes);
    const { tools, call } = await setup({ fetch });
    const d = findTool(tools, "openrouter_describe_model");
    const r = (await d.run(d.input.parse({ model: "google/veo-3.1-fast" }), call())) as any;
    expect(r.per_model_tool).toBeNull();
    expect(tools.map((t) => t.name)).not.toContain("openrouter_google_veo_3_1_fast");
  });
});

describe("openrouter_run", () => {
  it("validates before any network call and rejects bad model ids", async () => {
    const fetch = routerFetch(videoRoutes(["completed"]));
    const { tools, call } = await setup({
      fetch,
      secrets: { OPENROUTER_API_KEY: KEY },
      settings: { models: "google/veo-3.1-fast" },
    });
    const run = findTool(tools, "openrouter_run");
    await expect(
      run.run(
        run.input.parse({ model: "google/veo-3.1-fast", input: { prompt: "x", duration: 5 } }),
        call(),
      ),
    ).rejects.toThrow(/duration/);
    expect(() => run.input.parse({ model: "../../etc", input: {} })).toThrow();
    expect(fetch.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("submits a video, polls, downloads into the library with the key only for openrouter.ai", async () => {
    const fetch = routerFetch(videoRoutes(["pending", "in_progress", "completed"]));
    const { tools, call, lib } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    lib.put("frame1", "image/png", PNG);
    const progress: number[] = [];
    const run = findTool(tools, "openrouter_run");
    const r = (await run.run(
      run.input.parse({
        model: "google/veo-3.1-fast",
        input: { prompt: "a fox", duration: 8, resolution: "720p", first_frame: "artifact:frame1" },
      }),
      call({ progress: (f: number) => void progress.push(f) }),
    )) as any;
    expect(r.provider).toBe("openrouter");
    expect(r.cost_usd).toBe(0.8);
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0].mime).toBe("video/mp4");
    expect(lib.saved[0]!.kind).toBe("video");
    expect(JSON.stringify(r)).not.toContain("openrouter.ai");
    expect(JSON.stringify(r)).not.toContain(KEY);
    const post = fetch.calls.find((c) => c.method === "POST")!;
    const body = JSON.parse(post.body!);
    expect(body).toMatchObject({
      model: "google/veo-3.1-fast",
      prompt: "a fox",
      duration: 8,
      resolution: "720p",
    });
    expect(body.frame_images[0].frame_type).toBe("first_frame");
    expect(body.frame_images[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(body.first_frame).toBeUndefined();
    const download = fetch.calls.find((c) => c.url.includes("/content"))!;
    expect(download.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(progress.length).toBeGreaterThan(1);
  });

  it("reports that OpenRouter cannot cancel when the call is aborted", async () => {
    const ac = new AbortController();
    const fetch = routerFetch(videoRoutes(["in_progress"]));
    const { tools, call } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    const run = findTool(tools, "openrouter_run");
    const p = run.run(
      run.input.parse({ model: "google/veo-3.1-fast", input: { prompt: "x" } }),
      // Abort once the job is submitted and polling has begun.
      call({ signal: ac.signal, progress: (f: number) => void (f > 0.02 && ac.abort()) }),
    );
    await expect(p).rejects.toThrow(/has no cancel endpoint.*vid_1.*openrouter_video_result/);
    expect(fetch.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  });

  it("surfaces a failed job", async () => {
    const fetch = routerFetch(videoRoutes(["failed"], { error: "content policy" }));
    const { tools, call } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    const run = findTool(tools, "openrouter_run");
    await expect(
      run.run(run.input.parse({ model: "google/veo-3.1-fast", input: { prompt: "x" } }), call()),
    ).rejects.toThrow(/failed on OpenRouter: content policy/);
  });

  it("saves base64 images and never returns a provider URL", async () => {
    const b64 = Buffer.from(PNG).toString("base64");
    const fetch = routerFetch([
      ...catalogRoutes,
      {
        match: /^POST https:\/\/openrouter\.ai\/api\/v1\/images$/,
        reply: () =>
          jsonResponse({
            data: [
              { b64_json: b64, media_type: "image/png" },
              { b64_json: b64, media_type: "image/png" },
            ],
            usage: { cost: 0.04 },
          }),
      },
    ]);
    const { tools, call, lib } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    const run = findTool(tools, "openrouter_run");
    const r = (await run.run(
      run.input.parse({ model: "openai/gpt-image-2", input: { prompt: "x", n: 2 } }),
      call(),
    )) as any;
    expect(r.artifacts).toHaveLength(2);
    expect(r.cost_usd).toBe(0.04);
    expect(Buffer.from(lib.saved[0]!.bytes).equals(Buffer.from(PNG))).toBe(true);
    expect(JSON.stringify(r.output)).not.toContain(b64);
    const body = JSON.parse(fetch.calls.find((c) => c.method === "POST")!.body!);
    expect(body.response_format).toBe("b64_json");
  });

  it("saves speech audio", async () => {
    const fetch = routerFetch([
      ...catalogRoutes,
      {
        match: /^POST https:\/\/openrouter\.ai\/api\/v1\/audio\/speech$/,
        reply: () => bytesResponse(new Uint8Array([0xff, 0xfb, 1]), "audio/mpeg"),
      },
    ]);
    const { call, lib } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    const r = await capabilities["speech.generate"]({ text: "hello" }, call());
    expect(r.artifacts[0]!.mime).toBe("audio/mpeg");
    expect(lib.saved[0]!.mime).toBe("audio/mpeg");
    const body = JSON.parse(fetch.calls.find((c) => c.method === "POST")!.body!);
    expect(body).toMatchObject({ model: "elevenlabs/eleven-v3", input: "hello" });
  });

  it("transcribes a library file", async () => {
    const fetch = routerFetch([
      ...catalogRoutes,
      {
        match: /^GET https:\/\/openrouter\.ai\/api\/v1\/models\?/,
        reply: () => jsonResponse(SEARCH),
      },
      {
        match: /^POST https:\/\/openrouter\.ai\/api\/v1\/audio\/transcriptions$/,
        reply: () => jsonResponse({ text: " hi there ", usage: { cost: 0.001 } }),
      },
    ]);
    const { call, lib } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    lib.put("aud1", "audio/mpeg", new Uint8Array([1, 2, 3]));
    const r = await capabilities["audio.transcribe"](
      { artifact_id: "aud1", model: "x-ai/grok-stt-2.0" },
      call(),
    );
    expect(r.text).toBe("hi there");
    const body = JSON.parse(fetch.calls.find((c) => c.method === "POST")!.body!);
    expect(body.input_audio).toEqual({
      data: Buffer.from([1, 2, 3]).toString("base64"),
      format: "mp3",
    });
  });
});

describe("openrouter capabilities", () => {
  it("image.generate rejects unsupported fields before any POST", async () => {
    const fetch = routerFetch(catalogRoutes);
    const { call } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    await expect(capabilities["image.generate"]({ prompt: "x", n: 3 }, call())).rejects.toThrow(
      /between 1 and 1/,
    );
    await expect(capabilities["image.generate"]({ prompt: "x", seed: 1 }, call())).rejects.toThrow(
      /does not support seed/,
    );
    await expect(
      capabilities["image.generate"]({ prompt: "x", aspect_ratio: "7:3" }, call()),
    ).rejects.toThrow(/use one of/);
    expect(fetch.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("video.generate snaps the duration and maps the start image", async () => {
    const fetch = routerFetch(videoRoutes(["completed"]));
    const { call, lib } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    lib.put("img1", "image/png", PNG);
    const r = await capabilities["video.generate"](
      { prompt: "x", duration_seconds: 7, image_input: "img1" },
      call(),
    );
    expect(r.artifacts).toHaveLength(1);
    const body = JSON.parse(fetch.calls.find((c) => c.method === "POST")!.body!);
    expect(body.duration).toBe(6);
    expect(body.frame_images).toHaveLength(1);
  });

  it("chat returns text, usage and cost", async () => {
    const fetch = routerFetch([
      {
        match: /^POST https:\/\/openrouter\.ai\/api\/v1\/chat\/completions$/,
        reply: () =>
          jsonResponse({
            model: "minimax/minimax-m2.7",
            choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
            usage: { total_tokens: 3, cost: 0.0001 },
          }),
      },
    ]);
    const { call } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    const r = await capabilities.chat(
      { messages: [{ role: "user", content: "hello" }], json: true },
      call(),
    );
    expect(r).toMatchObject({ text: "hi", model: "minimax/minimax-m2.7", cost_usd: 0.0001 });
    const req = fetch.calls[0]!;
    expect(JSON.parse(req.body!).response_format).toEqual({ type: "json_object" });
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
  });
});

describe("openrouter_chat", () => {
  it("keeps the legacy output shape, inlines artifacts and hides the raw response by default", async () => {
    const fetch = routerFetch([
      {
        match: /^POST https:\/\/openrouter\.ai\/api\/v1\/chat\/completions$/,
        reply: () =>
          jsonResponse({
            model: "openai/gpt-5",
            choices: [
              {
                message: { content: [{ type: "text", text: "a cat" }], tool_calls: [{ id: "t1" }] },
                finish_reason: "tool_calls",
              },
            ],
            usage: { total_tokens: 9, cost: 0.002 },
          }),
      },
    ]);
    const { tools, call, lib } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    lib.put("pic", "image/png", PNG);
    const chat = findTool(tools, "openrouter_chat");
    const r = (await chat.run(
      chat.input.parse({
        model: "openai/gpt-5",
        messages: [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: "artifact:pic" } },
              { type: "text", text: "what?" },
            ],
          },
        ],
        save_artifact: true,
      }),
      call(),
    )) as any;
    expect(r).toMatchObject({
      model: "openai/gpt-5",
      text: "a cat",
      finish_reason: "tool_calls",
      cost_usd: 0.002,
    });
    expect(r.tool_calls).toEqual([{ id: "t1" }]);
    expect(r.raw).toBeUndefined();
    expect(r.artifact.mime).toBe("application/json");
    const sent = JSON.parse(fetch.calls[0]!.body!);
    expect(sent.messages[0].content[0].image_url.url).toMatch(/^data:image\/png;base64,/);
    expect(sent.save_artifact).toBeUndefined();
    expect(sent.include_raw).toBeUndefined();
  });

  it("uses the chat_model setting and accepts variant ids", async () => {
    const fetch = routerFetch([
      {
        match: /chat\/completions$/,
        reply: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
      },
    ]);
    const { tools, call } = await setup({
      fetch,
      secrets: { OPENROUTER_API_KEY: KEY },
      settings: { chat_model: "meta-llama/llama-3.3-70b-instruct:free" },
    });
    const chat = findTool(tools, "openrouter_chat");
    await chat.run(chat.input.parse({ messages: [{ role: "user", content: "x" }] }), call());
    expect(JSON.parse(fetch.calls[0]!.body!).model).toBe("meta-llama/llama-3.3-70b-instruct:free");
    expect(() =>
      chat.input.parse({ model: "a/b?c", messages: [{ role: "user", content: "x" }] }),
    ).toThrow();
  });

  it("refuses https URLs in message parts unless allow_url_inputs is on", async () => {
    const fetch = routerFetch([
      {
        match: /chat\/completions$/,
        reply: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
      },
    ]);
    const args = {
      model: "openai/gpt-5",
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: "https://evil.test/p.png?sig=1" } },
            { type: "text", text: "what?" },
          ],
        },
      ],
    } as const;
    const off = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    const chat = findTool(off.tools, "openrouter_chat");
    await expect(chat.run(chat.input.parse(args), off.call())).rejects.toThrow(
      /URL inputs are off/,
    );
    expect(fetch.calls).toHaveLength(0);
    // Plain message text may still mention a URL.
    await chat.run(
      chat.input.parse({
        model: "openai/gpt-5",
        messages: [{ role: "user", content: "look at https://example.com/x" }],
      }),
      off.call(),
    );
    expect(fetch.calls).toHaveLength(1);

    const on = await setup({
      fetch,
      secrets: { OPENROUTER_API_KEY: KEY },
      settings: { allow_url_inputs: true },
    });
    const chat2 = findTool(on.tools, "openrouter_chat");
    await chat2.run(chat2.input.parse(args), on.call());
    const sent = JSON.parse(fetch.calls[1]!.body!);
    expect(sent.messages[0].content[0].image_url.url).toBe("https://evil.test/p.png?sig=1");
  });

  it("turns a 402 into an actionable error without the key", async () => {
    const fetch = routerFetch([
      {
        match: /chat\/completions$/,
        reply: () => jsonResponse({ error: { message: "Insufficient credits" } }, 402),
      },
    ]);
    const { tools, call } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    const chat = findTool(tools, "openrouter_chat");
    const err = await failure(
      chat.run(chat.input.parse({ messages: [{ role: "user", content: "x" }] }), call()),
    );
    expect(String(err.message)).toMatch(/credits/i);
    expect(String(err.message)).not.toContain(KEY);
  });
});

describe("openrouter generated tools", () => {
  it("builds typed tools from the snapshot with no network", async () => {
    const fetch = routerFetch([]);
    const ctx = fakeCtx({
      packId: "openrouter",
      dataDir: tempDir("plughive-openrouter-"),
      settings: { models: "google/veo-3.1-fast, openai/gpt-image-2, not a model, nobody/unknown" },
      fetch,
      library: memLibrary().library,
    });
    const { tools } = await packTools(pack, ctx);
    const names = tools.map((t) => t.name);
    expect(names).toContain("openrouter_google_veo_3_1_fast");
    expect(names).toContain("openrouter_openai_gpt_image_2");
    expect(names).toContain("openrouter_chat");
    expect(fetch.calls).toHaveLength(0);
    for (const n of names) {
      expect(n).toMatch(/^openrouter_[a-z0-9_]+$/);
      expect(n).not.toContain("__");
      expect(n.length).toBeLessThanOrEqual(64);
    }
    const veo = findTool(tools, "openrouter_google_veo_3_1_fast");
    expect(veo.input.safeParse({ prompt: "x", duration: 8 }).success).toBe(true);
    expect(veo.input.safeParse({ prompt: "x", duration: 9 }).success).toBe(false);
  });
});

const runVeo = async (
  tools: any[],
  call: () => PackContext,
  input: Record<string, unknown> = { prompt: "x" },
) => {
  const run = findTool(tools, "openrouter_run");
  return run.run(run.input.parse({ model: "google/veo-3.1-fast", input }), call());
};

describe("openrouter video jobs (O1)", () => {
  it("quotes the job id and openrouter_video_result when contact is lost", async () => {
    const fetch = routerFetch([
      ...catalogRoutes,
      {
        match: /^POST https:\/\/openrouter\.ai\/api\/v1\/videos$/,
        reply: () => jsonResponse({ id: "vid_1", status: "pending" }, 202),
      },
      {
        match: /^GET https:\/\/openrouter\.ai\/api\/v1\/videos\/vid_1$/,
        reply: () => jsonResponse({ error: "boom" }, 500),
      },
    ]);
    const { tools, call, rt } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    rt.pollInitialMs = 1;
    const err = await failure(runVeo(tools, () => call()));
    expect(String(err.message)).toMatch(/vid_1/);
    expect(String(err.message)).toMatch(/openrouter_video_result/);
    expect(fetch.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  }, 30_000);

  it("quotes the recover hint when the finished video cannot be downloaded", async () => {
    const routes = videoRoutes(["completed"]);
    routes[routes.length - 1] = {
      match: /\/videos\/vid_1\/content/,
      reply: () => jsonResponse({ error: "gone" }, 404),
    };
    const fetch = routerFetch(routes);
    const { tools, call } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    await expect(runVeo(tools, () => call())).rejects.toThrow(
      /openrouter_video_result with \{"job_id":"vid_1"\}/,
    );
  });

  it("openrouter_video_result collects a finished job without submitting", async () => {
    const fetch = routerFetch(videoRoutes(["completed"]));
    const { tools, call, lib } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    const t = findTool(tools, "openrouter_video_result");
    expect(t.annotations?.idempotentHint).toBe(true);
    const r = (await t.run(t.input.parse({ job_id: "vid_1" }), call())) as any;
    expect(r.artifacts).toHaveLength(1);
    expect(lib.saved[0]!.mime).toBe("video/mp4");
    expect(fetch.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("openrouter_video_result reports a running job, a failed job and a bad id", async () => {
    const running = routerFetch(videoRoutes(["in_progress"]));
    const a = await setup({ fetch: running, secrets: { OPENROUTER_API_KEY: KEY } });
    const t = findTool(a.tools, "openrouter_video_result");
    const r = (await t.run(t.input.parse({ job_id: "vid_1" }), a.call())) as any;
    expect(r).toMatchObject({ status: "in_progress", job_id: "vid_1" });
    expect(r.message).toMatch(/again later/);

    const failed = routerFetch(videoRoutes(["failed"], { error: "content policy" }));
    const b = await setup({ fetch: failed, secrets: { OPENROUTER_API_KEY: KEY } });
    await expect(t.run(t.input.parse({ job_id: "vid_1" }), b.call())).rejects.toThrow(
      /vid_1.*failed on OpenRouter: content policy/,
    );

    await expect(t.run(t.input.parse({ job_id: "../vid_1" }), a.call())).rejects.toThrow(
      /not an OpenRouter video job id/,
    );
    expect(running.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("openrouter file inputs and outputs (O2, O3)", () => {
  it("refuses image links instead of downloading them from any host", async () => {
    const fetch = routerFetch([
      ...catalogRoutes,
      {
        match: /^POST https:\/\/openrouter\.ai\/api\/v1\/images$/,
        reply: () => jsonResponse({ data: [{ url: "https://evil.example/x.png" }] }),
      },
    ]);
    const { tools, call, lib } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    const run = findTool(tools, "openrouter_run");
    await expect(
      run.run(run.input.parse({ model: "openai/gpt-image-2", input: { prompt: "x" } }), call()),
    ).rejects.toThrow(/image link.*billed/);
    expect(fetch.calls.some((c) => c.url.includes("evil.example"))).toBe(false);
    expect(lib.saved).toHaveLength(0);
  });

  it("forwards https file inputs only with allow_url_inputs", async () => {
    const off = routerFetch(videoRoutes(["completed"]));
    const a = await setup({ fetch: off, secrets: { OPENROUTER_API_KEY: KEY } });
    await expect(
      runVeo(a.tools, () => a.call(), {
        prompt: "x",
        first_frame: "https://example.com/a.png?sig=1",
      }),
    ).rejects.toThrow(/URL file inputs are off/);
    expect(off.calls.filter((c) => c.method === "POST")).toHaveLength(0);

    const on = routerFetch(videoRoutes(["completed"]));
    const b = await setup({
      fetch: on,
      secrets: { OPENROUTER_API_KEY: KEY },
      settings: { allow_url_inputs: true },
    });
    await runVeo(b.tools, () => b.call(), {
      prompt: "x",
      first_frame: "https://example.com/a.png",
    });
    const body = JSON.parse(on.calls.find((c) => c.method === "POST")!.body!);
    expect(body.frame_images[0].image_url.url).toBe("https://example.com/a.png");
  });

  it("rejects non-https file refs even though toZod drops patterns", async () => {
    const veo = parseCatalog("video", VIDEOS)[2]!;
    const s = inputSchema(veo);
    expect(toZod(s).zod.safeParse({ prompt: "x", first_frame: "file:///etc/passwd" }).success).toBe(
      true,
    );
    expect(
      withLocalPatterns(toZod(s), s).zod.safeParse({ prompt: "x", first_frame: "http://x" })
        .success,
    ).toBe(false);
  });
});

describe("openrouter chat limits (O4)", () => {
  const chatRoutes = () =>
    routerFetch([
      {
        match: /chat\/completions$/,
        reply: () => jsonResponse({ choices: [{ message: { content: "ok" } }] }),
      },
    ]);
  const msgs = [{ role: "user", content: "x" }];

  it("refuses max_tokens over the ceiling before any POST, and the setting raises it", async () => {
    const fetch = chatRoutes();
    const a = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    const chat = findTool(a.tools, "openrouter_chat");
    await expect(
      chat.run(chat.input.parse({ messages: msgs, max_tokens: 40_000 }), a.call()),
    ).rejects.toThrow(/max_chat_tokens/);
    expect(fetch.calls).toHaveLength(0);
    const b = await setup({
      fetch,
      secrets: { OPENROUTER_API_KEY: KEY },
      settings: { max_chat_tokens: 50_000 },
    });
    await chat.run(chat.input.parse({ messages: msgs, max_tokens: 40_000 }), b.call());
    expect(fetch.calls).toHaveLength(1);
  });

  it("bounds messages, the body size and pass-through objects", async () => {
    const fetch = chatRoutes();
    const { tools, call, rt } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    const chat = findTool(tools, "openrouter_chat");
    expect(chat.longRunning).toBe(true);
    expect(
      chat.input.safeParse({ messages: Array.from({ length: 201 }, () => msgs[0]) }).success,
    ).toBe(false);
    expect(
      chat.input.safeParse({ messages: msgs, reasoning: { effort: "high", budget: 1 } }).success,
    ).toBe(false);
    expect(chat.input.safeParse({ messages: msgs, reasoning: { effort: "high" } }).success).toBe(
      true,
    );
    const tool = (name: string) => ({
      type: "function",
      function: { name, parameters: { type: "object" } },
    });
    expect(chat.input.safeParse({ messages: msgs, tools: [tool("bad name!")] }).success).toBe(
      false,
    );
    expect(chat.input.safeParse({ messages: msgs, tools: [tool("get_weather")] }).success).toBe(
      true,
    );
    expect(
      chat.input.safeParse({
        messages: msgs,
        provider: { order: ["a"], extra: "x".repeat(20_000) },
      }).success,
    ).toBe(false);
    const huge = {
      model: "a/b",
      messages: [{ role: "user", content: "x".repeat(9 * 1024 * 1024) }],
    };
    await expect(rt.chat(call(), huge)).rejects.toThrow(/MB/);
    expect(fetch.calls).toHaveLength(0);
  });

  it("gives long calls a 15 minute timeout", async () => {
    let seen: unknown;
    const fetch = routerFetch([
      {
        match: /chat\/completions$/,
        reply: ({ init }: { init?: RequestInit }) => {
          seen = (init as RequestInit & { timeoutMs?: number })?.timeoutMs;
          return jsonResponse({ choices: [{ message: { content: "ok" } }] });
        },
      },
    ]);
    const { tools, call } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    const chat = findTool(tools, "openrouter_chat");
    await chat.run(chat.input.parse({ messages: msgs }), call());
    expect(seen).toBe(15 * 60_000);
  });
});

describe("openrouter low findings (O5)", () => {
  it("saves pcm speech as audio/pcm whatever the header says", async () => {
    const fetch = routerFetch([
      ...catalogRoutes,
      {
        match: /audio\/speech$/,
        reply: () => bytesResponse(new Uint8Array([1, 2, 3, 4]), "audio/mpeg"),
      },
    ]);
    const { call, lib } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    const r = await capabilities["speech.generate"]({ text: "hi", format: "pcm" }, call());
    expect(r.artifacts[0]!.mime).toBe("audio/pcm");
    expect(lib.saved[0]!.mime).toBe("audio/pcm");
    expect(lib.saved[0]!.kind).toBe("audio");
  });

  it("accepts a free-form voice for a model whose catalog lists none", async () => {
    const speech = structuredClone(SPEECH);
    speech.data[0].id = "acme/tts-1";
    delete speech.data[0].output_modalities[0].supported_parameters.voice;
    const entry = parseCatalog("speech", speech)[0]!;
    expect(entry.params.voice).toBeUndefined();
    const s = inputSchema(entry);
    const c = withLocalPatterns(toZod(s), s);
    expect(c.zod.safeParse({ input: "hi", voice: "custom-voice_1" }).success).toBe(true);
    expect(c.zod.safeParse({ input: "hi", voice: "bad voice\n" }).success).toBe(false);
    const fetch = routerFetch([
      { match: /videos\/models$/, reply: () => jsonResponse(VIDEOS) },
      { match: /images\/models$/, reply: () => jsonResponse(IMAGES) },
      { match: /audio\/speech\/models$/, reply: () => jsonResponse(speech) },
      {
        match: /^POST .*audio\/speech$/,
        reply: () => bytesResponse(new Uint8Array([0xff, 0xfb, 1]), "audio/mpeg"),
      },
    ]);
    const { call } = await setup({ fetch, secrets: { OPENROUTER_API_KEY: KEY } });
    await capabilities["speech.generate"](
      { text: "hi", voice: "custom-voice_1", model: "acme/tts-1" },
      call(),
    );
    expect(JSON.parse(fetch.calls.find((c) => c.method === "POST")!.body!).voice).toBe(
      "custom-voice_1",
    );
  });

  it("marks run tools non-destructive and labels the provider description", async () => {
    const fetch = routerFetch(catalogRoutes);
    const { tools } = await setup({ fetch, settings: { models: "google/veo-3.1-fast" } });
    for (const n of [
      "openrouter_run",
      "openrouter_chat",
      "openrouter_generate_video",
      "openrouter_google_veo_3_1_fast",
    ]) {
      expect(findTool(tools, n).annotations?.destructiveHint).toBe(false);
    }
    expect(findTool(tools, "openrouter_google_veo_3_1_fast").description).toMatch(
      /Model provider's description:/,
    );
  });
});

describe("openrouter through the loader", () => {
  it("lists its tools, searches without a key and reports a missing key", async () => {
    const h = await loadBuiltinPacks();
    try {
      const names = h.registry.list().map((t: { name: string }) => t.name);
      for (const n of [
        "openrouter_chat",
        "openrouter_search_models",
        "openrouter_run",
        "openrouter_generate_video",
      ])
        expect(names).toContain(n);
      const r = await h.registry.call("openrouter_chat", {
        messages: [{ role: "user", content: "hi" }],
      });
      expect(r).toMatchObject({
        ok: false,
        error: { code: "MISSING_SECRET", pack: "openrouter", secret: "OPENROUTER_API_KEY" },
      });
    } finally {
      await h.close();
    }
  });

  it("starts offline with the default model tools from the snapshot", async () => {
    const h = await loadPacksOffline();
    try {
      const names = h.registry
        .list()
        .map((t: { name: string }) => t.name)
        .filter((n: string) => n.startsWith("openrouter_"));
      expect(names).toContain("openrouter_chat");
      expect(names).toContain("openrouter_google_veo_3_1_fast");
      expect(names).toContain("openrouter_elevenlabs_eleven_v3");
      expect(h.loadMs).toBeLessThan(8000);
    } finally {
      await h.close();
    }
  });
});
