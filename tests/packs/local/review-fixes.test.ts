// Regression tests for the local pack review findings. Most run the pack through
// createTestContext, so library visibility, the localNetwork allow-list, spawn
// rules and the per-call signal binding of ctx.fetch behave like in the daemon.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PackContext } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it } from "vitest";
import pack from "../../../packs/local/index.js";
import { HINTS, hintsFor } from "../../../packs/local/lib/util.js";
import { canonicalCaptions } from "../../../packs/local/media.js";
import { toolOf } from "../support.js";
import { type Env, jsonRes, makeEnv, routedFetch } from "./harness.js";

const packDir = fileURLToPath(new URL("../../../packs/local", import.meta.url));
const PROMPT = "11111111-2222-3333-4444-555555555555";
const tool = (n: string) => toolOf(pack, n);

const harnesses: TestContext[] = [];
let env: Env | undefined;
afterEach(async () => {
  env?.cleanup();
  env = undefined;
  for (const t of harnesses.splice(0)) await t.dispose();
});

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

/** A ComfyUI that never finishes; `queue` answers GET /queue (null = HTTP 500). */
function comfyHarness(queue: { queue_running: unknown[]; queue_pending: unknown[] } | null) {
  const seen: Seen[] = [];
  const t = createTestContext({
    packDir,
    settings: { allowRawComfyWorkflows: true },
    fetch: async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const u = new URL(String(input));
      const method = init?.method ?? "GET";
      seen.push({
        method,
        path: u.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (method === "POST" && u.pathname === "/prompt") return jsonRes({ prompt_id: PROMPT });
      if (u.pathname === `/history/${PROMPT}`) return jsonRes({});
      if (method === "GET" && u.pathname === "/queue")
        return queue ? jsonRes(queue) : new Response("boom", { status: 500 });
      if (method === "POST") return new Response("ok");
      return new Response("not found", { status: 404 });
    },
  });
  harnesses.push(t);
  return { t, seen };
}

async function toolCtx(
  t: TestContext,
  name: string,
  signal?: AbortSignal,
  withServices = true,
): Promise<PackContext> {
  const services = withServices ? ((await pack.setup?.(t.ctx)) ?? {}) : {};
  return { ...t.forTool(name, signal ? { signal } : {}), ...services } as PackContext;
}

async function runCancelled(t: TestContext, withServices = true): Promise<string> {
  const ac = new AbortController();
  const ctx = await toolCtx(t, "local_comfy_run_workflow", ac.signal, withServices);
  const wf = tool("local_comfy_run_workflow");
  setTimeout(() => ac.abort(), 120);
  try {
    await wf.run(wf.input.parse({ workflow: { "1": { class_type: "X", inputs: {} } } }), ctx);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the workflow to be cancelled");
}

const other = "99999999-8888-7777-6666-555555555555";
const posts = (seen: Seen[], path: string) =>
  seen.filter((s) => s.method === "POST" && s.path === path);

describe("manifest", () => {
  it("reads any library artifact", () => {
    const m = JSON.parse(readFileSync(join(packDir, "pack.json"), "utf8"));
    expect(m.permissions.library).toBe("full");
  });
});

describe("ComfyUI cancel", () => {
  it("interrupts a running prompt by prompt_id through the pack-lifetime fetch", async () => {
    const { t, seen } = comfyHarness({
      queue_running: [[0, PROMPT, {}, {}, []]],
      queue_pending: [[1, other, {}, {}, []]],
    });
    const msg = await runCancelled(t);
    expect(msg).toMatch(/^cancelled\. An interrupt for ComfyUI prompt .* was sent/);
    expect(posts(seen, "/interrupt").map((s) => s.body)).toEqual([{ prompt_id: PROMPT }]);
    expect(posts(seen, "/queue")).toEqual([]);
  }, 10_000);

  it("removes a pending prompt from the queue and interrupts nothing", async () => {
    const { t, seen } = comfyHarness({
      queue_running: [[0, other, {}, {}, []]],
      queue_pending: [[1, PROMPT, {}, {}, []]],
    });
    const msg = await runCancelled(t);
    expect(msg).toMatch(/removed from the queue before it started/);
    expect(posts(seen, "/queue").map((s) => s.body)).toEqual([{ delete: [PROMPT] }]);
    expect(posts(seen, "/interrupt")).toEqual([]);
  }, 10_000);

  it("says nothing was stopped when the prompt is already gone", async () => {
    const { t, seen } = comfyHarness({ queue_running: [], queue_pending: [] });
    const msg = await runCancelled(t);
    expect(msg).toMatch(/no longer queued or running, so nothing was stopped/);
    expect(posts(seen, "/interrupt")).toEqual([]);
  }, 10_000);

  it("an unreadable queue sends a targeted delete and interrupt", async () => {
    const { t, seen } = comfyHarness(null);
    const msg = await runCancelled(t);
    expect(msg).toMatch(/queue could not be read/);
    expect(posts(seen, "/queue").map((s) => s.body)).toEqual([{ delete: [PROMPT] }]);
    expect(posts(seen, "/interrupt").map((s) => s.body)).toEqual([{ prompt_id: PROMPT }]);
  }, 10_000);

  it("without the lifetime fetch the message says the stop did not reach ComfyUI", async () => {
    const { t, seen } = comfyHarness({ queue_running: [[0, PROMPT]], queue_pending: [] });
    const msg = await runCancelled(t, false);
    expect(msg).toMatch(/did not reach ComfyUI, so it may keep running on your GPU/);
    expect(posts(seen, "/interrupt")).toEqual([]);
  }, 10_000);
});

describe("local_comfy_run_workflow metadata", () => {
  it("is open-world and says it runs arbitrary node graphs", () => {
    const t = tool("local_comfy_run_workflow") as {
      description: string;
      annotations?: { openWorldHint?: boolean };
    };
    expect(t.annotations?.openWorldHint).toBe(true);
    expect(t.description).toMatch(/arbitrary .*node graph/i);
    expect(t.description).toMatch(/only pass workflows you trust/);
  });
});

describe("libass hint", () => {
  it("names ffmpeg-full and the PATH step, and local_status uses it", async () => {
    const mac = hintsFor("darwin");
    expect(mac.libass).toMatch(/brew install ffmpeg-full/);
    expect(mac.libass).toMatch(/keg-only/);
    expect(hintsFor("win32").libass).toMatch(/winget install Gyan\.FFmpeg/);
    expect(hintsFor("linux").libass).toMatch(/apt/);
    expect(hintsFor("win32").ffmpeg).not.toMatch(/brew/);
    expect(hintsFor("linux").whisper).not.toMatch(/brew/);
    env = makeEnv({
      spawn: (async (_b: string, args: readonly string[]) => {
        if (args.includes("-filters"))
          return { stdout: " ... drawtext V->V\n", stderr: "", exitCode: 0 };
        return { stdout: "ffmpeg version 8.0\n", stderr: "", exitCode: 0 };
      }) as never,
      fetch: (async () => {
        throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
      }) as never,
    });
    const st = tool("local_status");
    const r = (await st.run({}, env.ctx)) as {
      backends: { ffmpeg: { install_hint: string | null } };
    };
    expect(r.backends.ffmpeg.install_hint).toBe(HINTS.libass);
  });
});

// ---------------------------------------------------------------------------
// captions confinement
// ---------------------------------------------------------------------------

const probeAv = {
  format: { format_name: "mov,mp4,m4a,3gp,3g2,mj2", duration: "10.0", size: "1000" },
  streams: [
    { index: 0, codec_type: "video", codec_name: "h264", width: 1280, height: 720 },
    { index: 1, codec_type: "audio", codec_name: "aac", sample_rate: "44100", channels: 2 },
  ],
};

function captionsHarness() {
  const burns: Array<{ args: readonly string[]; srt: string }> = [];
  const t = createTestContext({
    packDir,
    spawn: async (binary, args, opts) => {
      if (binary === "ffprobe") return { stdout: JSON.stringify(probeAv), stderr: "", exitCode: 0 };
      if (args.includes("-filters"))
        return { stdout: " T.. subtitles  V->V  Render text subtitles\n", exitCode: 0 };
      const cwd = String(opts.cwd);
      burns.push({ args, srt: readFileSync(join(cwd, "captions.srt"), "utf8") });
      writeFileSync(args[args.length - 1] as string, "out");
      return { stdout: "", stderr: "", exitCode: 0 };
    },
  });
  harnesses.push(t);
  t.library?.seed({
    id: "v_fal",
    kind: "video",
    mime: "video/mp4",
    bytes: "x",
    tool: "fal/fal_run",
  });
  return { t, burns };
}

async function burn(t: TestContext, captions: string) {
  t.library?.seed({
    id: "c_fal",
    kind: "other",
    mime: "text/plain",
    bytes: captions,
    tool: "fal/fal_run",
  });
  const b = tool("local_video_burn_captions");
  return b.run(
    b.input.parse({ video_artifact_id: "v_fal", captions_artifact_id: "c_fal" }),
    t.forTool("local_video_burn_captions"),
  );
}

describe("captions confinement", () => {
  it("refuses an .srt whose content is an ffconcat list, before ffmpeg runs", async () => {
    const { t, burns } = captionsHarness();
    await expect(burn(t, "ffconcat version 1.0\nfile other/secret.vtt\n")).rejects.toThrow(
      /no valid SRT or WebVTT cues/,
    );
    expect(burns).toEqual([]);
  });

  it("writes only re-serialized SRT cues for artifacts another pack saved", async () => {
    const { t, burns } = captionsHarness();
    const vtt =
      "WEBVTT\n\nNOTE ffconcat version 1.0\n\n00:01.000 --> 00:02.500 align:start\n{\\an8}Hello {there}\n\nfile other/secret.vtt\n";
    await burn(t, vtt);
    expect(burns).toHaveLength(1);
    expect(burns[0]?.srt).toBe("1\n00:00:01,000 --> 00:00:02,500\nHello\n");
    expect(burns[0]?.args.join(" ")).not.toContain("secret");
  });

  it("canonicalCaptions drops non-cue blocks and backwards cues", () => {
    expect(
      canonicalCaptions(
        "1\n00:00:05,000 --> 00:00:04,000\nback\n\n2\n00:00:00,000 --> 00:00:01,000\nok\n",
      ),
    ).toBe("1\n00:00:00,000 --> 00:00:01,000\nok\n");
    expect(() => canonicalCaptions("ffconcat version 1.0\nfile a.mp4\n")).toThrow(/no valid/);
  });
});

// ---------------------------------------------------------------------------
// kernel deadlines on every backend fetch
// ---------------------------------------------------------------------------

describe("ctx.fetch timeoutMs", () => {
  function recording(routes: Parameters<typeof routedFetch>[0]) {
    const inits: Array<{ path: string; timeoutMs: unknown }> = [];
    const inner = routedFetch(routes);
    const f = (async (url: string | URL | Request, init?: RequestInit & { timeoutMs?: number }) => {
      inits.push({ path: new URL(String(url)).pathname, timeoutMs: init?.timeoutMs });
      return inner(url, init);
    }) as PackContext["fetch"];
    return { f, inits };
  }
  const allTimed = (inits: Array<{ timeoutMs: unknown }>) =>
    inits.length > 0 && inits.every((i) => typeof i.timeoutMs === "number" && i.timeoutMs > 0);

  it("Ollama chat passes a kernel deadline", async () => {
    const r = recording({
      "POST /api/chat": () => jsonRes({ model: "m", message: { content: "ok" } }),
    });
    env = makeEnv({ fetch: r.f, settings: { ollamaModel: "m" } });
    const c = tool("local_chat");
    await c.run(c.input.parse({ messages: [{ role: "user", content: "hi" }] }), env.ctx);
    expect(allTimed(r.inits)).toBe(true);
  });

  it("Kokoro speak passes a kernel deadline", async () => {
    const r = recording({
      "POST /v1/audio/speech": () =>
        new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
    });
    env = makeEnv({ fetch: r.f });
    const s = tool("local_speak");
    await s.run(s.input.parse({ text: "hi" }), env.ctx);
    expect(allTimed(r.inits)).toBe(true);
  });

  it("ComfyUI queue, poll and download pass a kernel deadline", async () => {
    const r = recording({
      "POST /prompt": () => jsonRes({ prompt_id: PROMPT }),
      [`GET /history/${PROMPT}`]: () =>
        jsonRes({
          [PROMPT]: {
            status: { status_str: "success", completed: true },
            outputs: { s: { images: [{ filename: "a.png", subfolder: "", type: "output" }] } },
          },
        }),
      "GET /view": () => new Response(new Uint8Array([137, 80, 78, 71])),
    });
    env = makeEnv({ fetch: r.f, settings: { allowRawComfyWorkflows: true } });
    const wf = tool("local_comfy_run_workflow");
    await wf.run(wf.input.parse({ workflow: { "1": { class_type: "X", inputs: {} } } }), env.ctx);
    expect(r.inits.map((i) => i.path)).toEqual(["/prompt", `/history/${PROMPT}`, "/view"]);
    expect(allTimed(r.inits)).toBe(true);
  });
});
