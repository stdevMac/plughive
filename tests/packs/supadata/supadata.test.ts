import { fileURLToPath } from "node:url";
import type { CapabilityError } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import supadataPack, { POLL, provider } from "../../../packs/supadata/index.js";
import { type Route, failure, routerFetch } from "../provider-support.js";

const packDir = fileURLToPath(new URL("../../../packs/supadata", import.meta.url));
const KEY = "sd_test0123456789";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const saved = { ...POLL };
beforeAll(() => {
  POLL.intervalMs = 1;
});
afterAll(() => {
  Object.assign(POLL, saved);
});

const harnesses: TestContext[] = [];
afterEach(async () => {
  for (const t of harnesses.splice(0)) await t.dispose();
});

function setup(
  routes: Route[],
  secrets: Record<string, string> = { SUPADATA_API_KEY: KEY },
  signal?: AbortSignal,
) {
  const fetch = routerFetch(routes);
  const t = createTestContext({ packDir, secrets, fetch });
  harnesses.push(t);
  const progress: [number, string | undefined][] = [];
  const ctx = t.forTool("get_media_transcript", {
    ...(signal ? { signal } : {}),
    progress: (f, m) => progress.push([f, m]),
  });
  return { ctx, fetch, progress };
}

const START = /^GET https:\/\/api\.supadata\.ai\/v1\/transcript\?/;
const JOB = /^GET https:\/\/api\.supadata\.ai\/v1\/transcript\/job-1$/;

describe("supadata pack", () => {
  it("exports one media.transcript provider", () => {
    expect(supadataPack.providers).toEqual([provider]);
    expect(provider).toMatchObject({
      id: "supadata",
      capability: "media.transcript",
      priority: 50,
    });
  });

  it("isConfigured follows SUPADATA_API_KEY", async () => {
    expect(await provider.isConfigured(setup([]).ctx)).toBe(true);
    expect(await provider.isConfigured(setup([], {}).ctx)).toBe(false);
  });

  it("asks for plain text by default and normalizes it", async () => {
    const { ctx, fetch } = setup([
      {
        match: START,
        reply: () =>
          json({ content: " Never gonna give you up ", lang: "en", availableLangs: ["en"] }),
      },
    ]);
    const out = await provider.run({ url: VIDEO, language: "en-US", model: "native" }, ctx);
    const call = fetch.calls[0];
    expect(call?.headers["x-api-key"]).toBe(KEY);
    expect(Object.fromEntries(new URL(call?.url ?? "").searchParams)).toEqual({
      url: VIDEO,
      text: "true",
      lang: "en",
      mode: "native",
    });
    expect(out).toEqual({
      provider: "supadata",
      text: "Never gonna give you up",
      language: "en",
      model: "native",
    });
  });

  it("returns segments in seconds when timestamps are asked for", async () => {
    const { ctx, fetch } = setup([
      {
        match: START,
        reply: () =>
          json({
            content: [
              { text: "Never gonna", offset: 1000, duration: 1500, lang: "en" },
              { text: "give you up", offset: 2500, duration: 500, lang: "en" },
            ],
            lang: "en",
          }),
      },
    ]);
    const out = await provider.run({ url: VIDEO, timestamps: true }, ctx);
    expect(new URL(fetch.calls[0]?.url ?? "").searchParams.get("text")).toBe("false");
    expect(out).toEqual({
      provider: "supadata",
      text: "Never gonna give you up",
      language: "en",
      segments: [
        { start: 1, end: 2.5, text: "Never gonna" },
        { start: 2.5, end: 3, text: "give you up" },
      ],
    });
  });

  it("polls a 202 job until it completes, riding out a transient 503", async () => {
    const { ctx, fetch, progress } = setup([
      { match: START, reply: () => json({ jobId: "job-1" }, 202) },
      { match: JOB, times: 1, reply: () => json({ status: "active" }) },
      { match: JOB, times: 1, reply: () => json({ message: "busy" }, 503) },
      { match: JOB, reply: () => json({ status: "completed", content: "done", lang: "de" }) },
    ]);
    const out = await provider.run({ url: VIDEO, model: "generate" }, ctx);
    expect(out).toEqual({ provider: "supadata", text: "done", language: "de", model: "generate" });
    expect(fetch.calls.map((c) => c.url.split("?")[0])).toEqual([
      "https://api.supadata.ai/v1/transcript",
      "https://api.supadata.ai/v1/transcript/job-1",
      "https://api.supadata.ai/v1/transcript/job-1",
      "https://api.supadata.ai/v1/transcript/job-1",
    ]);
    expect(progress.length).toBeGreaterThan(0);
  });

  it("refuses a job id with spaces or control characters", async () => {
    for (const jobId of ["job 1", "job\u001b[2J", "x".repeat(201)]) {
      const { ctx, fetch } = setup([{ match: START, reply: () => json({ jobId }, 202) }]);
      const e = (await failure(provider.run({ url: VIDEO }, ctx))) as CapabilityError;
      expect(e).toMatchObject({ code: "BAD_RESPONSE" });
      expect(e.message).toBe("Supadata accepted the request but returned no job id.");
      expect(fetch.calls).toHaveLength(1);
    }
  });

  it("a failed job is a non-retryable error that may have charged", async () => {
    const { ctx } = setup([
      { match: START, reply: () => json({ jobId: "job-1" }, 202) },
      { match: JOB, reply: () => json({ status: "failed", error: { message: `oops ${KEY}` } }) },
    ]);
    const e = (await failure(provider.run({ url: VIDEO }, ctx))) as CapabilityError;
    expect(e).toMatchObject({ retryable: false, mayHaveCharged: true, code: "JOB_FAILED" });
    expect(e.message).toBe("Supadata job failed: oops [key]");
  });

  it("gives up after repeated poll failures without retrying elsewhere", async () => {
    const { ctx } = setup([
      { match: START, reply: () => json({ jobId: "job-1" }, 202) },
      { match: JOB, reply: () => json({}, 500) },
    ]);
    expect(await failure(provider.run({ url: VIDEO }, ctx))).toMatchObject({
      retryable: false,
      mayHaveCharged: true,
    });
  });

  it("stops polling when the call is aborted", async () => {
    const ac = new AbortController();
    const { ctx } = setup(
      [
        { match: START, reply: () => json({ jobId: "job-1" }, 202) },
        {
          match: JOB,
          reply: () => {
            ac.abort();
            return json({ status: "queued" });
          },
        },
      ],
      undefined,
      ac.signal,
    );
    await expect(provider.run({ url: VIDEO }, ctx)).rejects.toBeDefined();
    expect(ac.signal.aborted).toBe(true);
  });

  it("206 (no transcript) is a retryable TRANSCRIPT_UNAVAILABLE", async () => {
    const { ctx } = setup([
      {
        match: START,
        reply: () => json({ error: "transcript-unavailable", message: "No transcript" }, 206),
      },
    ]);
    const e = (await failure(provider.run({ url: VIDEO }, ctx))) as CapabilityError;
    expect(e).toMatchObject({ retryable: true, code: "TRANSCRIPT_UNAVAILABLE", status: 206 });
    expect(e.message).toContain("No transcript");
  });

  it("refuses an unknown mode and a missing key retryably", async () => {
    const a = setup([]);
    expect(await failure(provider.run({ url: VIDEO, model: "whisper" }, a.ctx))).toMatchObject({
      retryable: true,
      code: "UNSUPPORTED_OPTION",
    });
    expect(a.fetch.calls).toHaveLength(0);
    expect(await failure(provider.run({ url: VIDEO }, setup([], {}).ctx))).toMatchObject({
      retryable: true,
      code: "NOT_CONFIGURED",
    });
  });

  it("classifies HTTP errors on the first request", async () => {
    const cases: [number, boolean, string][] = [
      [400, false, "PROVIDER_ERROR"],
      [401, true, "AUTH_FAILED"],
      [402, true, "QUOTA_EXCEEDED"],
      [429, true, "RATE_LIMITED"],
      [500, true, "PROVIDER_ERROR"],
    ];
    for (const [status, retryable, code] of cases) {
      const { ctx } = setup([
        { match: START, reply: () => json({ error: "e", message: "bad", details: "d" }, status) },
      ]);
      const e = (await failure(provider.run({ url: VIDEO }, ctx))) as CapabilityError;
      expect(e).toMatchObject({ retryable, code, status });
      expect(e.message).toBe(`Supadata ${status}: bad`);
    }
  });
});

describe("supadata estimate", () => {
  const est = (input: Parameters<NonNullable<typeof provider.estimate>>[0]) =>
    provider.estimate?.(input, setup([]).ctx);
  const url = "https://www.youtube.com/watch?v=abc";

  it("prices a native transcript at 1 credit", async () => {
    expect(await est({ url, model: "native" })).toEqual({
      usd: 0.017,
      basis: "static price table (2026-11): 1 credit, upper plan rate",
    });
  });

  it("has no estimate for auto or generate, whose length is unknown before the call", async () => {
    expect(await est({ url })).toBeNull();
    expect(await est({ url, model: "generate" })).toBeNull();
  });
});
