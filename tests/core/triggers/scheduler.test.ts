// The cron scheduler: slots fire once (also across a restart and with two
// schedulers on one database), missed runs are skipped or caught up once, and
// callbacks are sent once when the job ends.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { TaskEngine, TaskJob } from "../../../src/core/mcp/tasks.js";
import { ToolRegistry } from "../../../src/core/tools/registry.js";
import {
  MAX_ACTIVE_RUNS_PER_TRIGGER,
  TriggerService,
  nextSlot,
  sign,
} from "../../../src/core/triggers/service.js";
import { TriggerStore } from "../../../src/core/triggers/store.js";
import { mockTool } from "../../http/harness.js";

const T0 = Date.parse("2026-03-10T10:00:30Z");
const quiet = { info: () => undefined, warn: () => undefined };

function fakeTasks() {
  const started: Array<{ tool: string; args: Record<string, unknown>; profile?: string }> = [];
  const jobs = new Map<string, TaskJob>();
  const tasks = {
    ttlMs: 1000,
    start(tool: string, args: Record<string, unknown>, opts: { profile?: string } = {}) {
      const id = `job_${started.length + 1}`;
      started.push({ tool, args, ...(opts.profile ? { profile: opts.profile } : {}) });
      jobs.set(id, {
        id,
        tool,
        status: "running",
        input: args,
        checkpoint: {},
        result: null,
        error: null,
        progress: null,
        createdAt: "",
        updatedAt: "",
      });
      return id;
    },
    get: (id: string) => jobs.get(id) ?? null,
    cancel: () => false,
    wait: async () => null,
  } as unknown as TaskEngine;
  return { tasks, started, jobs };
}

function setup(db = new Database(":memory:")) {
  const registry = new ToolRegistry();
  registry.registerPack("workflows", [
    mockTool("wf_report", async (i) => i, {
      input: z.object({ topic: z.string() }),
      longRunning: true,
    }),
  ]);
  const clock = { now: T0 };
  const fake = fakeTasks();
  const sent: Array<{ url: string; init: RequestInit }> = [];
  // A test can hold callback deliveries open by replacing this promise.
  const net: { gate: Promise<void> } = { gate: Promise.resolve() };
  const make = () =>
    new TriggerService({
      store: new TriggerStore(db),
      registry,
      tasks: fake.tasks,
      logger: quiet,
      fetch: async (url, init) => {
        sent.push({ url, init });
        await net.gate;
        return new Response(null, { status: 204 });
      },
      now: () => clock.now,
    });
  const service = make();
  const cron = (schedule: string, extra: Record<string, unknown> = {}) =>
    service.store.create({
      name: "every minute",
      kind: "cron",
      workflow: "wf_report",
      args: { topic: "x" },
      schedule,
      timezone: "UTC",
      catchUp: false,
      useBody: false,
      enabled: true,
      profile: null,
      callback: null,
      nextRunAt: nextSlot(schedule, "UTC", clock.now),
      ...extra,
    }).trigger;
  return { db, registry, clock, service, make, cron, sent, net, ...fake };
}

describe("cron scheduler", () => {
  it("fires a due slot once and schedules the next", () => {
    const s = setup();
    const t = s.cron("* * * * *");
    expect(s.service.runDue()).toEqual([]); // not yet due (next is 10:01)
    s.clock.now = Date.parse("2026-03-10T10:01:05Z");
    expect(s.service.runDue()).toEqual([t.id]);
    expect(s.service.runDue()).toEqual([]); // same slot again: nothing
    expect(s.started).toEqual([{ tool: "wf_report", args: { topic: "x" } }]);
    const after = s.service.store.get(t.id);
    expect(after?.nextRunAt).toBe(Date.parse("2026-03-10T10:02:00Z"));
    expect(after?.lastStatus).toBe("started");
    expect(after?.lastJobId).toBe("job_1");
  });

  it("does not fire the same slot twice after a restart or from a second scheduler", () => {
    const s = setup();
    s.cron("* * * * *");
    s.clock.now = Date.parse("2026-03-10T10:01:05Z");
    const other = s.make(); // a second scheduler on the same database
    expect(s.service.runDue()).toHaveLength(1);
    expect(other.runDue()).toHaveLength(0);
    // "Restart": a new service and store on the same database, same minute.
    const restarted = s.make();
    expect(restarted.runDue()).toHaveLength(0);
    expect(s.started).toHaveLength(1);
  });

  it("skips missed runs, recording that it did", () => {
    const s = setup();
    const t = s.cron("*/5 * * * *");
    s.clock.now = Date.parse("2026-03-10T13:02:00Z"); // daemon was off for 3 hours
    expect(s.service.runDue()).toEqual([]);
    expect(s.started).toHaveLength(0);
    expect(s.service.store.get(t.id)?.nextRunAt).toBe(Date.parse("2026-03-10T13:05:00Z"));
    expect(s.service.store.runs(t.id)[0]).toMatchObject({ status: "skipped", jobId: null });
  });

  it("with catch_up, runs once for all the missed slots", () => {
    const s = setup();
    const t = s.cron("*/5 * * * *", { catchUp: true });
    s.clock.now = Date.parse("2026-03-10T13:02:00Z");
    expect(s.service.runDue()).toEqual([t.id]);
    expect(s.service.runDue()).toEqual([]);
    expect(s.started).toHaveLength(1);
  });

  it("does not fire disabled triggers, and records a workflow that is gone", () => {
    const s = setup();
    const t = s.cron("* * * * *");
    s.service.store.update(t.id, { enabled: false });
    s.clock.now = Date.parse("2026-03-10T10:01:05Z");
    expect(s.service.runDue()).toEqual([]);
    s.service.store.update(t.id, { enabled: true });
    s.registry.unregisterPack("workflows");
    const gone = s.cron("* * * * *", { workflow: "wf_missing" });
    s.clock.now = Date.parse("2026-03-10T10:02:05Z");
    s.service.runDue();
    expect(s.service.store.get(gone.id)).toMatchObject({ lastStatus: "error" });
    expect(s.service.store.get(gone.id)?.lastError).toContain("not loaded");
  });

  it("sends a webhook callback once, signed, after the job ends", async () => {
    const s = setup();
    const t = s.cron("* * * * *", {
      callback: { type: "webhook", url: "https://hooks.example.com/done" },
    });
    s.clock.now = Date.parse("2026-03-10T10:01:05Z");
    s.service.runDue();
    await s.service.sendCallbacks();
    expect(s.sent).toHaveLength(0); // job still running
    const job = s.jobs.get("job_1") as TaskJob;
    job.status = "succeeded";
    job.result = { ok: 1 };
    await s.service.sendCallbacks();
    await s.service.sendCallbacks();
    expect(s.sent).toHaveLength(1);
    const { url, init } = s.sent[0] as { url: string; init: RequestInit };
    expect(url).toBe("https://hooks.example.com/done");
    const headers = init.headers as Record<string, string>;
    const body = String(init.body);
    expect(JSON.parse(body)).toMatchObject({
      trigger_id: t.id,
      job_id: "job_1",
      status: "succeeded",
      result: { ok: 1 },
    });
    const secret = s.service.store.secret(t.id) as string;
    expect(headers["x-plughive-signature"]).toBe(
      sign(secret, headers["x-plughive-timestamp"] as string, body),
    );
    expect(s.service.store.runs(t.id)[0]?.callbackState).toBe("sent");
  });

  it("keeps firing cron slots while a callback endpoint is slow", async () => {
    const s = setup();
    const t = s.cron("* * * * *", {
      callback: { type: "webhook", url: "https://hooks.example.com/slow" },
    });
    let release = () => {};
    s.net.gate = new Promise<void>((r) => {
      release = r;
    });
    s.clock.now = Date.parse("2026-03-10T10:01:05Z");
    await s.service.tick();
    (s.jobs.get("job_1") as TaskJob).status = "succeeded";
    const hanging = s.service.tick(); // the callback hangs
    await Promise.resolve();
    expect(s.sent).toHaveLength(1);
    s.clock.now = Date.parse("2026-03-10T10:02:05Z");
    await s.service.tick(); // returns while the callback still hangs
    expect(s.started).toHaveLength(2);
    expect(s.sent).toHaveLength(1); // one callback pass at a time
    release();
    await hanging;
    expect(s.service.store.runs(t.id).some((r) => r.callbackState === "sent")).toBe(true);
  });

  it("D-M5: refuses a run while the trigger has five that have not finished", () => {
    const s = setup();
    const t = s.cron("* * * * *");
    const minute = (m: number) => {
      s.clock.now = Date.parse(`2026-03-10T10:${String(m).padStart(2, "0")}:05Z`);
      return s.service.runDue();
    };
    for (let m = 1; m <= MAX_ACTIVE_RUNS_PER_TRIGGER; m++) expect(minute(m)).toEqual([t.id]);
    expect(minute(6)).toEqual([]);
    expect(s.started).toHaveLength(MAX_ACTIVE_RUNS_PER_TRIGGER);
    expect(s.service.store.get(t.id)?.lastError).toMatch(/runs that have not finished/);
    (s.jobs.get("job_1") as TaskJob).status = "succeeded";
    expect(minute(7)).toEqual([t.id]);
    expect(s.started).toHaveLength(MAX_ACTIVE_RUNS_PER_TRIGGER + 1);
  });

  it("D-M5: sends several callbacks at once, so one slow receiver does not hold back the rest", async () => {
    const s = setup();
    for (let i = 0; i < 6; i++) {
      s.cron("* * * * *", { callback: { type: "webhook", url: `https://hooks.example.com/${i}` } });
    }
    s.clock.now = Date.parse("2026-03-10T10:01:05Z");
    expect(s.service.runDue()).toHaveLength(6);
    for (const job of s.jobs.values()) job.status = "succeeded";
    let release = () => {};
    s.net.gate = new Promise<void>((r) => {
      release = r;
    });
    const pass = s.service.sendCallbacks();
    await Promise.resolve();
    expect(s.sent).toHaveLength(4);
    release();
    await pass;
    expect(s.sent).toHaveLength(6);
  });

  it("marks a callback interrupted by a restart as failed instead of resending it", async () => {
    const s = setup();
    s.cron("* * * * *", { callback: { type: "telegram" } });
    s.clock.now = Date.parse("2026-03-10T10:01:05Z");
    s.service.runDue();
    const run = s.service.store.pendingCallbacks()[0];
    expect(run).toBeDefined();
    expect(s.service.store.claimCallback(run?.id as number)).toBe(true);
    expect(s.service.store.claimCallback(run?.id as number)).toBe(false);
    expect(s.make().store.failInterruptedCallbacks()).toBe(1);
    // Telegram not loaded: the callback fails with a reason.
    const s2 = setup();
    const t2 = s2.cron("* * * * *", { callback: { type: "telegram" } });
    s2.clock.now = Date.parse("2026-03-10T10:01:05Z");
    s2.service.runDue();
    (s2.jobs.get("job_1") as TaskJob).status = "failed";
    await s2.service.sendCallbacks();
    expect(s2.service.store.runs(t2.id)[0]).toMatchObject({
      callbackState: "failed",
      callbackError: expect.stringContaining("telegram"),
    });
  });
});
