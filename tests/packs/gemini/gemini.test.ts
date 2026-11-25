import { beforeEach, describe, expect, it, vi } from "vitest";
import * as caps from "../../../packs/gemini/capabilities.js";
import geminiPack from "../../../packs/gemini/index.js";
import { clearModelCache } from "../../../packs/gemini/ops.js";
import { pcmToWav } from "../../../packs/gemini/util.js";
import { failure } from "../provider-support.js";
import { fakeCtx, jsonResponse, loadBuiltinPacks, toolNames, toolOf } from "../support.js";

const KEY = "AIzaTESTKEY0123456789abcdefghijk";
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

type Handler = (call: Call) => Response | Promise<Response>;

function setup(
  handler: Handler,
  opts: {
    signal?: AbortSignal;
    artifacts?: Record<string, { mime: string; bytes: Uint8Array }>;
  } = {},
) {
  const calls: Call[] = [];
  const saved: Record<string, unknown>[] = [];
  const progress: [number, string | undefined][] = [];
  const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    };
    calls.push(call);
    return handler(call);
  });
  const arts = opts.artifacts ?? {};
  const ctx = {
    ...fakeCtx({
      packId: "gemini",
      secrets: { GEMINI_API_KEY: KEY },
      fetch: fetchFn as never,
      library: {
        get: (async (id: string) => {
          const a = arts[id];
          return a ? { id, mime: a.mime, bytes: a.bytes.length } : null;
        }) as never,
        read: (async (id: string) => arts[id]?.bytes) as never,
        save: (async (input: Record<string, unknown>) => {
          saved.push(input);
          return {
            id: `art_${saved.length}`,
            path: "/x",
            url: `http://127.0.0.1:7777/a/art_${saved.length}`,
            mime: input.mime,
          };
        }) as never,
      },
    }),
    progress: (f: number, m?: string) => progress.push([f, m]),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  return { ctx: ctx as never, calls, saved, progress, fetchFn };
}

const interaction = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "int_1",
  status: "completed",
  model: "m",
  steps: [{ type: "model_output", content }],
  usage: { total_input_tokens: 10, total_output_tokens: 1120 },
  ...extra,
});

beforeEach(() => clearModelCache());

describe("manifest and registration", () => {
  it("exposes the expected tools with unique snake_case names", () => {
    const names = toolNames(geminiPack);
    expect(names).toEqual([
      "gemini_list_models",
      "gemini_generate_image",
      "gemini_generate_video",
      "gemini_generate_speech",
      "gemini_generate_music",
      "gemini_transcribe",
      "gemini_chat",
      "gemini_get_interaction",
    ]);
    for (const n of names) expect(n).toMatch(/^gemini_[a-z_]+$/);
  });

  it("loads through the real loader", async () => {
    const h = await loadBuiltinPacks();
    try {
      const names = new Set(h.registry.list().map((t: { name: string }) => t.name));
      for (const n of toolNames(geminiPack)) expect(names.has(n)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("long jobs are flagged longRunning", () => {
    for (const n of [
      "gemini_generate_image",
      "gemini_generate_video",
      "gemini_generate_music",
      "gemini_transcribe",
    ]) {
      expect(toolOf(geminiPack, n).longRunning).toBe(true);
    }
  });
});

describe("gemini_generate_image", () => {
  it("builds an Interactions request with the key in a header only and saves the image", async () => {
    const h = setup(() =>
      jsonResponse(
        interaction([{ type: "image", mime_type: "image/jpeg", data: b64("JPEGDATA") }]),
      ),
    );
    const out = (await toolOf(geminiPack, "gemini_generate_image").run(
      { prompt: "a red fox", aspect_ratio: "16:9", image_size: "2K" },
      h.ctx,
    )) as {
      artifacts: { id: string; url: string; mime: string }[];
      model: string;
      provider: string;
      cost_usd_estimate: number;
    };
    const c = h.calls[0]!;
    expect(c.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(c.url).not.toContain(KEY);
    expect(c.headers["x-goog-api-key"]).toBe(KEY);
    expect(c.headers["Api-Revision"]).toBe("2026-05-20");
    expect(c.body).toMatchObject({
      model: "gemini-nano-banana-2.1",
      input: [{ type: "text", text: "a red fox" }],
      response_format: {
        type: "image",
        aspect_ratio: "16:9",
        image_size: "2K",
        mime_type: "image/jpeg",
      },
    });
    expect(out.artifacts).toEqual([
      { id: "art_1", url: "http://127.0.0.1:7777/a/art_1", mime: "image/jpeg" },
    ]);
    expect(out.provider).toBe("gemini");
    expect(out.cost_usd_estimate).toBeCloseTo((1120 * 30 + 10 * 1.5) / 1e6, 6);
    expect(Buffer.from(h.saved[0]!.bytes as Uint8Array).toString()).toBe("JPEGDATA");
    expect(h.saved[0]).toMatchObject({ kind: "image", tool: "gemini_generate_image" });
    expect(JSON.stringify(h.saved)).not.toContain(KEY);
  });

  it("resolves image_inputs through the library and rejects unknown ids", async () => {
    const h = setup(
      () => jsonResponse(interaction([{ type: "image", mime_type: "image/png", data: b64("P") }])),
      { artifacts: { a1: { mime: "image/png", bytes: new Uint8Array([1, 2, 3]) } } },
    );
    await caps.imageGenerate({ prompt: "edit", image_inputs: ["a1"] }, h.ctx);
    const parts = h.calls[0]!.body!.input as Record<string, unknown>[];
    expect(parts[1]).toEqual({
      type: "image",
      mime_type: "image/png",
      data: b64(new Uint8Array([1, 2, 3])),
    });
    await expect(
      caps.imageGenerate({ prompt: "edit", image_inputs: ["nope"] }, h.ctx),
    ).rejects.toThrow(/not found/);
    await expect(
      caps.imageGenerate({ prompt: "edit", image_inputs: ["/etc/passwd"] }, h.ctx),
    ).rejects.toThrow(/library/);
  });

  it("makes n requests and falls back to flat pricing when usage is absent", async () => {
    const h = setup(() =>
      jsonResponse({ ...interaction([{ type: "image", data: b64("X") }]), usage: undefined }),
    );
    const out = (await caps.imageGenerate({ prompt: "x", n: 2 }, h.ctx)) as {
      artifacts: unknown[];
      cost_usd_estimate: number;
    };
    expect(h.calls).toHaveLength(2);
    expect(out.artifacts).toHaveLength(2);
    expect(out.cost_usd_estimate).toBeCloseTo(0.0672, 6);
  });

  it("explains a response with no image", async () => {
    const h = setup(() =>
      jsonResponse(interaction([{ type: "text", text: "I cannot draw that" }])),
    );
    await expect(caps.imageGenerate({ prompt: "x" }, h.ctx)).rejects.toThrow(/no image.*rephrase/i);
  });
});

describe("gemini_generate_video", () => {
  it("sends the documented body (fast poll)", async () => {
    const { generateVideo } = await import("../../../packs/gemini/ops.js");
    let polls = 0;
    const h = setup((c) => {
      if (c.method === "POST") return jsonResponse({ id: "int_v", status: "in_progress" });
      if (c.url.endsWith("/v1beta/interactions/int_v")) {
        polls++;
        return polls < 2
          ? jsonResponse({ id: "int_v", status: "in_progress" })
          : jsonResponse(
              interaction([{ type: "video", mime_type: "video/mp4", data: b64("MP4") }], {
                id: "int_v",
                usage: { total_output_tokens: 57920 },
              }),
            );
      }
      throw new Error(`unexpected ${c.url}`);
    });
    const res = await generateVideo(
      { prompt: "waves", duration_seconds: 5, aspect_ratio: "9:16", resolution: "1080p" },
      h.ctx,
      "gemini_generate_video",
      { pollMs: 1 },
    );
    expect(h.calls[0]!.body).toMatchObject({
      model: "gemini-omni-1.2-flash",
      input: "waves",
      background: true,
      response_format: {
        type: "video",
        aspect_ratio: "9:16",
        resolution: "1080p",
        duration: "5s",
        delivery: "uri",
      },
    });
    expect(h.calls[0]!.headers["x-goog-api-key"]).toBe(KEY);
    expect(res.cost_usd_estimate).toBeCloseTo((57920 * 12) / 1e6, 5);
    expect(res.artifacts[0]?.mime).toBe("video/mp4");
    expect(h.progress.length).toBeGreaterThan(0);
    expect(h.saved[0]).toMatchObject({ kind: "video" });
  });

  it("downloads a delivered uri after the file turns ACTIVE", async () => {
    const { generateVideo } = await import("../../../packs/gemini/ops.js");
    let fileChecks = 0;
    const h = setup((c) => {
      if (c.method === "POST") {
        return jsonResponse(
          interaction([
            {
              type: "video",
              mime_type: "video/mp4",
              uri: "https://generativelanguage.googleapis.com/v1beta/files/abc123:download?alt=media",
            },
          ]),
        );
      }
      if (c.url.endsWith("/v1beta/files/abc123"))
        return jsonResponse({ state: ++fileChecks < 2 ? "PROCESSING" : "ACTIVE" });
      if (
        c.url === "https://generativelanguage.googleapis.com/v1beta/files/abc123:download?alt=media"
      ) {
        return new Response(new Uint8Array([9, 9]), { headers: { "content-type": "video/mp4" } });
      }
      throw new Error(`unexpected ${c.url}`);
    });
    await generateVideo({ prompt: "x" }, h.ctx, "gemini_generate_video", { pollMs: 1 });
    expect(fileChecks).toBe(2);
    expect(h.calls.at(-1)!.headers["x-goog-api-key"]).toBe(KEY);
    expect(Array.from(h.saved[0]!.bytes as Uint8Array)).toEqual([9, 9]);
  });

  it("uses image_input as the first frame", async () => {
    const { generateVideo } = await import("../../../packs/gemini/ops.js");
    const h = setup(() => jsonResponse(interaction([{ type: "video", data: b64("V") }])), {
      artifacts: { img: { mime: "image/png", bytes: new Uint8Array([7]) } },
    });
    await generateVideo({ prompt: "animate", image_input: "img" }, h.ctx, "t", { pollMs: 1 });
    const body = h.calls[0]!.body!;
    expect((body.input as Record<string, unknown>[])[0]).toMatchObject({
      type: "image",
      mime_type: "image/png",
    });
    expect(body.generation_config).toEqual({ video_config: { task: "image_to_video" } });
    await expect(generateVideo({ prompt: "x", end_image_input: "img" }, h.ctx)).rejects.toThrow(
      /first frame/,
    );
  });

  it("cancels the remote interaction when the call is aborted", async () => {
    const { generateVideo } = await import("../../../packs/gemini/ops.js");
    const ac = new AbortController();
    const h = setup(
      (c) => {
        if (c.method === "POST" && c.url.endsWith("/cancel")) return jsonResponse({});
        if (c.method === "POST") return jsonResponse({ id: "int_v", status: "in_progress" });
        ac.abort();
        return jsonResponse({ id: "int_v", status: "in_progress" });
      },
      { signal: ac.signal },
    );
    await expect(generateVideo({ prompt: "x" }, h.ctx, "t", { pollMs: 50 })).rejects.toThrow(
      /cancel/i,
    );
    expect(h.calls.some((c) => c.url.endsWith("/interactions/int_v/cancel"))).toBe(true);
  });

  it("validates duration bounds", () => {
    const t = toolOf(geminiPack, "gemini_generate_video");
    expect(t.input.safeParse({ prompt: "x", duration_seconds: 99 }).success).toBe(false);
    expect(t.input.safeParse({ prompt: "x", duration_seconds: 5 }).success).toBe(true);
  });
});

describe("gemini_generate_speech", () => {
  it("wraps headerless PCM in a WAV header", async () => {
    const pcm = new Uint8Array(480).fill(1);
    const h = setup(() =>
      jsonResponse(
        interaction([{ type: "audio", mime_type: "audio/l16;rate=24000", data: b64(pcm) }]),
      ),
    );
    const out = (await toolOf(geminiPack, "gemini_generate_speech").run(
      { text: "hello", voice: "Puck", style: "cheerful" },
      h.ctx,
    )) as {
      artifacts: { mime: string }[];
    };
    expect(h.calls[0]!.body).toMatchObject({
      model: "gemini-3.8-flash-tts",
      input: [
        {
          type: "user_input",
          content: [
            {
              type: "text",
              text: "hello",
              annotations: [{ type: "speech_metadata", style: "cheerful" }],
            },
          ],
        },
      ],
      response_format: { type: "audio", mime_type: "audio/wav", sample_rate: 24000 },
      generation_config: { speech_config: [{ voice: "Puck" }] },
    });
    const wav = h.saved[0]!.bytes as Uint8Array;
    expect(Buffer.from(wav.subarray(0, 4)).toString()).toBe("RIFF");
    expect(Buffer.from(wav.subarray(8, 12)).toString()).toBe("WAVE");
    expect(wav.length).toBe(44 + 480);
    expect(Buffer.from(wav).readUInt32LE(24)).toBe(24000);
    expect(out.artifacts[0]?.mime).toBe("audio/wav");
  });

  it("keeps a WAV that already has a header and supports multi speaker", async () => {
    const wav = pcmToWav(new Uint8Array(10), 24000);
    const h = setup(() =>
      jsonResponse(interaction([{ type: "audio", mime_type: "audio/wav", data: b64(wav) }])),
    );
    await caps.speechGenerate(
      {
        text: "Joe: hi\nSam: yo",
        speakers: [
          { speaker: "Joe", voice: "Puck" },
          { speaker: "Sam", voice: "Kore" },
        ],
      },
      h.ctx,
    );
    expect((h.saved[0]!.bytes as Uint8Array).length).toBe(wav.length);
    expect((h.calls[0]!.body!.generation_config as Record<string, unknown>).speech_config).toEqual({
      speakers: [
        { speaker: "Joe", voice: "Puck" },
        { speaker: "Sam", voice: "Kore" },
      ],
    });
  });
});

describe("gemini_generate_music", () => {
  it("picks the clip model for short requests and reports flat cost and lyrics", async () => {
    const h = setup(() =>
      jsonResponse(
        interaction([
          { type: "text", text: "La la" },
          { type: "audio", mime_type: "audio/mpeg", data: b64("MP3") },
        ]),
      ),
    );
    const out = (await caps.musicGenerate(
      { prompt: "lofi beat", duration_seconds: 20 },
      h.ctx,
    )) as { model: string; cost_usd_estimate: number; lyrics: string };
    expect(out.model).toBe("lyria-3-clip-preview");
    expect(out.cost_usd_estimate).toBe(0.04);
    expect(out.lyrics).toBe("La la");
    expect(h.calls[0]!.body).toMatchObject({ model: "lyria-3-clip-preview", background: true });
    expect(String(h.calls[0]!.body!.input)).toContain("about 20 seconds");
  });

  it("defaults to lyria-3.5 and honours format wav", async () => {
    const h = setup(() =>
      jsonResponse(interaction([{ type: "audio", mime_type: "audio/wav", data: b64("W") }])),
    );
    const out = (await caps.musicGenerate({ prompt: "epic", format: "wav" }, h.ctx)) as {
      model: string;
      cost_usd_estimate: number;
    };
    expect(out.model).toBe("lyria-3.5");
    expect(out.cost_usd_estimate).toBe(0.08);
    expect(h.calls[0]!.body!.response_format).toEqual({ type: "audio", mime_type: "audio/wav" });
  });
});

describe("gemini_transcribe", () => {
  const audio = { a1: { mime: "audio/mpeg", bytes: new Uint8Array([1, 2]) } };

  it("sends inline audio and returns plain text", async () => {
    const h = setup(() => jsonResponse(interaction([{ type: "text", text: "hello world" }])), {
      artifacts: audio,
    });
    const out = await caps.audioTranscribe({ artifact_id: "a1", language: "English" }, h.ctx);
    expect(out).toEqual({ text: "hello world" });
    const input = h.calls[0]!.body!.input as Record<string, unknown>[];
    expect(input[1]).toEqual({
      type: "audio",
      mime_type: "audio/mpeg",
      data: b64(new Uint8Array([1, 2])),
    });
    expect(h.calls[0]!.body!.model).toBe("gemini-3.5-transcribe");
    expect(h.calls[0]!.body!.response_format).toBeUndefined();
  });

  it("requests a schema for segments and parses them", async () => {
    const json = JSON.stringify({
      text: "hi there",
      segments: [{ speaker: "A", timestamp: "00:01", content: "hi there" }],
    });
    const h = setup(() => jsonResponse(interaction([{ type: "text", text: json }])), {
      artifacts: audio,
    });
    const out = (await caps.audioTranscribe(
      { artifact_id: "a1", speakers: true, timestamps: true },
      h.ctx,
    )) as { text: string; segments: unknown[] };
    expect(out.segments).toEqual([{ start: "00:01", speaker: "A", text: "hi there" }]);
    expect((h.calls[0]!.body!.response_format as Record<string, unknown>).mime_type).toBe(
      "application/json",
    );
  });

  it("rejects non-audio artifacts and oversize files", async () => {
    const h = setup(() => jsonResponse({}), {
      artifacts: {
        doc: { mime: "text/plain", bytes: new Uint8Array(1) },
        big: { mime: "audio/mpeg", bytes: new Uint8Array(16 * 1024 * 1024) },
      },
    });
    await expect(caps.audioTranscribe({ artifact_id: "doc" }, h.ctx)).rejects.toThrow(
      /needs video/,
    );
    await expect(caps.audioTranscribe({ artifact_id: "big" }, h.ctx)).rejects.toThrow(/limit/);
    expect(h.calls).toHaveLength(0);
  });
});

describe("gemini_chat", () => {
  it("maps system, json, temperature and max_tokens and reports usage", async () => {
    const h = setup(() =>
      jsonResponse(
        interaction([{ type: "text", text: '{"a":1}' }], {
          model: "gemini-4-hydrogen",
          usage: { total_input_tokens: 5, total_output_tokens: 7 },
        }),
      ),
    );
    const out = await caps.chat(
      {
        messages: [
          { role: "system", content: "be terse" },
          { role: "user", content: "hi" },
        ],
        json: true,
        temperature: 0.2,
        max_tokens: 100,
      },
      h.ctx,
    );
    expect(out).toEqual({
      text: '{"a":1}',
      usage: { input_tokens: 5, output_tokens: 7 },
      model: "gemini-4-hydrogen",
      provider: "gemini",
    });
    expect(h.calls[0]!.body).toEqual({
      model: "gemini-4-hydrogen",
      input: "hi",
      system_instruction: "be terse",
      generation_config: { temperature: 0.2, max_output_tokens: 100 },
      response_format: { type: "text", mime_type: "application/json" },
    });
  });

  it("sends multi-turn history as steps and requires a final user message", async () => {
    const h = setup(() => jsonResponse(interaction([{ type: "text", text: "ok" }])));
    await caps.chat(
      {
        messages: [
          { role: "user", content: "a" },
          { role: "assistant", content: "b" },
          { role: "user", content: "c" },
        ],
      },
      h.ctx,
    );
    expect(h.calls[0]!.body!.input).toEqual([
      { type: "user_input", content: [{ type: "text", text: "a" }] },
      { type: "model_output", content: [{ type: "text", text: "b" }] },
      { type: "user_input", content: [{ type: "text", text: "c" }] },
    ]);
    await expect(
      caps.chat({ messages: [{ role: "assistant", content: "x" }] }, h.ctx),
    ).rejects.toThrow(/last message/);
  });
});

describe("gemini_list_models", () => {
  it("pages through the live list, caches it, and filters", async () => {
    const h = setup((c) => {
      const next = c.url.includes("pageToken=p2");
      return jsonResponse(
        next
          ? {
              models: [
                {
                  name: "models/gemini-4-carbon",
                  displayName: "Carbon",
                  supportedGenerationMethods: ["generateContent"],
                },
              ],
            }
          : {
              models: [
                {
                  name: "models/gemini-4-hydrogen",
                  baseModelId: "gemini-4-hydrogen",
                  displayName: "Hydrogen",
                  inputTokenLimit: 1000000,
                },
              ],
              nextPageToken: "p2",
            },
      );
    });
    const t = toolOf(geminiPack, "gemini_list_models");
    const a = (await t.run({}, h.ctx)) as {
      count: number;
      cached: boolean;
      live: { id: string }[];
      curated: unknown;
    };
    expect(a.live.map((m) => m.id)).toEqual(["gemini-4-hydrogen", "gemini-4-carbon"]);
    expect(a.cached).toBe(false);
    expect(a.curated).toBeDefined();
    expect(h.calls.every((c) => !c.url.includes(KEY))).toBe(true);
    const b = (await t.run({ filter: "carbon" }, h.ctx)) as { count: number; cached: boolean };
    expect(b).toMatchObject({ count: 1, cached: true });
    expect(h.calls).toHaveLength(2);
  });
});

describe("errors and secrets", () => {
  it("maps provider errors to actionable messages without echoing the key or raw body", async () => {
    const bad = (status: number, message: string) =>
      setup(() =>
        jsonResponse({ error: { code: status, message, status: "RESOURCE_EXHAUSTED" } }, status),
      );
    const e403 = await failure(
      caps.chat({ messages: [{ role: "user", content: "x" }] }, bad(403, `key ${KEY} invalid`).ctx),
    );
    expect(e403.message).toMatch(/refused the API key.*GEMINI_API_KEY/);
    expect(e403.message).not.toContain(KEY);
    const e429 = await failure(
      caps.chat({ messages: [{ role: "user", content: "x" }] }, bad(429, "quota").ctx),
    );
    expect(e429.message).toMatch(/rate limit.*Wait/);
    const e400 = await failure(
      caps.chat(
        { messages: [{ role: "user", content: "x" }] },
        bad(400, `bad field for ${KEY}`).ctx,
      ),
    );
    expect(e400.message).toContain("bad field");
    expect(e400.message).not.toContain(KEY);
    const e404 = await failure(
      caps.chat(
        { messages: [{ role: "user", content: "x" }], model: "nope" },
        bad(404, "not found").ctx,
      ),
    );
    expect(e404.message).toMatch(/gemini_list_models/);
    const e500 = await failure(
      caps.chat({ messages: [{ role: "user", content: "x" }] }, bad(503, "oops").ctx),
    );
    expect(e500.message).toMatch(/server error/);
  });

  it("surfaces a missing key from ctx.secrets", async () => {
    const ctx = fakeCtx({
      packId: "gemini",
      secrets: {},
      fetch: (async () => jsonResponse({})) as never,
    });
    await expect(caps.chat({ messages: [{ role: "user", content: "x" }] }, ctx)).rejects.toThrow(
      /GEMINI_API_KEY/,
    );
  });

  it("reports a network failure without the key", async () => {
    const ctx = fakeCtx({
      packId: "gemini",
      secrets: { GEMINI_API_KEY: KEY },
      fetch: (async () => {
        throw new Error(`socket closed for ${KEY}`);
      }) as never,
    });
    const e = await failure(caps.chat({ messages: [{ role: "user", content: "x" }] }, ctx));
    expect(e.message).toMatch(/Could not reach/);
    expect(e.message).not.toContain(KEY);
  });
});

describe("input validation", () => {
  it("bounds prompts, counts and ids", () => {
    const img = toolOf(geminiPack, "gemini_generate_image").input;
    expect(img.safeParse({ prompt: "" }).success).toBe(false);
    expect(img.safeParse({ prompt: "x".repeat(8001) }).success).toBe(false);
    expect(img.safeParse({ prompt: "x", n: 5 }).success).toBe(false);
    expect(img.safeParse({ prompt: "x", aspect_ratio: "wide" }).success).toBe(false);
    expect(img.safeParse({ prompt: "x", model: "a/b?key=1" }).success).toBe(false);
    expect(toolOf(geminiPack, "gemini_chat").input.safeParse({ messages: [] }).success).toBe(false);
    expect(
      toolOf(geminiPack, "gemini_generate_speech").input.safeParse({ text: "x".repeat(9000) })
        .success,
    ).toBe(false);
  });
});

describe("pcmToWav", () => {
  it("writes a valid 16-bit mono header", () => {
    const w = Buffer.from(pcmToWav(new Uint8Array(100), 16000));
    expect(w.readUInt32LE(4)).toBe(136);
    expect(w.readUInt16LE(22)).toBe(1);
    expect(w.readUInt32LE(24)).toBe(16000);
    expect(w.readUInt32LE(28)).toBe(32000);
    expect(w.readUInt32LE(40)).toBe(100);
  });
});
