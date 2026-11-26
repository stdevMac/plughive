import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../src/lib/api";
import { type EventSourceLike, createEventManager } from "../src/lib/events";

class FakeEventSource implements EventSourceLike {
  onerror: ((e: Event) => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(e: Event) => void>>();

  addEventListener(type: string, listener: (e: Event) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close(): void {
    this.closed = true;
  }

  emitError(): void {
    this.onerror?.(new Event("error"));
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createEventManager (D-M14)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("notifies onUnauthorized and stops retrying when /api/info returns 401", async () => {
    vi.useFakeTimers();
    const sources: FakeEventSource[] = [];
    const client = createApi(
      async () =>
        new Response(JSON.stringify({ ok: false, error: { code: "UNAUTHORIZED" } }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const onUnauthorized = vi.fn();
    client.onUnauthorized(onUnauthorized);

    const mgr = createEventManager({
      client,
      createSource: () => {
        const es = new FakeEventSource();
        sources.push(es);
        return es;
      },
    });

    const unsub = mgr.subscribe("job", () => undefined);
    expect(sources).toHaveLength(1);
    sources[0]?.emitError();
    expect(sources[0]?.closed).toBe(true);

    await vi.advanceTimersByTimeAsync(0);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
    expect(mgr.getState()).toBe("closed");

    // Must not keep reconnecting after a 401.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sources).toHaveLength(1);
    unsub();
  });

  it("retries with backoff when the session is still valid or the server is unreachable", async () => {
    vi.useFakeTimers();
    const sources: FakeEventSource[] = [];
    let status = 200;
    const client = createApi(
      async () =>
        new Response(JSON.stringify({ ok: status === 200 }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const onUnauthorized = vi.fn();
    client.onUnauthorized(onUnauthorized);

    const mgr = createEventManager({
      client,
      createSource: () => {
        const es = new FakeEventSource();
        sources.push(es);
        return es;
      },
    });

    const unsub = mgr.subscribe("job", () => undefined);
    expect(sources).toHaveLength(1);

    sources[0]?.emitError();
    await vi.advanceTimersByTimeAsync(0);
    expect(onUnauthorized).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1000);
    expect(sources).toHaveLength(2);

    // Server temporarily returns 503: should still retry.
    status = 503;
    sources[1]?.emitError();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sources).toHaveLength(3);
    unsub();
  });

  it("cancels an in-flight probe and skips retry when closed", async () => {
    let aborted = false;
    const sources: FakeEventSource[] = [];
    const client = createApi(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          });
        }),
    );

    const mgr = createEventManager({
      client,
      createSource: () => {
        const es = new FakeEventSource();
        sources.push(es);
        return es;
      },
    });

    const unsub = mgr.subscribe("job", () => undefined);
    sources[0]?.emitError();
    mgr.close();
    await flush();
    expect(aborted).toBe(true);
    expect(mgr.getState()).toBe("closed");
    unsub();
  });
});
