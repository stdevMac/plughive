// Regression tests for the Gemini review findings. They run the pack through
// createTestContext, so library visibility, host permissions and the per-call
// signal binding of ctx.fetch behave like in the daemon.
import { fileURLToPath } from "node:url";
import type { PackContext } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it } from "vitest";
import { GeminiClient } from "../../../packs/gemini/client.js";
import geminiPack from "../../../packs/gemini/index.js";
import { clearModelCache } from "../../../packs/gemini/ops.js";
import { toolOf } from "../support.js";

const packDir = fileURLToPath(new URL("../../../packs/gemini", import.meta.url));
const b64 = (s: string) => Buffer.from(s).toString("base64");
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

interface Seen {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
  timeoutMs?: number;
}

const harnesses: TestContext[] = [];
afterEach(async () => {
  clearModelCache();
  for (const t of harnesses.splice(0)) await t.dispose();
});

/** A fetch that honours its abort signal the way the real one does. */
function harness(handler: (c: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const t = createTestContext({
    packDir,
    secrets: { GEMINI_API_KEY: "AIzaTESTKEY0123456789abcdefghijk" },
    fetch: async (input, init) => {
      if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
      const c: Seen = {
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : null,
      };
      seen.push(c);
      return handler(c);
    },
  });
  harnesses.push(t);
  return { t, seen };
}

/** The ctx a tool gets in the daemon: the per-call context plus setup() services. */
async function toolCtx(
  t: TestContext,
  name: string,
  signal?: AbortSignal,
  withServices = true,
): Promise<PackContext> {
  const services = withServices ? ((await geminiPack.setup?.(t.ctx)) ?? {}) : {};
  return { ...t.forTool(name, signal ? { signal } : {}), ...services } as PackContext;
}

const done = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  id: "int_1",
  status: "completed",
  model: "m",
  steps: [{ type: "model_output", content }],
  usage: { total_input_tokens: 10, total_output_tokens: 1120 },
  ...extra,
});

describe("library permission", () => {
  it("image_inputs can use an artifact another pack saved", async () => {
    const { t, seen } = harness(() =>
      json(done([{ type: "image", mime_type: "image/png", data: b64("P") }])),
    );
    t.library?.seed({
      id: "a_fal",
      kind: "image",
      mime: "image/png",
      bytes: "PNG",
      tool: "fal/fal_run",
    });
    const ctx = await toolCtx(t, "gemini_generate_image");
    await toolOf(geminiPack, "gemini_generate_image").run(
      { prompt: "edit", image_inputs: ["a_fal"] },
      ctx,
    );
    const input = seen[0]?.body?.input as { type: string; data?: string }[];
    expect(input[1]).toMatchObject({ type: "image", data: b64("PNG") });
  });

  it("transcribe can read audio another pack saved", async () => {
    const { t } = harness(() => json(done([{ type: "text", text: "hello" }])));
    t.library?.seed({
      id: "a_au",
      kind: "audio",
      mime: "audio/mpeg",
      bytes: "MP3",
      tool: "fal/fal_run",
    });
    const ctx = await toolCtx(t, "gemini_transcribe");
    const out = (await toolOf(geminiPack, "gemini_transcribe").run(
      { artifact_id: "a_au" },
      ctx,
    )) as {
      text: string;
    };
    expect(out.text).toBe("hello");
  });
});

describe("cancel reaches Gemini", () => {
  const running = (ac: AbortController) => (c: Seen) => {
    if (c.url.endsWith("/cancel")) return json({});
    if (c.method === "POST") return json({ id: "int_v", status: "in_progress" });
    ac.abort();
    return json({ id: "int_v", status: "in_progress" });
  };

  it("sends the cancel through the pack-lifetime fetch after the call was aborted", async () => {
    const { generateVideo } = await import("../../../packs/gemini/ops.js");
    const ac = new AbortController();
    const { t, seen } = harness(running(ac));
    const ctx = await toolCtx(t, "gemini_generate_video", ac.signal);
    const err = await generateVideo({ prompt: "x" }, ctx, "t", { pollMs: 20 }).catch((e) => e);
    expect(String(err.message)).toMatch(/cancel request for interaction int_v was sent/);
    expect(err.interactionId).toBe("int_v");
    expect(
      seen.some((c) => c.method === "POST" && c.url.endsWith("/interactions/int_v/cancel")),
    ).toBe(true);
  });

  it("says truthfully when the cancel could not be sent", async () => {
    // Without the setup() service the cancel would ride the aborted per-call fetch.
    const { generateVideo } = await import("../../../packs/gemini/ops.js");
    const ac = new AbortController();
    const { t, seen } = harness(running(ac));
    const ctx = await toolCtx(t, "gemini_generate_video", ac.signal, false);
    const err = await generateVideo({ prompt: "x" }, ctx, "t", { pollMs: 20 }).catch((e) => e);
    expect(String(err.message)).toMatch(/int_v did not reach Gemini.*billed/);
    expect(seen.some((c) => c.url.endsWith("/cancel"))).toBe(false);
  });
});

describe("long jobs name their interaction id", () => {
  it("a timeout keeps the job, names the id and points at gemini_get_interaction", async () => {
    const { t, seen } = harness(() => json({ id: "int_slow", status: "in_progress" }));
    const ctx = await toolCtx(t, "gemini_generate_video");
    const err = await new GeminiClient(ctx)
      .interact({ model: "m", input: "x" }, { background: true, pollMs: 5, maxWaitMs: 30 })
      .catch((e) => e);
    expect(err.message).toMatch(/int_slow/);
    expect(err.message).toMatch(/gemini_get_interaction/);
    expect(err.message).not.toMatch(/retry/i);
    expect(seen.some((c) => c.url.endsWith("/cancel"))).toBe(false);
  });

  it("a failed status names the id", async () => {
    const { t } = harness((c) =>
      c.method === "POST"
        ? json({ id: "int_f", status: "in_progress" })
        : json({ id: "int_f", status: "failed" }),
    );
    const ctx = await toolCtx(t, "gemini_generate_music");
    await expect(
      new GeminiClient(ctx).interact({ model: "m", input: "x" }, { background: true, pollMs: 5 }),
    ).rejects.toThrow(/int_f.*failed/);
  });

  it("rides out a transient poll error", async () => {
    let gets = 0;
    const { t } = harness((c) => {
      if (c.method === "POST") return json({ id: "int_t", status: "in_progress" });
      gets++;
      if (gets === 1) return json({ error: { message: "x" } }, 503);
      return json(done([{ type: "text", text: "ok" }], { id: "int_t" }));
    });
    const ctx = await toolCtx(t, "gemini_generate_music");
    const it = await new GeminiClient(ctx).interact(
      { model: "m" },
      { background: true, pollMs: 5 },
    );
    expect(it.status).toBe("completed");
  });

  it("video results carry the interaction id", async () => {
    const { generateVideo } = await import("../../../packs/gemini/ops.js");
    const { t } = harness(() =>
      json(done([{ type: "video", mime_type: "video/mp4", data: b64("MP4") }], { id: "int_ok" })),
    );
    const ctx = await toolCtx(t, "gemini_generate_video");
    const out = await generateVideo({ prompt: "x" }, ctx);
    expect(out.interaction_id).toBe("int_ok");
  });
});

describe("gemini_get_interaction", () => {
  it("collects a finished music job without resubmitting", async () => {
    const { t, seen } = harness(() =>
      json(
        done(
          [
            { type: "audio", mime_type: "audio/mpeg", data: b64("MP3") },
            { type: "text", text: "lyrics" },
          ],
          { id: "int_m", model: "lyria-3.5" },
        ),
      ),
    );
    const ctx = await toolCtx(t, "gemini_get_interaction");
    const out = (await toolOf(geminiPack, "gemini_get_interaction").run(
      { interaction_id: "int_m" },
      ctx,
    )) as { status: string; artifacts: { mime: string }[]; lyrics: string };
    expect(out.status).toBe("completed");
    expect(out.artifacts[0]?.mime).toBe("audio/mpeg");
    expect(out.lyrics).toBe("lyrics");
    expect(seen.map((c) => `${c.method} ${new URL(c.url).pathname}`)).toEqual([
      "GET /v1beta/interactions/int_m",
    ]);
    expect(t.library?.all()[0]).toMatchObject({ tool: "gemini/gemini_get_interaction" });
  });

  it("collects a finished video job", async () => {
    const { t } = harness(() =>
      json(done([{ type: "video", mime_type: "video/mp4", data: b64("MP4") }], { id: "int_v" })),
    );
    const ctx = await toolCtx(t, "gemini_get_interaction");
    const out = (await toolOf(geminiPack, "gemini_get_interaction").run(
      { interaction_id: "int_v" },
      ctx,
    )) as { artifacts: { mime: string }[] };
    expect(out.artifacts[0]?.mime).toBe("video/mp4");
  });

  it("reports a job that is still running", async () => {
    const { t } = harness(() => json({ id: "int_r", status: "in_progress" }));
    const ctx = await toolCtx(t, "gemini_get_interaction");
    const out = (await toolOf(geminiPack, "gemini_get_interaction").run(
      { interaction_id: "int_r" },
      ctx,
    )) as { status: string; interaction_id: string };
    expect(out).toMatchObject({ status: "in_progress", interaction_id: "int_r" });
  });
});

describe("n > 1 images", () => {
  it("keeps the images already made when a later one fails", async () => {
    let n = 0;
    const { t } = harness(() => {
      n++;
      if (n === 2) return json({ error: { message: "boom" } }, 500);
      return json(done([{ type: "image", mime_type: "image/png", data: b64("P") }]));
    });
    const ctx = await toolCtx(t, "gemini_generate_image");
    const out = (await toolOf(geminiPack, "gemini_generate_image").run(
      { prompt: "x", n: 3 },
      ctx,
    )) as { artifacts: unknown[]; note: string };
    expect(out.artifacts).toHaveLength(1);
    expect(out.note).toMatch(/Only 1 of 3 images/);
    expect(t.library?.all()).toHaveLength(1);
  });

  it("still throws when the first image fails", async () => {
    const { t } = harness(() => json({ error: { message: "boom" } }, 500));
    const ctx = await toolCtx(t, "gemini_generate_image");
    await expect(
      toolOf(geminiPack, "gemini_generate_image").run({ prompt: "x", n: 2 }, ctx),
    ).rejects.toThrow(/server error/);
  });
});

describe("costs are estimates", () => {
  it("never records an estimate as the library's actual cost", async () => {
    const { t } = harness(() =>
      json(done([{ type: "image", mime_type: "image/png", data: b64("P") }])),
    );
    const ctx = await toolCtx(t, "gemini_generate_image");
    const out = (await toolOf(geminiPack, "gemini_generate_image").run(
      { prompt: "x" },
      ctx,
    )) as Record<string, unknown>;
    expect(out.cost_usd).toBeUndefined();
    expect(out.cost_usd_estimate).toBeGreaterThan(0);
    const row = t.library?.all()[0];
    expect(row?.costUsd).toBeNull();
    expect(row?.meta?.cost_usd_estimate).toBeGreaterThan(0);
  });
});

describe("annotations and timeouts", () => {
  it("gemini_chat is a paid call, not read-only", () => {
    const a = toolOf(geminiPack, "gemini_chat").annotations as { readOnlyHint?: boolean };
    expect(a.readOnlyHint).toBe(false);
  });

  it("passes an explicit timeoutMs on every request (already on main)", async () => {
    const timeouts: (number | undefined)[] = [];
    const { t } = harness(() => json(done([{ type: "text", text: "hi" }])));
    const ctx = await toolCtx(t, "gemini_chat");
    const spy = {
      ...ctx,
      fetch: (u: string | URL | Request, i?: { timeoutMs?: number }) => {
        timeouts.push(i?.timeoutMs);
        return ctx.fetch(u, i);
      },
    } as PackContext;
    await toolOf(geminiPack, "gemini_chat").run(
      { messages: [{ role: "user", content: "hi" }] },
      spy,
    );
    expect(timeouts).toEqual([180_000]);
  });
});

describe("paid interaction submit errors do not invite a resubmit (M3)", () => {
  it("a 5xx on the create says it may be billed, not retry", async () => {
    const { t, seen } = harness(() => json({ error: { message: "boom" } }, 503));
    const ctx = await toolCtx(t, "gemini_generate_video");
    const err = await new GeminiClient(ctx).interact({ model: "m", input: "x" }).catch((e) => e);
    expect(seen.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(err.message).toMatch(/may already have been processed and billed/);
    expect(err.message).not.toMatch(/retry/i);
  });

  it("a non-JSON reply to the create says it may be billed", async () => {
    const { t } = harness(() => new Response("<html>", { status: 200 }));
    const ctx = await toolCtx(t, "gemini_generate_video");
    const err = await new GeminiClient(ctx).interact({ model: "m", input: "x" }).catch((e) => e);
    expect(err.message).toMatch(/may already have been processed and billed/);
    expect(err.message).not.toMatch(/retry/i);
  });

  it("a running interaction with no id points at AI Studio", async () => {
    const { t } = harness(() => json({ status: "in_progress" }));
    const ctx = await toolCtx(t, "gemini_generate_video");
    const err = await new GeminiClient(ctx).interact({ model: "m", input: "x" }).catch((e) => e);
    expect(err.message).toMatch(/returned no interaction id/);
    expect(err.message).toMatch(/before running it again/);
  });
});
