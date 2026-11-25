// A failed paid submit must not invite a blind resubmit, and a submit the
// provider accepted must not lose its job id (review finding M3).
import { describe, expect, it } from "vitest";
import { OpenRouterClient } from "../../packs/openrouter/client.js";
import { ReplicateClient } from "../../packs/replicate/client.js";

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function recorder(handler: Handler) {
  const calls: { url: string; method: string }[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET" });
    return handler(url, init);
  }) as never;
  return { calls, fetchFn };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const spec = { official: true, version: null } as never;
const ref = { id: "owner/model" } as never;

describe("replicate prediction create", () => {
  it("a 5xx warns the prediction may be billed instead of saying retry later", async () => {
    const { calls, fetchFn } = recorder(() => json({ detail: "boom" }, 500));
    const err = await new ReplicateClient(fetchFn)
      .create(spec, ref, { prompt: "x" }, "t", { cancelAfterSeconds: 60 })
      .catch((e: Error) => e);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect((err as Error).message).toMatch(/may have started and be billed/);
    expect((err as Error).message).not.toMatch(/retry later/);
  });

  it("keeps a usable prediction id when the returned URLs are unexpected", async () => {
    const { fetchFn } = recorder(() =>
      json(
        {
          id: "abc123",
          status: "starting",
          urls: { get: "https://evil.example/x", cancel: "nope" },
        },
        201,
      ),
    );
    const p = await new ReplicateClient(fetchFn).create(spec, ref, { prompt: "x" }, "t", {
      cancelAfterSeconds: 60,
    });
    expect(p.id).toBe("abc123");
    expect(p.getUrl).toBe("https://api.replicate.com/v1/predictions/abc123");
    expect(p.cancelUrl).toBe("https://api.replicate.com/v1/predictions/abc123/cancel");
  });

  it("names the dashboard when the accepted prediction has no id", async () => {
    const { fetchFn } = recorder(() => json({ status: "starting" }, 201));
    const err = await new ReplicateClient(fetchFn)
      .create(spec, ref, { prompt: "x" }, "t", { cancelAfterSeconds: 60 })
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/returned no usable id/);
    expect((err as Error).message).toMatch(/before running it again/);
  });
});

describe("openrouter paid requests", () => {
  it("a 5xx on a chat request says it may be charged, not try again", async () => {
    const { calls, fetchFn } = recorder(() => json({ error: { message: "upstream" } }, 502));
    const err = await new OpenRouterClient(fetchFn)
      .chat({ model: "m" }, "k")
      .catch((e: Error) => e);
    expect(calls).toHaveLength(1);
    expect((err as Error).message).toMatch(/may already have been processed and charged/);
    expect((err as Error).message).not.toMatch(/Try again/);
  });

  it("a network failure on a paid POST says it may be charged", async () => {
    const fetchFn = (async () => {
      throw new Error("socket hang up");
    }) as never;
    const err = await new OpenRouterClient(fetchFn)
      .images({ model: "m" }, "k")
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/may already have been processed and charged/);
  });

  it("an unreadable body after a paid request does not say try again", async () => {
    const { fetchFn } = recorder(() => new Response("not json", { status: 200 }));
    const err = await new OpenRouterClient(fetchFn)
      .transcribe({ model: "m" }, "k")
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/may already have been processed and charged/);
    expect((err as Error).message).not.toMatch(/Try again/);
  });

  it("a video submit with no usable job id points at the activity page", async () => {
    const { fetchFn } = recorder(() => json({ status: "pending" }));
    const err = await new OpenRouterClient(fetchFn)
      .submitVideo({ model: "m" }, "k")
      .catch((e: Error) => e);
    expect((err as Error).message).toMatch(/no usable job id/);
    expect((err as Error).message).not.toMatch(/Try again/);
  });

  it("a 5xx on a free catalog read still says try again later", async () => {
    const { fetchFn } = recorder(() => json({}, 503));
    const err = await new OpenRouterClient(fetchFn).catalog("image").catch((e: Error) => e);
    expect((err as Error).message).toMatch(/Try again later/);
  });
});
