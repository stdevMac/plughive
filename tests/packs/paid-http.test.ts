// tests/packs/paid-http.test.ts
//
// The metered-request policy shared by packs/{growth,seo,web}. The three
// copies must stay byte-identical (packs cannot import each other).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  MeteredHttpError,
  isPreDispatchFailure,
  meteredRequest,
  parseRetryAfter,
  readCappedText,
  shortError,
} from "../../packs/growth/paid-http.js";

const root = fileURLToPath(new URL("../../", import.meta.url));

describe("paid-http.ts copies", () => {
  it("are byte-identical across growth, seo and web", () => {
    const read = (p: string) => readFileSync(`${root}packs/${p}/paid-http.ts`, "utf8");
    const growth = read("growth");
    expect(read("seo")).toBe(growth);
    expect(read("web")).toBe(growth);
  });
});

describe("parseRetryAfter", () => {
  it("reads delta-seconds and HTTP dates, rejects junk", () => {
    expect(parseRetryAfter("0")).toBe(0);
    expect(parseRetryAfter("2.5")).toBe(2500);
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfter("Thu, 01 Jan 2026 00:00:10 GMT", now)).toBe(10_000);
    expect(parseRetryAfter("Wed, 31 Dec 2025 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter(null)).toBeNull();
    expect(parseRetryAfter("soon")).toBeNull();
    expect(parseRetryAfter("-5")).toBeNull();
  });
});

describe("isPreDispatchFailure", () => {
  it("finds connect-phase codes anywhere in the cause chain", () => {
    const refused = Object.assign(new Error("connect"), { code: "ECONNREFUSED" });
    expect(isPreDispatchFailure(refused)).toBe(true);
    expect(isPreDispatchFailure(new TypeError("fetch failed", { cause: refused }))).toBe(true);
    expect(isPreDispatchFailure({ reason: "dns_failure" })).toBe(true);
  });
  it("treats resets, timeouts and unknown errors as possibly sent", () => {
    expect(isPreDispatchFailure(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(false);
    expect(isPreDispatchFailure(Object.assign(new Error("t"), { name: "TimeoutError" }))).toBe(
      false,
    );
    expect(isPreDispatchFailure(new TypeError("fetch failed"))).toBe(false);
    expect(isPreDispatchFailure(null)).toBe(false);
  });
});

describe("readCappedText", () => {
  it("refuses a declared length over the cap", async () => {
    const res = new Response("x".repeat(10), { headers: { "content-length": "10" } });
    await expect(readCappedText(res, 5, "T")).rejects.toThrow(/larger than 5 bytes/);
  });
  it("stops reading a streamed body past the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(4));
      },
    });
    await expect(readCappedText(new Response(stream), 64, "T")).rejects.toThrow(/larger than 64/);
  });
  it("returns a body under the cap", async () => {
    expect(await readCappedText(new Response("hello"), 64, "T")).toBe("hello");
  });
});

describe("shortError", () => {
  it("pulls only the provider's error field, on one line and capped", () => {
    expect(shortError(JSON.stringify({ error: "bad\nkey" }))).toBe("bad key");
    expect(shortError(JSON.stringify({ error: { message: "nested" } }))).toBe("nested");
    expect(shortError(JSON.stringify({ message: "m".repeat(300) }))).toHaveLength(161);
    expect(shortError(JSON.stringify({ person: { email: "a@b.c" } }))).toBe("");
    expect(shortError("<html>secret page</html>")).toBe("");
  });
});

describe("meteredRequest", () => {
  const base = { url: "https://api.test/x", label: "T", endpoint: "/x", retryBaseMs: 1 };

  it("does not retry a paid 429 whose Retry-After exceeds the cap", async () => {
    const f = vi.fn(
      async () => new Response("{}", { status: 429, headers: { "retry-after": "60" } }),
    );
    const err = await meteredRequest({ ...base, fetch: f as never, billing: "paid" }).catch(
      (e) => e,
    );
    expect(err).toBeInstanceOf(MeteredHttpError);
    expect(err.message).toMatch(/rate limited \(429\).*Retry after about 60 s/);
    expect(err.mayHaveCharged).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("marks a paid 5xx as possibly charged and not retryable", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 500 }));
    const err = await meteredRequest({ ...base, fetch: f as never, billing: "paid" }).catch(
      (e) => e,
    );
    expect(err.mayHaveCharged).toBe(true);
    expect(err.retryable).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("caps free attempts at 5 whatever the caller asks", async () => {
    const f = vi.fn(async () => new Response("{}", { status: 503 }));
    await expect(
      meteredRequest({ ...base, fetch: f as never, billing: "free", maxAttempts: 50 }),
    ).rejects.toThrow(/returned 503/);
    expect(f).toHaveBeenCalledTimes(5);
  });

  it("an abort during the backoff sleep ends the call without another attempt", async () => {
    const ac = new AbortController();
    const f = vi.fn(async () => {
      setTimeout(() => ac.abort(new Error("cancelled by caller")), 10);
      return new Response("{}", { status: 503 });
    });
    const started = Date.now();
    await expect(
      meteredRequest({
        ...base,
        fetch: f as never,
        billing: "free",
        retryBaseMs: 60_000,
        signal: ac.signal,
      }),
    ).rejects.toThrow(/cancelled by caller/);
    expect(f).toHaveBeenCalledTimes(1);
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("never calls fetch when the signal is already aborted", async () => {
    const f = vi.fn();
    const ac = new AbortController();
    ac.abort();
    await expect(
      meteredRequest({ ...base, fetch: f as never, billing: "paid", signal: ac.signal }),
    ).rejects.toBeDefined();
    expect(f).not.toHaveBeenCalled();
  });
});
