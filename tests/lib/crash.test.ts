// L11: after an uncaught exception the daemon flushes and exits non-zero.
import { describe, expect, it } from "vitest";
import { createCrashHandler } from "../../src/lib/crash.js";

const tick = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("crash handler", () => {
  it("logs, flushes once and exits with a non-zero code", async () => {
    const events: string[] = [];
    const handler = createCrashHandler({
      log: () => void events.push("log"),
      flush: async () => {
        events.push("flush:start");
        await tick();
        events.push("flush:end");
      },
      exit: (code) => void events.push(`exit:${code}`),
      timeoutMs: 1000,
    });
    handler(new Error("boom"));
    expect(events).toEqual(["log"]);
    await tick(40);
    expect(events).toEqual(["log", "flush:start", "flush:end", "exit:1"]);
  });

  it("a second exception during the flush only logs", async () => {
    const events: string[] = [];
    const handler = createCrashHandler({
      log: () => void events.push("log"),
      flush: async () => {
        events.push("flush");
        await tick(20);
      },
      exit: (code) => void events.push(`exit:${code}`),
      timeoutMs: 1000,
    });
    handler(new Error("one"));
    await tick();
    handler(new Error("two"));
    await tick(60);
    expect(events).toEqual(["log", "flush", "log", "exit:1"]);
  });

  it("exits non-zero when the flush fails, when logging throws, and when the flush hangs", async () => {
    const codes: number[] = [];
    createCrashHandler({
      log: () => {
        throw new Error("logger is gone");
      },
      flush: () => {
        throw new Error("flush failed");
      },
      exit: (code) => void codes.push(code),
      timeoutMs: 1000,
    })(new Error("boom"));
    await tick(20);
    expect(codes).toEqual([1]);

    const hung: number[] = [];
    createCrashHandler({
      log: () => undefined,
      flush: () => new Promise<void>(() => undefined),
      exit: (code) => void hung.push(code),
      timeoutMs: 20,
    })(new Error("boom"));
    await tick(80);
    expect(hung).toEqual([1]);
  });
});
