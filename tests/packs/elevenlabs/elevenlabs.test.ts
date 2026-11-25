import { beforeEach, describe, expect, it, vi } from "vitest";
import * as caps from "../../../packs/elevenlabs/capabilities.js";
import elevenPack from "../../../packs/elevenlabs/index.js";
import { clearModelCache, dub } from "../../../packs/elevenlabs/ops.js";
import { dubSchema } from "../../../packs/elevenlabs/schemas.js";
import { failure } from "../provider-support.js";
import { fakeCtx, jsonResponse, loadBuiltinPacks, toolNames, toolOf } from "../support.js";

const KEY = "sk_0123456789abcdef0123456789abcdef01234567";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  json: Record<string, unknown> | null;
  form: FormData | null;
}

function setup(
  handler: (c: Call) => Response | Promise<Response>,
  opts: {
    signal?: AbortSignal;
    artifacts?: Record<string, { mime: string; bytes: Uint8Array }>;
  } = {},
) {
  const calls: Call[] = [];
  const saved: Record<string, unknown>[] = [];
  const progress: [number, string | undefined][] = [];
  const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = init?.body;
    const c: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      json: typeof body === "string" ? JSON.parse(body) : null,
      form: body instanceof FormData ? body : null,
    };
    calls.push(c);
    return handler(c);
  });
  const arts = opts.artifacts ?? {};
  const ctx = {
    ...fakeCtx({
      packId: "elevenlabs",
      secrets: { ELEVENLABS_API_KEY: KEY },
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
  return { ctx: ctx as never, calls, saved, progress };
}

const audio = (bytes: number[] | Uint8Array, headers: Record<string, string> = {}) =>
  new Response(new Uint8Array(bytes), { headers: { "content-type": "audio/mpeg", ...headers } });

const media = { a1: { mime: "audio/mpeg", bytes: new Uint8Array([1, 2, 3]) } };

beforeEach(() => clearModelCache());

describe("manifest and registration", () => {
  it("exposes the expected tools", () => {
    expect(toolNames(elevenPack)).toEqual([
      "elevenlabs_list_models",
      "elevenlabs_list_voices",
      "elevenlabs_text_to_speech",
      "elevenlabs_sound_effect",
      "elevenlabs_music",
      "elevenlabs_dub",
      "elevenlabs_get_dub",
      "elevenlabs_transcribe",
      "elevenlabs_isolate_voice",
      "elevenlabs_usage",
    ]);
  });

  it("does not reuse legacy tool names", () => {
    const legacy = [
      "generate_audio",
      "generate_music",
      "list_voices",
      "sample_voices",
      "generate_image",
      "generate_video",
    ];
    for (const n of toolNames(elevenPack)) expect(legacy).not.toContain(n);
  });

  it("loads through the real loader", async () => {
    const h = await loadBuiltinPacks();
    try {
      const names = new Set(h.registry.list().map((t: { name: string }) => t.name));
      for (const n of toolNames(elevenPack)) expect(names.has(n)).toBe(true);
    } finally {
      await h.close();
    }
  });

  it("flags slow tools longRunning", () => {
    for (const n of [
      "elevenlabs_music",
      "elevenlabs_dub",
      "elevenlabs_transcribe",
      "elevenlabs_isolate_voice",
    ]) {
      expect(toolOf(elevenPack, n).longRunning).toBe(true);
    }
  });
});

describe("elevenlabs_text_to_speech", () => {
  it("posts to the voice endpoint with the key in a header and reports characters", async () => {
    const h = setup(() => audio([1, 2, 3], { "character-cost": "11" }));
    const out = (await toolOf(elevenPack, "elevenlabs_text_to_speech").run(
      { text: "Hello world", voice: "v123", stability: 0.4 },
      h.ctx,
    )) as {
      artifacts: { id: string; url: string; mime: string }[];
      characters_used: number;
      model: string;
      provider: string;
    };
    const c = h.calls[0]!;
    expect(c.url).toBe(
      "https://api.elevenlabs.io/v1/text-to-speech/v123?output_format=mp3_44100_128",
    );
    expect(c.url).not.toContain(KEY);
    expect(c.headers["xi-api-key"]).toBe(KEY);
    expect(c.json).toEqual({
      text: "Hello world",
      model_id: "eleven_multilingual_v2",
      voice_settings: { stability: 0.4 },
    });
    expect(out).toEqual({
      artifacts: [{ id: "art_1", url: "http://127.0.0.1:7777/a/art_1", mime: "audio/mpeg" }],
      model: "eleven_multilingual_v2",
      provider: "elevenlabs",
      characters_used: 11,
    });
    expect(h.saved[0]).toMatchObject({
      kind: "audio",
      mime: "audio/mpeg",
      tool: "elevenlabs_text_to_speech",
    });
    expect(JSON.stringify(h.saved)).not.toContain(KEY);
  });

  it("requests wav_24000 natively when format is wav, and falls back to text length", async () => {
    const h = setup(() => audio([82, 73, 70, 70]));
    const out = (await caps.speechGenerate({ text: "abc", format: "wav" }, h.ctx)) as {
      characters_used: number;
    };
    expect(h.calls[0]!.url).toContain("output_format=wav_24000");
    expect(Array.from(h.saved[0]!.bytes as Uint8Array)).toEqual([82, 73, 70, 70]);
    expect(h.saved[0]!.mime).toBe("audio/wav");
    expect(out.characters_used).toBe(3);
  });

  it("rejects empty audio", async () => {
    const h = setup(() => new Response(new Uint8Array(0)));
    await expect(caps.speechGenerate({ text: "x" }, h.ctx)).rejects.toThrow(/no audio/);
  });
});

describe("elevenlabs_sound_effect", () => {
  it("sends the documented body", async () => {
    const h = setup(() => audio([9]));
    await toolOf(elevenPack, "elevenlabs_sound_effect").run(
      { prompt: "door creak", duration_seconds: 3, prompt_influence: 0.6 },
      h.ctx,
    );
    expect(h.calls[0]!.url).toBe(
      "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
    );
    expect(h.calls[0]!.json).toMatchObject({
      text: "door creak",
      model_id: "eleven_text_to_sound_v3",
      duration_seconds: 3,
      prompt_influence: 0.6,
    });
  });
});

describe("elevenlabs_music", () => {
  it("sends model, instrumental flag and length in ms, and returns the song id", async () => {
    const h = setup(() => audio([1, 1], { "song-id": "song_42" }));
    const out = (await caps.musicGenerate(
      { prompt: "calm piano", duration_seconds: 30, instrumental: true },
      h.ctx,
    )) as {
      song_id: string;
      model: string;
    };
    expect(h.calls[0]!.url).toBe("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128");
    expect(h.calls[0]!.json).toEqual({
      prompt: "calm piano",
      model_id: "music_v2_5",
      force_instrumental: true,
      music_length_ms: 30000,
    });
    expect(out.song_id).toBe("song_42");
    expect(out.model).toBe("music_v2_5");
    expect(h.progress.length).toBeGreaterThan(0);
  });

  it("defaults to vocals allowed and omits length", async () => {
    const h = setup(() => audio([1]));
    await caps.musicGenerate({ prompt: "x" }, h.ctx);
    expect(h.calls[0]!.json).toEqual({
      prompt: "x",
      model_id: "music_v2_5",
      force_instrumental: false,
    });
  });
});

describe("elevenlabs_dub", () => {
  const input = { artifact_id: "a1", target_language: "es" };

  const SIGNED =
    "https://storage.googleapis.com/eleven-dubbing/proj_1/lang_1/output.flac?X-Goog-Signature=abc";

  it("submits the project, polls the language, downloads the signed FLAC without the key", async () => {
    let polls = 0;
    const h = setup(
      (c) => {
        if (c.method === "POST")
          return jsonResponse({ project_id: "proj_1", status: "queued", language_ids: ["lang_1"] });
        if (c.url.endsWith("/v1/dubbing/project/proj_1/language/lang_1")) {
          return jsonResponse(
            ++polls < 3
              ? { status: "processing" }
              : { status: "completed", outputs: { lossless_audio: SIGNED } },
          );
        }
        if (c.url === SIGNED)
          return new Response(new Uint8Array([5, 5]), {
            headers: { "content-type": "audio/flac" },
          });
        throw new Error(`unexpected ${c.url}`);
      },
      { artifacts: { a1: { mime: "video/mp4", bytes: new Uint8Array([1, 2, 3]) } } },
    );
    const out = await dub(dubSchema.parse(input), h.ctx, "elevenlabs_dub", { pollMs: 1 });
    const post = h.calls[0]!;
    expect(post.url).toBe("https://api.elevenlabs.io/v1/dubbing/project");
    expect(post.headers["xi-api-key"]).toBe(KEY);
    expect(post.headers["Content-Type"]).toBeUndefined();
    expect(post.form!.get("target_language")).toBe("es");
    expect(post.form!.get("source_language")).toBeNull();
    expect(post.form!.get("file")).toBeInstanceOf(Blob);
    expect(polls).toBe(3);
    const dl = h.calls[h.calls.length - 1]!;
    expect(dl.url).toBe(SIGNED);
    expect(dl.headers["xi-api-key"]).toBeUndefined();
    expect(out.artifacts[0]).toEqual({
      id: "art_1",
      url: "http://127.0.0.1:7777/a/art_1",
      mime: "audio/flac",
    });
    expect(out.project_id).toBe("proj_1");
    expect(h.saved[0]).toMatchObject({ kind: "audio", mime: "audio/flac" });
    expect(h.progress.length).toBeGreaterThan(1);
  });

  it("sends source_language when given", async () => {
    const h = setup(
      (c) => {
        if (c.method === "POST") return jsonResponse({ project_id: "p", language_ids: ["l"] });
        if (c.url === SIGNED) return new Response(new Uint8Array([1]));
        return jsonResponse({ status: "completed", outputs: { lossless_audio: SIGNED } });
      },
      { artifacts: media },
    );
    await dub(dubSchema.parse({ ...input, source_language: "en" }), h.ctx, "t", { pollMs: 1 });
    expect(h.calls[0]!.form!.get("source_language")).toBe("en");
  });

  it("re-reads the project when the language id is not returned yet", async () => {
    let reads = 0;
    const h = setup(
      (c) => {
        if (c.method === "POST") return jsonResponse({ project_id: "p2", language_ids: [] });
        if (c.url.endsWith("/v1/dubbing/project/p2"))
          return jsonResponse({ status: "ready", language_ids: reads++ ? ["l2"] : [] });
        if (c.url.endsWith("/language/l2"))
          return jsonResponse({ status: "completed", outputs: { lossless_audio: SIGNED } });
        if (c.url === SIGNED) return new Response(new Uint8Array([1]));
        throw new Error(`unexpected ${c.url}`);
      },
      { artifacts: media },
    );
    const out = await dub(dubSchema.parse(input), h.ctx, "t", { pollMs: 1 });
    expect(out.project_id).toBe("p2");
  });

  it("reports a failed dub with advice and without the raw body", async () => {
    const h = setup(
      (c) =>
        c.method === "POST"
          ? jsonResponse({ project_id: "p3", language_ids: ["l"] })
          : jsonResponse({ status: "failed", error: "secret raw detail" }),
      { artifacts: media },
    );
    await expect(dub(dubSchema.parse(input), h.ctx, "t", { pollMs: 1 })).rejects.toThrow(
      /could not dub.*Try a shorter/,
    );
    await expect(dub(dubSchema.parse(input), h.ctx, "t", { pollMs: 1 })).rejects.not.toThrow(
      /secret raw detail/,
    );
  });

  it("refuses a completed dub with no https output link", async () => {
    const h = setup(
      (c) =>
        c.method === "POST"
          ? jsonResponse({ project_id: "p4", language_ids: ["l"] })
          : jsonResponse({ status: "completed", outputs: { lossless_audio: "http://x/y.flac" } }),
      { artifacts: media },
    );
    await expect(dub(dubSchema.parse(input), h.ctx, "t", { pollMs: 1 })).rejects.toThrow(
      /no download link/,
    );
  });

  it("explains a blocked download host", async () => {
    const h = setup(
      (c) => {
        if (c.method === "POST") return jsonResponse({ project_id: "p5", language_ids: ["l"] });
        if (c.url === SIGNED) throw new Error("host not allowed");
        return jsonResponse({ status: "completed", outputs: { lossless_audio: SIGNED } });
      },
      { artifacts: media },
    );
    await expect(dub(dubSchema.parse(input), h.ctx, "t", { pollMs: 1 })).rejects.toThrow(
      /download link could not be fetched/,
    );
  });

  it("stops polling at the deadline", async () => {
    const h = setup(
      (c) =>
        c.method === "POST"
          ? jsonResponse({ project_id: "p6", language_ids: ["l"] })
          : jsonResponse({ status: "processing" }),
      { artifacts: media },
    );
    const real = Date.now();
    const spy = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(real)
      .mockReturnValue(real + 3_600_000);
    try {
      await expect(
        dub(dubSchema.parse({ ...input, max_wait_seconds: 30 }), h.ctx, "t", { pollMs: 1 }),
      ).rejects.toThrow(/still running after 30 seconds/);
    } finally {
      spy.mockRestore();
    }
  });

  it("deletes the remote project when cancelled", async () => {
    const ac = new AbortController();
    const h = setup(
      (c) => {
        if (c.method === "DELETE") return jsonResponse({});
        if (c.method === "POST") return jsonResponse({ project_id: "p7", language_ids: ["l"] });
        ac.abort();
        return jsonResponse({ status: "processing" });
      },
      { artifacts: media, signal: ac.signal },
    );
    await expect(dub(dubSchema.parse(input), h.ctx, "t", { pollMs: 20 })).rejects.toThrow(
      /cancel/i,
    );
    const del = h.calls.find((c) => c.method === "DELETE");
    expect(del?.url).toBe("https://api.elevenlabs.io/v1/dubbing/project/p7");
  });

  it("rejects unknown or non-media artifacts before any request", async () => {
    const h = setup(() => jsonResponse({}), {
      artifacts: { doc: { mime: "text/plain", bytes: new Uint8Array(1) } },
    });
    await expect(
      dub(dubSchema.parse({ artifact_id: "nope", target_language: "es" }), h.ctx),
    ).rejects.toThrow(/not found/);
    await expect(
      dub(dubSchema.parse({ artifact_id: "doc", target_language: "es" }), h.ctx),
    ).rejects.toThrow(/needs audio/);
    expect(h.calls).toHaveLength(0);
  });
});

describe("elevenlabs_transcribe", () => {
  const scribe = {
    language_code: "en",
    text: " Hello there. Hi! ",
    words: [
      { text: "Hello", start: 0, end: 0.4, type: "word", speaker_id: "speaker_0" },
      { text: " ", start: 0.4, end: 0.5, type: "spacing", speaker_id: "speaker_0" },
      { text: "there.", start: 0.5, end: 0.9, type: "word", speaker_id: "speaker_0" },
      { text: "Hi!", start: 1.0, end: 1.2, type: "word", speaker_id: "speaker_1" },
    ],
  };

  it("returns plain text without segments by default", async () => {
    const h = setup(() => jsonResponse(scribe), { artifacts: media });
    const out = await caps.audioTranscribe({ artifact_id: "a1", language: "en" }, h.ctx);
    expect(out).toEqual({ text: "Hello there. Hi!" });
    const f = h.calls[0]!.form!;
    expect(h.calls[0]!.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(f.get("model_id")).toBe("scribe_v3");
    expect(f.get("language_code")).toBe("en");
    expect(f.get("timestamps_granularity")).toBeNull();
  });

  it("groups words into speaker segments when diarize is set", async () => {
    const h = setup(() => jsonResponse(scribe), { artifacts: media });
    const out = (await toolOf(elevenPack, "elevenlabs_transcribe").run(
      { artifact_id: "a1", diarize: true },
      h.ctx,
    )) as { segments: unknown[] };
    expect(out.segments).toEqual([
      { start: 0, end: 0.9, speaker: "speaker_0", text: "Hello there." },
      { start: 1, end: 1.2, speaker: "speaker_1", text: "Hi!" },
    ]);
    expect(h.calls[0]!.form!.get("diarize")).toBe("true");
    expect(h.calls[0]!.form!.get("timestamps_granularity")).toBe("word");
  });
});

describe("elevenlabs_isolate_voice", () => {
  it("uploads as the audio field and saves the result", async () => {
    const h = setup(() => audio([4, 4, 4]), { artifacts: media });
    const out = (await toolOf(elevenPack, "elevenlabs_isolate_voice").run(
      { artifact_id: "a1" },
      h.ctx,
    )) as { artifacts: unknown[] };
    expect(h.calls[0]!.url).toBe("https://api.elevenlabs.io/v1/audio-isolation");
    expect(h.calls[0]!.form!.get("audio")).toBeInstanceOf(Blob);
    expect(out.artifacts).toHaveLength(1);
  });
});

describe("elevenlabs_list_voices", () => {
  const voices = {
    voices: [
      {
        voice_id: "v1",
        name: "Rachel",
        category: "premade",
        description: "calm",
        preview_url: "https://x/p1.mp3",
        labels: { gender: "female", accent: "american", use_case: "narration" },
      },
      {
        voice_id: "v2",
        name: "Adam",
        category: "premade",
        labels: { gender: "male", accent: "british", use_case: "conversational" },
      },
    ],
    has_more: true,
    next_page_token: "tok2",
  };

  it("passes search to the API and returns compact rows", async () => {
    const h = setup(() => jsonResponse(voices));
    const out = (await toolOf(elevenPack, "elevenlabs_list_voices").run(
      { search: "calm", limit: 5 },
      h.ctx,
    )) as {
      count: number;
      voices: Record<string, string>[];
      next_page_token: string;
    };
    expect(h.calls[0]!.url).toContain("/v2/voices?");
    expect(h.calls[0]!.url).toContain("search=calm");
    expect(out.count).toBe(2);
    expect(out.voices[0]).toEqual({
      id: "v1",
      name: "Rachel",
      category: "premade",
      gender: "female",
      accent: "american",
      age: "",
      use_case: "narration",
      description: "calm",
      preview_url: "https://x/p1.mp3",
    });
    expect(out.next_page_token).toBe("tok2");
  });

  it("passes gender, accent and use_cases as server-side filters", async () => {
    const h = setup(() => jsonResponse(voices));
    await caps_list({ gender: "male", accent: "british", use_case: "narration", limit: 7 }, h.ctx);
    const u = new URL(h.calls[0]!.url);
    expect(u.pathname).toBe("/v2/voices");
    expect(u.searchParams.get("gender")).toBe("male");
    expect(u.searchParams.get("accent")).toBe("british");
    expect(u.searchParams.get("use_cases")).toBe("narration");
    expect(u.searchParams.get("page_size")).toBe("7");
  });
});

function caps_list(input: Record<string, unknown>, ctx: never) {
  return toolOf(elevenPack, "elevenlabs_list_voices").run(input, ctx);
}

describe("elevenlabs_list_models and usage", () => {
  it("lists and caches models", async () => {
    const h = setup(() =>
      jsonResponse([
        {
          model_id: "eleven_v3",
          name: "v3",
          description: "x".repeat(300),
          languages: [{}, {}],
          can_do_text_to_speech: true,
          maximum_text_length_per_request: 5000,
        },
      ]),
    );
    const t = toolOf(elevenPack, "elevenlabs_list_models");
    const a = (await t.run({}, h.ctx)) as {
      models: { id: string; description: string }[];
      cached: boolean;
    };
    expect(a.models[0]).toMatchObject({
      id: "eleven_v3",
      languages: 2,
      text_to_speech: true,
      max_characters: 5000,
    });
    expect(a.models[0]!.description.length).toBe(160);
    const b = (await t.run({}, h.ctx)) as { cached: boolean };
    expect([a.cached, b.cached]).toEqual([false, true]);
    expect(h.calls).toHaveLength(1);
  });

  it("summarises the subscription", async () => {
    const h = setup(() =>
      jsonResponse({
        tier: "creator",
        status: "active",
        character_count: 1200,
        character_limit: 100000,
        next_character_count_reset_unix: 1_800_000_000,
        voice_slots_used: 2,
        voice_limit: 30,
      }),
    );
    const out = await toolOf(elevenPack, "elevenlabs_usage").run({}, h.ctx);
    expect(out).toEqual({
      tier: "creator",
      status: "active",
      characters_used: 1200,
      characters_limit: 100000,
      characters_remaining: 98800,
      resets_at: new Date(1_800_000_000_000).toISOString(),
      voice_slots_used: 2,
      voice_limit: 30,
    });
    expect(h.calls[0]!.url).toBe("https://api.elevenlabs.io/v1/user/subscription");
  });
});

describe("errors and secrets", () => {
  const fail = (status: number, body: unknown) => setup(() => jsonResponse(body, status));
  const tts = (ctx: Parameters<typeof caps.speechGenerate>[1]) =>
    failure(caps.speechGenerate({ text: "x" }, ctx));

  it("maps statuses to actionable messages without echoing keys or raw bodies", async () => {
    const e401 = await tts(
      fail(401, { detail: { status: "invalid_api_key", message: `bad ${KEY}` } }).ctx,
    );
    expect(e401.message).toMatch(/refused the API key.*ELEVENLABS_API_KEY/);
    expect(e401.message).not.toContain(KEY);
    const e402 = await tts(
      fail(402, { detail: { status: "quota_exceeded", message: "You have 3 credits left" } }).ctx,
    );
    expect(e402.message).toMatch(/elevenlabs_usage/);
    const e404 = await tts(fail(404, { detail: { status: "voice_not_found", message: "no" } }).ctx);
    expect(e404.message).toMatch(/elevenlabs_list_voices/);
    const e422 = await tts(fail(422, { detail: [{ msg: `field ${KEY} wrong` }] }).ctx);
    expect(e422.message).toContain("field [key] wrong");
    const e429 = await tts(fail(429, { detail: { status: "too_many_concurrent_requests" } }).ctx);
    expect(e429.message).toMatch(/concurrency.*one at a time/);
    const e500 = await tts(fail(503, "oops").ctx);
    expect(e500.message).toMatch(/server error.*may already have been processed and billed/);
    expect(e500.message).not.toMatch(/Retry shortly/);
  });

  it("surfaces a missing key", async () => {
    const ctx = fakeCtx({
      packId: "elevenlabs",
      secrets: {},
      fetch: (async () => jsonResponse({})) as never,
    });
    await expect(caps.speechGenerate({ text: "x" }, ctx)).rejects.toThrow(/ELEVENLABS_API_KEY/);
  });

  it("reports network failures and timeouts without the key", async () => {
    const mk = (msg: string) =>
      fakeCtx({
        packId: "elevenlabs",
        secrets: { ELEVENLABS_API_KEY: KEY },
        fetch: (async () => {
          throw new Error(msg);
        }) as never,
      });
    const a = await tts(mk(`socket closed ${KEY}`));
    expect(a.message).toMatch(/Could not reach/);
    expect(a.message).not.toContain(KEY);
    const b = await tts(mk("Request to api.elevenlabs.io timed out after 60000 ms"));
    expect(b.message).toMatch(/timed out.*may already have been processed and billed/);
    expect(b.message).not.toMatch(/or retry/);
  });
});

describe("input validation", () => {
  it("bounds text, durations and ids", () => {
    const t = toolOf(elevenPack, "elevenlabs_text_to_speech").input;
    expect(t.safeParse({ text: "" }).success).toBe(false);
    expect(t.safeParse({ text: "x".repeat(5001) }).success).toBe(false);
    expect(t.safeParse({ text: "x", voice: "../etc" }).success).toBe(false);
    expect(t.safeParse({ text: "x", stability: 2 }).success).toBe(false);
    expect(
      toolOf(elevenPack, "elevenlabs_sound_effect").input.safeParse({
        prompt: "x",
        duration_seconds: 31,
      }).success,
    ).toBe(false);
    expect(
      toolOf(elevenPack, "elevenlabs_music").input.safeParse({ prompt: "x", duration_seconds: 2 })
        .success,
    ).toBe(false);
    expect(
      toolOf(elevenPack, "elevenlabs_music").input.safeParse({ prompt: "x", duration_seconds: 600 })
        .success,
    ).toBe(true);
    expect(
      toolOf(elevenPack, "elevenlabs_music").input.safeParse({ prompt: "x", duration_seconds: 601 })
        .success,
    ).toBe(false);
    expect(
      toolOf(elevenPack, "elevenlabs_dub").input.safeParse({
        artifact_id: "a",
        target_language: "not a lang",
      }).success,
    ).toBe(false);
    expect(
      toolOf(elevenPack, "elevenlabs_list_voices").input.safeParse({ limit: 500 }).success,
    ).toBe(false);
  });
});
