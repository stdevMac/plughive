// Ollama, Kokoro, ComfyUI, whisper.cpp and local_status with fetch/spawn mocked,
// plus URL validation, the capability functions and the real loader path.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { capabilities } from "../../../packs/local/capabilities.js";
import {
  buildTxt2ImgWorkflow,
  pickCheckpoint,
  sizeFor,
  validateWorkflow,
} from "../../../packs/local/comfy.js";
import pack from "../../../packs/local/index.js";
import { HINTS, LocalBackendError, validateLocalUrl } from "../../../packs/local/lib/util.js";
import {
  gpuFailure,
  parseWhisperJson,
  pickModel,
  whisperArgs,
} from "../../../packs/local/whisper.js";
import { loadBuiltinPacks, toolNames, toolOf } from "../support.js";
import {
  type Env,
  type SpawnCall,
  jsonRes,
  makeEnv,
  recordingSpawn,
  routedFetch,
} from "./harness.js";

let env: Env | undefined;
afterEach(() => env?.cleanup());
const tool = (n: string) => toolOf(pack, n);
const call = async (n: string, input: unknown, e: Env) => {
  const t = tool(n);
  return (await t.run(t.input.parse(input), e.ctx)) as Record<string, any>;
};
const refused = () => {
  throw new Error("fetch must not be called");
};

/** The user turned raw ComfyUI workflows on (off by default). */
const RAW_ON = { allowRawComfyWorkflows: true };

describe("URL validation", () => {
  it("accepts loopback and private hosts", () => {
    for (const u of [
      "http://127.0.0.1:8188",
      "http://localhost:11434",
      "http://[::1]:8880",
      "http://127.5.5.5",
      "http://10.0.0.7:80",
      "http://172.16.3.4:1",
      "http://192.168.1.20:8188/",
      "https://localhost",
    ]) {
      expect(() => validateLocalUrl(u, "s"), u).not.toThrow();
    }
    expect(validateLocalUrl("http://localhost:11434/", "s")).toBe("http://localhost:11434");
  });

  it("rejects everything else", () => {
    for (const u of [
      "http://example.com",
      "http://8.8.8.8",
      "http://172.32.0.1",
      "http://192.169.0.1",
      "http://127.0.0.1.evil.com",
      "http://localhost.evil.com",
      "http://169.254.169.254",
      "http://0.0.0.0:8188",
      "http://user:pw@127.0.0.1:8188",
      "http://127.0.0.1:8188/path",
      "http://127.0.0.1:8188?x=1",
      "ftp://127.0.0.1",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "not a url",
      "",
    ]) {
      expect(() => validateLocalUrl(u, "s"), u).toThrow();
    }
  });

  it("a bad URL setting stops the call before any request", async () => {
    env = makeEnv({
      fetch: refused as never,
      settings: { ollamaUrl: "http://evil.example.com:11434" },
    });
    await expect(call("local_ollama_models", {}, env)).rejects.toThrow(/ollamaUrl/);
    await expect(
      call("local_chat", { messages: [{ role: "user", content: "hi" }] }, env),
    ).rejects.toThrow(/ollamaUrl/);
  });

  it("the default URLs are the manifest's declared loopback host:port pairs", async () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../packs/local/pack.json", import.meta.url), "utf8"),
    );
    const log: string[] = [];
    env = makeEnv({
      fetch: routedFetch(
        {
          "GET /api/tags": () => jsonRes({ models: [] }),
          "GET /v1/audio/voices": () => jsonRes({ voices: ["af_heart"] }),
          "GET /object_info/CheckpointLoaderSimple": () => jsonRes({}),
        },
        log,
      ),
    });
    await call("local_ollama_models", {}, env);
    await call("local_voices", {}, env);
    await call("local_comfy_status", {}, env).catch(() => undefined);
    const hosts = new Set(log.map((l) => l.split(" ").pop()));
    for (const h of hosts) expect(manifest.permissions.localNetwork).toContain(h);
    expect(hosts.size).toBe(3);
  });
});

describe("Ollama", () => {
  it("lists models", async () => {
    env = makeEnv({
      fetch: routedFetch({
        "GET /api/tags": () =>
          jsonRes({
            models: [
              {
                name: "llama3.2:latest",
                size: 5,
                details: { family: "llama", parameter_size: "3B", quantization_level: "Q4_K_M" },
              },
            ],
          }),
      }),
    });
    const r = await call("local_ollama_models", {}, env);
    expect(r.models[0]).toMatchObject({
      name: "llama3.2:latest",
      family: "llama",
      parameter_size: "3B",
    });
    expect(r.default_model).toBe("llama3.2:latest");
  });

  it("chat: builds a bounded non-streaming request, JSON mode, default model from settings", async () => {
    const bodies: any[] = [];
    env = makeEnv({
      settings: { ollamaModel: "qwen3:8b" },
      fetch: routedFetch({
        "POST /api/chat": (init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return jsonRes({
            model: "qwen3:8b",
            message: { content: '{"a":1}' },
            prompt_eval_count: 7,
            eval_count: 3,
            done_reason: "stop",
          });
        },
      }),
    });
    const r = await call(
      "local_chat",
      { messages: [{ role: "user", content: "hi" }], json: true, max_tokens: 50, temperature: 0.2 },
      env,
    );
    expect(r).toMatchObject({
      text: '{"a":1}',
      model: "qwen3:8b",
      usage: { input_tokens: 7, output_tokens: 3, total_tokens: 10 },
    });
    expect(bodies[0]).toMatchObject({
      model: "qwen3:8b",
      stream: false,
      format: "json",
      options: { num_predict: 50, temperature: 0.2 },
    });
    expect(
      tool("local_chat").input.safeParse({
        messages: [{ role: "user", content: "x" }],
        max_tokens: 100000,
      }).success,
    ).toBe(false);
    expect(tool("local_chat").input.safeParse({ messages: [] }).success).toBe(false);
  });

  it("chat: falls back to the first installed model and explains an empty install", async () => {
    env = makeEnv({
      fetch: routedFetch({
        "GET /api/tags": () => jsonRes({ models: [{ name: "m1" }] }),
        "POST /api/chat": (init) =>
          jsonRes({ model: JSON.parse(String(init?.body)).model, message: { content: "ok" } }),
      }),
    });
    expect(
      (await call("local_chat", { messages: [{ role: "user", content: "hi" }] }, env)).model,
    ).toBe("m1");
    env.cleanup();
    env = makeEnv({ fetch: routedFetch({ "GET /api/tags": () => jsonRes({ models: [] }) }) });
    await expect(
      call("local_chat", { messages: [{ role: "user", content: "hi" }] }, env),
    ).rejects.toThrow(/ollama pull/);
  });

  it("an unreachable Ollama says how to start it; an unknown model says how to pull it", async () => {
    env = makeEnv({
      fetch: (async () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      }) as never,
    });
    const err = await call("local_ollama_models", {}, env).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LocalBackendError);
    expect((err as Error).message).toMatch(/ECONNREFUSED/);
    expect((err as Error).message).toMatch(/ollama serve/);
    env.cleanup();
    env = makeEnv({
      settings: { ollamaModel: "nope" },
      fetch: routedFetch({
        "POST /api/chat": () => jsonRes({ error: "model 'nope' not found" }, 404),
      }),
    });
    await expect(
      call("local_chat", { messages: [{ role: "user", content: "hi" }] }, env),
    ).rejects.toThrow(/ollama pull/);
  });

  it("embeddings", async () => {
    env = makeEnv({
      settings: { ollamaModel: "nomic-embed-text" },
      fetch: routedFetch({
        "POST /api/embed": () =>
          jsonRes({
            model: "nomic-embed-text",
            embeddings: [
              [0.1, 0.2, 0.3],
              [0.4, 0.5, 0.6],
            ],
          }),
      }),
    });
    const r = await call("local_embed", { input: ["a", "b"] }, env);
    expect(r).toMatchObject({ count: 2, dimensions: 3 });
  });

  it("cancelling aborts the request", async () => {
    const ac = new AbortController();
    env = makeEnv({
      signal: ac.signal,
      settings: { ollamaModel: "m" },
      fetch: ((_u: string, init?: RequestInit) =>
        new Promise((_res, rej) => {
          init?.signal?.addEventListener("abort", () =>
            rej(new DOMException("aborted", "AbortError")),
          );
          setTimeout(() => ac.abort(), 10);
        })) as never,
    });
    await expect(
      call("local_chat", { messages: [{ role: "user", content: "hi" }] }, env),
    ).rejects.toThrow(/cancelled/);
  });
});

describe("Kokoro", () => {
  it("lists voices and speaks, saving an artifact", async () => {
    const bodies: any[] = [];
    env = makeEnv({
      settings: { kokoroVoice: "bf_emma" },
      fetch: routedFetch({
        "GET /v1/audio/voices": () => jsonRes({ voices: ["af_heart", "bf_emma"] }),
        "POST /v1/audio/speech": (init) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(new Uint8Array([1, 2, 3, 4]), {
            headers: { "content-type": "audio/mpeg" },
          });
        },
      }),
    });
    expect((await call("local_voices", {}, env)).voices).toEqual(["af_heart", "bf_emma"]);
    const r = await call("local_speak", { text: "hello there", format: "wav", speed: 1.1 }, env);
    expect(bodies[0]).toMatchObject({
      model: "kokoro",
      input: "hello there",
      voice: "bf_emma",
      response_format: "wav",
      speed: 1.1,
    });
    expect(r.artifact.mime).toBe("audio/wav");
    expect(readFileSync(env.records.get(r.artifact.id)!.path)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("validates text and voice, and explains a missing server", async () => {
    expect(tool("local_speak").input.safeParse({ text: "x".repeat(5001) }).success).toBe(false);
    expect(tool("local_speak").input.safeParse({ text: "hi", voice: "../../x" }).success).toBe(
      false,
    );
    expect(tool("local_speak").input.safeParse({ text: "" }).success).toBe(false);
    env = makeEnv({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as never,
    });
    await expect(call("local_speak", { text: "hi" }, env)).rejects.toThrow(
      /docker run -p 8880:8880/,
    );
  });
});

describe("whisper.cpp", () => {
  const segmentsJson = JSON.stringify({
    result: { language: "en" },
    transcription: [
      { offsets: { from: 0, to: 1500 }, text: " Hello there." },
      { offsets: { from: 1500, to: 3000 }, text: " " },
      { offsets: { from: 3000, to: 4200 }, text: " General Kenobi." },
    ],
  });

  it("parses whisper JSON and skips empty segments", () => {
    const r = parseWhisperJson(segmentsJson);
    expect(r.text).toBe("Hello there. General Kenobi.");
    expect(r.segments).toEqual([
      { start_s: 0, end_s: 1.5, text: "Hello there." },
      { start_s: 3, end_s: 4.2, text: "General Kenobi." },
    ]);
    expect(() => parseWhisperJson("nope")).toThrow();
  });

  it("builds argv from validated parts", () => {
    expect(whisperArgs("/m/ggml-base.bin", "/w/speech.wav", "/w/transcript", "de", 4)).toEqual([
      "-m",
      "/m/ggml-base.bin",
      "-f",
      "/w/speech.wav",
      "-oj",
      "-osrt",
      "-of",
      "/w/transcript",
      "-np",
      "-t",
      "4",
      "-l",
      "de",
    ]);
    expect(() => whisperArgs("-m", "/w/a.wav", "/w/t", undefined, 1)).toThrow();
    expect(
      tool("local_transcribe").input.safeParse({ artifact_id: "a1", language: "en; rm" }).success,
    ).toBe(false);
    expect(
      tool("local_transcribe").input.safeParse({ artifact_id: "a1", language: "-l" }).success,
    ).toBe(false);
    expect(
      tool("local_transcribe").input.safeParse({ artifact_id: "a1", language: "auto" }).success,
    ).toBe(true);
  });

  it("picks a base model first and ignores VAD/encoder files", () => {
    expect(pickModel(["/m/ggml-small.bin", "/m/ggml-base.en.bin", "/m/ggml-base.bin"])).toBe(
      "/m/ggml-base.bin",
    );
    expect(pickModel(["/m/ggml-silero-vad.bin", "/m/readme.txt"])).toBeUndefined();
  });

  const probeWav = JSON.stringify({
    format: { format_name: "wav", duration: "4.2", size: "9" },
    streams: [
      { index: 0, codec_type: "audio", codec_name: "pcm_s16le", sample_rate: "44100", channels: 1 },
    ],
  });

  function whisperEnv(opts: { model?: boolean; missingBinary?: boolean } = {}) {
    const m = recordingSpawn(async (c: SpawnCall) => {
      if (c.binary === "ffprobe") return { stdout: probeWav, stderr: "", exitCode: 0 };
      if (c.binary === "ffmpeg") {
        writeFileSync(c.args[c.args.length - 1] as string, "wav");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (opts.missingBinary)
        throw Object.assign(new Error(`spawn ${c.binary} ENOENT`), { code: "ENOENT" });
      const base = c.args[c.args.indexOf("-of") + 1] as string;
      writeFileSync(`${base}.json`, segmentsJson);
      writeFileSync(`${base}.srt`, "1\n00:00:00,000 --> 00:00:01,500\nHello there.\n");
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const e = makeEnv({ spawn: m.spawn });
    if (opts.model !== false) {
      const model = join(e.dir, "ggml-base.en.bin");
      writeFileSync(model, "m");
      (e.ctx as { settings: Record<string, unknown> }).settings = {
        whisperModelPath: model,
        transcriptionEngine: "whisper.cpp",
      };
    }
    return { m, e };
  }

  it("converts to 16 kHz mono wav, runs whisper-cli and saves an SRT artifact", async () => {
    const { m, e } = whisperEnv();
    env = e;
    const id = e.add("a.wav", "x");
    const r = await call("local_transcribe", { artifact_id: id, language: "en" }, e);
    expect(r.text).toBe("Hello there. General Kenobi.");
    expect(r.srt_artifact.mime).toBe("application/x-subrip");
    expect(readFileSync(e.records.get(r.srt_artifact.id)!.path, "utf8")).toContain("Hello there.");
    const ff = m.calls.find((c) => c.binary === "ffmpeg") as SpawnCall;
    expect(ff.args).toEqual(
      expect.arrayContaining(["-ac", "1", "-ar", "16000", "-protocol_whitelist", "file,pipe"]),
    );
    const w = m.calls.find((c) => c.binary === "whisper-cli") as SpawnCall;
    expect(w.args.slice(0, 2)).toEqual(["-m", join(e.dir, "ggml-base.en.bin")]);
    expect(w.opts?.cwd?.startsWith(`${e.dataDir}/work/`)).toBe(true);
  });

  it("falls back to whisper-cpp, and explains a missing install", async () => {
    const m = recordingSpawn(async (c: SpawnCall) => {
      if (c.binary === "ffprobe") return { stdout: probeWav, stderr: "", exitCode: 0 };
      if (c.binary === "ffmpeg") {
        writeFileSync(c.args[c.args.length - 1] as string, "wav");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (c.binary === "whisper-cli")
        throw Object.assign(new Error("spawn whisper-cli ENOENT"), { code: "ENOENT" });
      const base = c.args[c.args.indexOf("-of") + 1] as string;
      writeFileSync(`${base}.json`, segmentsJson);
      writeFileSync(`${base}.srt`, "1\n");
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    env = makeEnv({ spawn: m.spawn });
    const model = join(env.dir, "m.bin");
    writeFileSync(model, "m");
    (env.ctx as { settings: Record<string, unknown> }).settings = {
      whisperModelPath: model,
      transcriptionEngine: "whisper.cpp",
    };
    const id = env.add("a.wav", "x");
    await call("local_transcribe", { artifact_id: id }, env);
    expect(m.calls.map((c) => c.binary)).toContain("whisper-cpp");
    env.cleanup();

    const none = whisperEnv({ missingBinary: true });
    env = none.e;
    const id2 = env.add("a.wav", "x");
    await expect(call("local_transcribe", { artifact_id: id2 }, env)).rejects.toThrow(
      HINTS.whisper,
    );
  });

  it("gpuFailure: retries signal crashes and GPU backend errors, not bad input", () => {
    expect(gpuFailure({ exitCode: 0, stderr: "metal" })).toBe(false);
    expect(gpuFailure({ exitCode: -1, stderr: "" })).toBe(true);
    expect(gpuFailure({ exitCode: 1, stderr: "ggml_metal_init: error: failed" })).toBe(true);
    expect(gpuFailure({ exitCode: 1, stderr: "CUDA error: out of memory" })).toBe(true);
    expect(gpuFailure({ exitCode: 1, stderr: "error: failed to read WAV file" })).toBe(false);
  });

  it("retries once on the CPU (-ng) when the GPU run crashes", async () => {
    const m = recordingSpawn(async (c: SpawnCall) => {
      if (c.binary === "ffprobe") return { stdout: probeWav, stderr: "", exitCode: 0 };
      if (c.binary === "ffmpeg") {
        writeFileSync(c.args[c.args.length - 1] as string, "wav");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      if (!c.args.includes("-ng"))
        return { stdout: "", stderr: "ggml_metal_init: error: failed to allocate", exitCode: 1 };
      const base = c.args[c.args.indexOf("-of") + 1] as string;
      writeFileSync(`${base}.json`, segmentsJson);
      writeFileSync(`${base}.srt`, "1\n");
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    env = makeEnv({ spawn: m.spawn });
    const model = join(env.dir, "m.bin");
    writeFileSync(model, "m");
    (env.ctx as { settings: Record<string, unknown> }).settings = {
      whisperModelPath: model,
      transcriptionEngine: "whisper.cpp",
    };
    const id = env.add("a.wav", "x");
    const r = await call("local_transcribe", { artifact_id: id }, env);
    expect(r.text).toBe("Hello there. General Kenobi.");
    const runs = m.calls.filter((c) => c.binary === "whisper-cli");
    expect(runs.map((c) => c.args.includes("-ng"))).toEqual([false, true]);
  });

  it("does not retry a non-GPU failure", async () => {
    const m = recordingSpawn(async (c: SpawnCall) => {
      if (c.binary === "ffprobe") return { stdout: probeWav, stderr: "", exitCode: 0 };
      if (c.binary === "ffmpeg") {
        writeFileSync(c.args[c.args.length - 1] as string, "wav");
        return { stdout: "", stderr: "", exitCode: 0 };
      }
      return { stdout: "", stderr: "error: failed to read WAV file", exitCode: 1 };
    });
    env = makeEnv({ spawn: m.spawn });
    const model = join(env.dir, "m.bin");
    writeFileSync(model, "m");
    (env.ctx as { settings: Record<string, unknown> }).settings = {
      whisperModelPath: model,
      transcriptionEngine: "whisper.cpp",
    };
    const id = env.add("a.wav", "x");
    await expect(call("local_transcribe", { artifact_id: id }, env)).rejects.toThrow(
      /failed to read WAV/,
    );
    expect(m.calls.filter((c) => c.binary === "whisper-cli")).toHaveLength(1);
  });

  it("no model: tells the user where to put one, before spawning anything", async () => {
    const { m, e } = whisperEnv({ model: false });
    env = e;
    // Isolate from a real model in the developer's home by pointing the setting at a missing file.
    (e.ctx as { settings: Record<string, unknown> }).settings = {
      whisperModelPath: join(e.dir, "missing.bin"),
      transcriptionEngine: "whisper.cpp",
    };
    const id = e.add("a.wav", "x");
    await expect(call("local_transcribe", { artifact_id: id }, e)).rejects.toThrow(
      /whisper model not found/,
    );
    expect(m.calls).toHaveLength(0);
    (e.ctx as { settings: Record<string, unknown> }).settings = {
      whisperModelPath: "relative/model.bin",
      transcriptionEngine: "whisper.cpp",
    };
    await expect(call("local_transcribe", { artifact_id: id }, e)).rejects.toThrow(/absolute path/);
  });

  it("an input without audio is refused", async () => {
    const { e } = whisperEnv();
    env = e;
    e.ctx.spawn = (async (b: string) =>
      b === "ffprobe"
        ? {
            stdout: JSON.stringify({
              format: { format_name: "mov,mp4", duration: "3" },
              streams: [
                { index: 0, codec_type: "video", codec_name: "h264", width: 10, height: 10 },
              ],
            }),
            stderr: "",
            exitCode: 0,
          }
        : { stdout: "", stderr: "", exitCode: 0 }) as never;
    const id = e.add("v.mp4", "x");
    await expect(call("local_transcribe", { artifact_id: id }, e)).rejects.toThrow(/no audio/);
  });
});

describe("ComfyUI", () => {
  const info = {
    CheckpointLoaderSimple: {
      input: { required: { ckpt_name: [["sd15.safetensors", "sdxl_base.safetensors"]] } },
    },
  };

  it("status lists checkpoints and queue", async () => {
    env = makeEnv({
      fetch: routedFetch({
        "GET /system_stats": () =>
          jsonRes({
            system: { comfyui_version: "0.3.1" },
            devices: [{ name: "mps", type: "mps" }],
          }),
        "GET /queue": () => jsonRes({ queue_running: [1], queue_pending: [] }),
        "GET /object_info/CheckpointLoaderSimple": () => jsonRes(info),
      }),
    });
    const r = await call("local_comfy_status", {}, env);
    expect(r).toMatchObject({
      reachable: true,
      version: "0.3.1",
      queue: { running: 1, pending: 0 },
      checkpoints: ["sd15.safetensors", "sdxl_base.safetensors"],
    });
  });

  it("workflow validation", () => {
    expect(() => validateWorkflow({ nodes: [], links: [] })).toThrow(/API Format/);
    expect(() => validateWorkflow({})).toThrow(/no nodes/);
    expect(() => validateWorkflow({ "1": { inputs: {} } })).toThrow(/class_type/);
    expect(() => validateWorkflow([1])).toThrow();
    expect(validateWorkflow({ "1": { class_type: "X", inputs: {} } })).toBeDefined();
  });

  it("the built-in txt2img graph is wired and prompts stay in data fields", () => {
    const wf = buildTxt2ImgWorkflow({
      checkpoint: "c.safetensors",
      prompt: 'a "cat"; {}',
      negative: "",
      width: 512,
      height: 512,
      n: 2,
      seed: 7,
      steps: 20,
      cfg: 7,
    });
    expect(
      Object.values(wf)
        .map((n) => n.class_type)
        .sort(),
    ).toEqual(
      [
        "CLIPTextEncode",
        "CLIPTextEncode",
        "CheckpointLoaderSimple",
        "EmptyLatentImage",
        "KSampler",
        "SaveImage",
        "VAEDecode",
      ].sort(),
    );
    expect((wf.pos?.inputs as { text: string }).text).toBe('a "cat"; {}');
    expect((wf.latent?.inputs as { batch_size: number }).batch_size).toBe(2);
    expect(sizeFor("sdxl_base.safetensors", "16:9")).toEqual([1344, 768]);
    expect(sizeFor("sd15.safetensors", "9:16")).toEqual([432, 768]);
  });

  it("checkpoint choice: default, exact, unique substring, ambiguous, none", () => {
    const list = ["sd15.safetensors", "sdxl_base.safetensors"];
    expect(pickCheckpoint(list)).toBe("sd15.safetensors");
    expect(pickCheckpoint(list, "sdxl_base.safetensors")).toBe("sdxl_base.safetensors");
    expect(pickCheckpoint(list, "xl")).toBe("sdxl_base.safetensors");
    expect(() => pickCheckpoint(list, "sd")).toThrow(/several/);
    expect(() => pickCheckpoint(list, "flux")).toThrow(/not installed/);
    expect(() => pickCheckpoint([])).toThrow(/models\/checkpoints/);
  });

  function comfyFetch(
    opts: { historyAfter?: number; onInterrupt?: () => void; queueStatus?: number } = {},
  ) {
    const log: string[] = [];
    let polls = 0;
    const submitted: any[] = [];
    const f = routedFetch(
      {
        "GET /object_info/CheckpointLoaderSimple": () => jsonRes(info),
        "POST /prompt": (init) => {
          submitted.push(JSON.parse(String(init?.body)));
          return opts.queueStatus
            ? jsonRes(
                { error: { message: "bad node" }, node_errors: { "3": {} } },
                opts.queueStatus,
              )
            : jsonRes({ prompt_id: "11111111-2222-3333-4444-555555555555" });
        },
        "GET /history/11111111-2222-3333-4444-555555555555": () => {
          polls++;
          if (polls <= (opts.historyAfter ?? 0)) return jsonRes({});
          return jsonRes({
            "11111111-2222-3333-4444-555555555555": {
              status: { status_str: "success", completed: true },
              outputs: {
                save: {
                  images: [
                    { filename: "plughive_00001_.png", subfolder: "", type: "output" },
                    { filename: "tmp.png", subfolder: "", type: "temp" },
                  ],
                },
              },
            },
          });
        },
        "GET /view": () =>
          new Response(new Uint8Array([137, 80, 78, 71]), {
            headers: { "content-type": "image/png" },
          }),
        "POST /interrupt": () => {
          opts.onInterrupt?.();
          return new Response("ok");
        },
      },
      log,
    );
    return { f, log, submitted };
  }

  it("generate_image: discovers a checkpoint, queues, polls, downloads and saves", async () => {
    const c = comfyFetch({ historyAfter: 1 });
    env = makeEnv({ fetch: c.f });
    const r = await call(
      "local_generate_image",
      { prompt: "a red fox", aspect_ratio: "16:9", n: 1, seed: 5 },
      env,
    );
    expect(r).toMatchObject({ model: "sd15.safetensors", seed: 5, width: 768, height: 432 });
    expect(r.artifacts).toHaveLength(1);
    expect(r.artifacts[0].mime).toBe("image/png");
    expect(c.submitted[0].prompt.ckpt.inputs.ckpt_name).toBe("sd15.safetensors");
    expect(c.submitted[0].prompt.pos.inputs.text).toBe("a red fox");
    expect(
      c.log.some((l) =>
        l.startsWith("GET /view?filename=plughive_00001_.png&subfolder=&type=output"),
      ),
    ).toBe(true);
    // the temp output was not downloaded
    expect(c.log.some((l) => l.includes("tmp.png"))).toBe(false);
    expect(env.records.get(r.artifacts[0].id)?.tool).toBe("local_generate_image");
  }, 15_000);

  it("generate_image: no checkpoint and unreachable server give actionable errors", async () => {
    env = makeEnv({
      fetch: routedFetch({
        "GET /object_info/CheckpointLoaderSimple": () =>
          jsonRes({ CheckpointLoaderSimple: { input: { required: { ckpt_name: [[]] } } } }),
      }),
    });
    await expect(call("local_generate_image", { prompt: "x" }, env)).rejects.toThrow(
      /models\/checkpoints/,
    );
    env.cleanup();
    env = makeEnv({
      fetch: (async () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      }) as never,
    });
    await expect(call("local_generate_image", { prompt: "x" }, env)).rejects.toThrow(
      /python main\.py/,
    );
  });

  it("run_workflow: off by default, refused before ComfyUI is contacted (M2)", async () => {
    const c = comfyFetch();
    for (const settings of [
      undefined,
      {},
      { allowRawComfyWorkflows: false },
      { allowRawComfyWorkflows: "true" },
    ]) {
      env = makeEnv({ fetch: c.f, ...(settings ? { settings } : {}) });
      await expect(
        call(
          "local_comfy_run_workflow",
          { workflow: { "1": { class_type: "X", inputs: {} } } },
          env,
        ),
      ).rejects.toThrow(/turned off.*allowRawComfyWorkflows.*dashboard/s);
      env.cleanup();
    }
    expect(c.log).toEqual([]);
    expect(c.submitted).toEqual([]);
    const m = JSON.parse(
      readFileSync(new URL("../../../packs/local/pack.json", import.meta.url), "utf8"),
    );
    expect(m.settings.properties.allowRawComfyWorkflows).toMatchObject({
      type: "boolean",
      default: false,
    });
    // The tool stays listed (and documented) so the user can find the switch.
    expect(tool("local_comfy_run_workflow").description).toMatch(/allowRawComfyWorkflows/);
    env = makeEnv({ fetch: c.f, settings: RAW_ON });
  });

  it("run_workflow: rejects a bad workflow, surfaces ComfyUI's rejection", async () => {
    env = makeEnv({ fetch: refused as never, settings: RAW_ON });
    await expect(
      call("local_comfy_run_workflow", { workflow: { nodes: [] } }, env),
    ).rejects.toThrow(/API Format/);
    env.cleanup();
    const c = comfyFetch({ queueStatus: 400 });
    env = makeEnv({ fetch: c.f, settings: RAW_ON });
    await expect(
      call(
        "local_comfy_run_workflow",
        { workflow: { "3": { class_type: "KSampler", inputs: {} } } },
        env,
      ),
    ).rejects.toThrow(/rejected the workflow.*bad node.*3/s);
  });

  it("run_workflow: cancel interrupts ComfyUI and stops polling", async () => {
    const ac = new AbortController();
    let interrupted = 0;
    const c = comfyFetch({ historyAfter: 1000, onInterrupt: () => interrupted++ });
    env = makeEnv({ fetch: c.f, signal: ac.signal, settings: RAW_ON });
    setTimeout(() => ac.abort(), 150);
    await expect(
      call("local_comfy_run_workflow", { workflow: { "1": { class_type: "X", inputs: {} } } }, env),
    ).rejects.toThrow(/cancelled/);
    expect(interrupted).toBe(1);
  }, 10_000);

  it("run_workflow: reports progress and is marked longRunning", async () => {
    const c = comfyFetch();
    env = makeEnv({ fetch: c.f, settings: RAW_ON });
    const seen: string[] = [];
    (env.ctx as { progress?: (f: number, m?: string) => void }).progress = (_f, m) =>
      seen.push(m ?? "");
    await call(
      "local_comfy_run_workflow",
      { workflow: { "1": { class_type: "X", inputs: {} } } },
      env,
    );
    expect(seen.join("|")).toMatch(/queueing/);
    expect(seen.join("|")).toMatch(/downloading/);
    expect((tool("local_comfy_run_workflow") as { longRunning?: boolean }).longRunning).toBe(true);
  });
});

describe("local_status", () => {
  it("never throws and gives install hints when nothing is installed", async () => {
    env = makeEnv({
      spawn: (async (b: string) => {
        throw Object.assign(new Error(`spawn ${b} ENOENT`), { code: "ENOENT" });
      }) as never,
      fetch: (async () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      }) as never,
      settings: { whisperModelPath: "" },
    });
    // keep the real home's whisper models out of the picture
    (env.ctx as { pack: { dataDir: string } }).pack.dataDir = env.dataDir;
    const r = await call("local_status", {}, env);
    expect(r.backends.ffmpeg.available).toBe(false);
    expect(r.backends.ffmpeg.install_hint).toBe(HINTS.ffmpeg);
    expect(r.backends.whisper.available).toBe(false);
    expect(r.backends.ollama.install_hint).toMatch(/ollama/i);
    expect(r.backends.comfyui.install_hint).toMatch(/ComfyUI/);
    expect(r.backends.kokoro.install_hint).toMatch(/kokoro/i);
    expect(r.usable_tools).toEqual([]);
    expect(r.missing).toEqual(expect.arrayContaining(["ffmpeg", "ollama", "comfyui", "kokoro"]));
  });

  it("reports what is up", async () => {
    env = makeEnv({
      spawn: (async (b: string, args: readonly string[]) => {
        if (args.includes("-filters"))
          return { stdout: " T.. subtitles V->V x\n", stderr: "", exitCode: 0 };
        if (b === "ffmpeg" || b === "ffprobe")
          return { stdout: `${b} version 7.1\nmore`, stderr: "", exitCode: 0 };
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      }) as never,
      fetch: routedFetch({
        "GET /api/version": () => jsonRes({ version: "0.5.1" }),
        "GET /api/tags": () => jsonRes({ models: [{ name: "llama3.2" }] }),
      }),
    });
    const r = await call("local_status", {}, env);
    expect(r.backends.ffmpeg).toMatchObject({
      available: true,
      details: { ffmpeg: "ffmpeg version 7.1", burn_captions_supported: true },
    });
    expect(r.backends.ollama).toMatchObject({
      available: true,
      details: { version: "0.5.1", models: ["llama3.2"] },
    });
    expect(r.usable_tools).toEqual(expect.arrayContaining(["local_media_probe", "local_chat"]));
    expect(r.usable_tools).not.toContain("local_speak");
  });
});

describe("capability functions", () => {
  it("image.generate returns artifacts, model and provider", async () => {
    const comfy = (await import("./harness.js")).routedFetch({
      "GET /object_info/CheckpointLoaderSimple": () =>
        jsonRes({
          CheckpointLoaderSimple: { input: { required: { ckpt_name: [["a.safetensors"]] } } },
        }),
      "POST /prompt": () => jsonRes({ prompt_id: "aaaaaaaa-bbbb" }),
      "GET /history/aaaaaaaa-bbbb": () =>
        jsonRes({
          "aaaaaaaa-bbbb": {
            status: { completed: true, status_str: "success" },
            outputs: { n: { images: [{ filename: "x.png", subfolder: "", type: "output" }] } },
          },
        }),
      "GET /view": () => new Response(new Uint8Array([1])),
    });
    env = makeEnv({ fetch: comfy });
    const r = await capabilities["image.generate"](
      { prompt: "p", aspect_ratio: "1:1", n: 1 },
      env.ctx,
    );
    expect(r).toMatchObject({ model: "a.safetensors", provider: "local" });
    expect(r.artifacts[0]).toEqual({
      id: expect.any(String),
      url: expect.stringContaining("/a/"),
      mime: "image/png",
    });
  });

  it("chat and speech.generate", async () => {
    env = makeEnv({
      settings: { ollamaModel: "m" },
      fetch: routedFetch({
        "POST /api/chat": () =>
          jsonRes({ model: "m", message: { content: "hey" }, prompt_eval_count: 1, eval_count: 2 }),
        "POST /v1/audio/speech": () => new Response(new Uint8Array([9, 9])),
      }),
    });
    expect(
      await capabilities.chat(
        { messages: [{ role: "user", content: "hi" }], max_tokens: 99999 },
        env.ctx,
      ),
    ).toEqual({
      text: "hey",
      usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 },
      model: "m",
      provider: "local",
    });
    const s = await capabilities["speech.generate"]({ text: "hi", format: "mp3" }, env.ctx);
    expect(s.provider).toBe("local");
    expect(s.artifacts).toHaveLength(1);
  });

  it("exports exactly the fifteen capabilities", () => {
    expect(Object.keys(capabilities).sort()).toEqual([
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
    for (const fn of Object.values(capabilities)) expect(fn.length).toBe(2);
  });
});

describe("pack definition and loader", () => {
  const EXPECTED = [
    "local_status",
    "local_media_probe",
    "local_media_convert",
    "local_audio_mix",
    "local_audio_concat",
    "local_video_concat",
    "local_video_mux_audio",
    "local_video_burn_captions",
    "local_ollama_models",
    "local_chat",
    "local_embed",
    "local_transcribe",
    "local_voices",
    "local_speak",
    "local_comfy_status",
    "local_comfy_run_workflow",
    "local_generate_image",
    "local_contact_sheet",
  ];

  it("defines the expected snake_case tools", () => {
    const names = toolNames(pack);
    expect([...names].sort()).toEqual([...EXPECTED].sort());
    for (const n of names) {
      expect(n).toMatch(/^local_[a-z0-9_]+$/);
      expect(n).not.toContain("__");
    }
  });

  it("marks the slow tools longRunning and the quick ones not", () => {
    const long = [
      "local_media_convert",
      "local_audio_mix",
      "local_audio_concat",
      "local_video_concat",
      "local_video_mux_audio",
      "local_video_burn_captions",
      "local_transcribe",
      "local_comfy_run_workflow",
      "local_generate_image",
      "local_contact_sheet",
    ];
    for (const n of EXPECTED)
      expect(Boolean((tool(n) as { longRunning?: boolean }).longRunning), n).toBe(long.includes(n));
  });

  it("manifest: optional HF_TOKEN only, exact spawn list, loopback defaults, library full", () => {
    const m = JSON.parse(
      readFileSync(new URL("../../../packs/local/pack.json", import.meta.url), "utf8"),
    );
    expect(m.secrets).toEqual([expect.objectContaining({ name: "HF_TOKEN", required: false })]);
    expect(m.permissions.spawn).toEqual([
      "ffmpeg",
      "ffprobe",
      "whisper-cli",
      "whisper-cpp",
      "parakeet-mlx",
      "hex",
      "whisperx",
      "realesrgan-ncnn-vulkan",
      "rembg",
      "demucs",
      "tesseract",
      "ocrmypdf",
      "pdftotext",
      "pandoc",
      "soffice",
      "yt-dlp",
    ]);
    expect(m.permissions.localNetwork).toEqual([
      "127.0.0.1:8188",
      "127.0.0.1:11434",
      "127.0.0.1:8880",
    ]);
    expect(m.permissions.library).toBe("full");
    for (const k of [
      "comfyUrl",
      "ollamaUrl",
      "kokoroUrl",
      "whisperModelPath",
      "ollamaModel",
      "kokoroVoice",
      "transcriptionEngine",
      "parakeetModel",
      "hexModel",
      "whisperxModel",
      "ollamaEmbedModel",
    ])
      expect(m.settings.properties[k]).toBeDefined();
    expect(m.settings.properties.transcriptionEngine.enum).toEqual([
      "auto",
      "parakeet",
      "hex",
      "whisperx",
      "whisper.cpp",
    ]);
  });

  it("loads through the real loader and registers every tool", async () => {
    const h = await loadBuiltinPacks();
    try {
      for (const n of EXPECTED) expect(h.registry.get(n), n).toBeDefined();
      expect(h.registry.get("local_generate_image")?.capability).toBe("image.generate");
      expect(h.registry.get("local_generate_image")?.longRunning).toBe(true);
      expect(h.registry.get("local_status")?.longRunning).toBe(false);
    } finally {
      await h.close();
    }
  });
});

void mkdirSync;
