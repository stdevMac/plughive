import type { PackContext } from "plughive/pack";
// The sound.effect and voice.clone capability providers: request shape,
// output normalization, and retryable refusals before any request versus
// final errors after ElevenLabs accepted one.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { providers } from "../../../packs/elevenlabs/capabilities.js";
import { clearModelCache } from "../../../packs/elevenlabs/ops.js";
import { CAPABILITY_SCHEMAS } from "../../../src/core/capabilities/schemas.js";
import { fakeCtx } from "../support.js";

type Cap = keyof typeof CAPABILITY_SCHEMAS;
const KEY = "sk_0123456789abcdef0123456789abcdef01234567";
const UNSUPPORTED = { name: "CapabilityError", retryable: true, code: "UNSUPPORTED_OPTION" };

interface Call {
  url: string;
  method: string;
  json: Record<string, unknown> | null;
  form: FormData | null;
}

function setup(handler: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const saved: Record<string, unknown>[] = [];
  const arts: Record<string, { mime: string; bytes: Uint8Array }> = {
    s1: { mime: "audio/mpeg", bytes: new Uint8Array([1, 2, 3]) },
    s2: { mime: "audio/wav", bytes: new Uint8Array([4, 5]) },
    img: { mime: "image/png", bytes: new Uint8Array([0x89, 0x50]) },
  };
  const fetchFn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const body = init?.body;
    const c: Call = {
      url: String(url),
      method: init?.method ?? "GET",
      json: typeof body === "string" ? JSON.parse(body) : null,
      form: body instanceof FormData ? body : null,
    };
    calls.push(c);
    return handler(c);
  });
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
    progress: () => {},
  };
  return { ctx: ctx as unknown as PackContext, calls, saved };
}

const find = (cap: Cap) => {
  const p = providers.find((x) => x.capability === cap);
  if (!p) throw new Error(`no ${cap} provider`);
  return p as unknown as {
    id: string;
    priority?: number;
    run(input: unknown, ctx: PackContext): Promise<unknown>;
  };
};

async function call(cap: Cap, input: unknown, ctx: PackContext) {
  const out = await find(cap).run(CAPABILITY_SCHEMAS[cap].input.parse(input), ctx);
  return CAPABILITY_SCHEMAS[cap].output.parse(out) as Record<string, unknown>;
}

async function failure(cap: Cap, input: unknown, ctx: PackContext) {
  return (await find(cap)
    .run(CAPABILITY_SCHEMAS[cap].input.parse(input), ctx)
    .catch((e: unknown) => e)) as {
    name?: string;
    retryable?: boolean;
    code?: string;
    message?: string;
  };
}

const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const audio = (bytes: number[], mime = "audio/mpeg") =>
  new Response(new Uint8Array(bytes), { headers: { "content-type": mime } });

beforeEach(() => clearModelCache());

describe("elevenlabs providers", () => {
  it("serve sound.effect and voice.clone at the pack's priority", () => {
    for (const cap of ["sound.effect", "voice.clone"] as const) {
      expect(find(cap)).toMatchObject({ id: "elevenlabs", priority: 60 });
    }
  });
});

describe("elevenlabs sound.effect", () => {
  it("posts the prompt, model and duration to /v1/sound-generation and returns one audio artifact", async () => {
    const h = setup(() => audio([9, 9, 9]));
    const out = await call("sound.effect", { prompt: "door creak", duration_seconds: 3 }, h.ctx);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.method).toBe("POST");
    expect(h.calls[0]!.url).toBe(
      "https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128",
    );
    expect(h.calls[0]!.json).toEqual({
      text: "door creak",
      model_id: "eleven_text_to_sound_v3",
      duration_seconds: 3,
    });
    expect(out).toMatchObject({ model: "eleven_text_to_sound_v3", provider: "elevenlabs" });
    expect(out.artifacts).toEqual([
      { id: "art_1", url: "http://127.0.0.1:7777/a/art_1", mime: "audio/mpeg" },
    ]);
  });

  it("asks for wav output in the query and honours the v2 model", async () => {
    const h = setup(() => audio([1], "audio/wav"));
    const out = await call(
      "sound.effect",
      { prompt: "rain", format: "wav", model: "eleven_text_to_sound_v2" },
      h.ctx,
    );
    expect(h.calls[0]!.url).toContain("output_format=wav_24000");
    expect(h.calls[0]!.json).toEqual({ text: "rain", model_id: "eleven_text_to_sound_v2" });
    expect(out).toMatchObject({ model: "eleven_text_to_sound_v2" });
    expect((out.artifacts as { mime: string }[])[0]!.mime).toBe("audio/wav");
  });

  it("refuses an unknown model and a prompt over 450 characters, before any request", async () => {
    const h = setup(() => audio([1]));
    expect(
      await failure("sound.effect", { prompt: "x", model: "eleven_multilingual_v2" }, h.ctx),
    ).toMatchObject(UNSUPPORTED);
    expect(
      await failure("sound.effect", { prompt: "x", model: "openai/gpt-4o" }, h.ctx),
    ).toMatchObject(UNSUPPORTED);
    expect(await failure("sound.effect", { prompt: "x".repeat(451) }, h.ctx)).toMatchObject(
      UNSUPPORTED,
    );
    expect(h.calls).toHaveLength(0);
  });

  it("an accepted request that returns no audio is not retryable", async () => {
    const h = setup(() => audio([]));
    const err = await failure("sound.effect", { prompt: "boom" }, h.ctx);
    expect(err.message).toMatch(/no audio/);
    expect(err.name).not.toBe("CapabilityError");
    expect(err.retryable).not.toBe(true);
  });
});

describe("elevenlabs voice.clone", () => {
  it("uploads name, every sample as files and the description as multipart to /v1/voices/add", async () => {
    const h = setup(() => json({ voice_id: "v_new", requires_verification: false }));
    const out = await call(
      "voice.clone",
      { name: "Narrator", artifact_ids: ["s1", "s2"], description: "calm" },
      h.ctx,
    );
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.method).toBe("POST");
    expect(h.calls[0]!.url).toBe("https://api.elevenlabs.io/v1/voices/add");
    const form = h.calls[0]!.form!;
    expect(form.get("name")).toBe("Narrator");
    expect(form.get("description")).toBe("calm");
    const files = form.getAll("files") as File[];
    expect(files.map((f) => [f.name, f.type, f.size])).toEqual([
      ["sample-1.mpeg", "audio/mpeg", 3],
      ["sample-2.wav", "audio/wav", 2],
    ]);
    expect(out).toEqual({
      voice_id: "v_new",
      name: "Narrator",
      provider: "elevenlabs",
      model: "instant-voice-clone",
      requires_verification: false,
    });
  });

  it("refuses a model id, before any request", async () => {
    const h = setup(() => json({ voice_id: "v" }));
    expect(
      await failure("voice.clone", { name: "x", artifact_ids: ["s1"], model: "eleven_v3" }, h.ctx),
    ).toMatchObject(UNSUPPORTED);
    expect(h.calls).toHaveLength(0);
  });

  it("does not upload a sample that is not audio", async () => {
    const h = setup(() => json({ voice_id: "v" }));
    const err = await failure("voice.clone", { name: "x", artifact_ids: ["img"] }, h.ctx);
    expect(err).toBeInstanceOf(Error);
    expect(h.calls).toHaveLength(0);
  });

  it("an accepted clone without a voice id, or a rejected one, is not retryable", async () => {
    for (const reply of [() => json({}), () => json({ detail: { message: "bad sample" } }, 400)]) {
      const h = setup(reply);
      const err = await failure("voice.clone", { name: "x", artifact_ids: ["s1"] }, h.ctx);
      expect(err).toBeInstanceOf(Error);
      expect(err.name).not.toBe("CapabilityError");
      expect(err.retryable).not.toBe(true);
    }
  });
});
