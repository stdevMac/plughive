// The event stream's stream-count limit: the slot must be reserved in the
// same synchronous step as the check, so concurrent requests cannot both
// pass it while the first one is still waiting for its baseline poll.
import type { Server } from "node:http";
import express from "express";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountEventsApi } from "../../src/core/http/events-api.js";

describe("L-3: /api/events reserves the stream slot synchronously", () => {
  let server: Server;
  let base: string;
  let events: ReturnType<typeof mountEventsApi>;
  let releaseGate!: () => void;

  beforeEach(async () => {
    const gate = new Promise<void>((r) => (releaseGate = r));
    const app = express();
    events = mountEventsApi(app, {
      jobs: { list: () => [] },
      // The first stream's baseline poll blocks on the gate, so the first
      // request is still "opening" when the others arrive.
      packs: { listPacks: async () => (await gate, []) },
      maxStreams: 2,
      intervalMs: 60_000,
      pingMs: 60_000,
      logger: { warn() {}, error() {} } as never,
    });
    await new Promise<void>((r) => {
      server = app.listen(0, "127.0.0.1", () => r());
    });
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    base = `http://127.0.0.1:${addr.port}`;
  });

  afterEach(async () => {
    events.close();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it("concurrent requests cannot open more than maxStreams streams", async () => {
    const open = () => fetch(`${base}/api/events`);
    const first = await open();
    expect(first.status).toBe(200);
    expect(events.size()).toBe(1);
    // Both arrive while the first stream's baseline poll is still blocked.
    const [second, third] = await Promise.all([open(), open()]);
    expect(second.status).toBe(200);
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: { code: "TOO_MANY_STREAMS" } });
    expect(events.size()).toBe(2);
    releaseGate();
    await first.body?.cancel();
    await second.body?.cancel();
  });
});
