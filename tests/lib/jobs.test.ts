import { chmodSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
// tests/lib/jobs.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Redactor } from "../../src/core/secrets/redactor.js";
import {
  DEFAULT_HANDLER_GRACE_MS,
  DEFAULT_MAX_QUEUED_JOBS,
  INTERRUPTED_MESSAGE,
  JOB_RETENTION_MS,
  JobLimitError,
  JobQueue,
  JobTerminalError,
  MAX_FINISHED_JOBS,
  MAX_JOB_INPUT_BYTES,
  SECRET_ARG_PLACEHOLDER,
  scrubSecretArgs,
} from "../../src/lib/jobs.js";
import { expectMode } from "../support/platform.js";

describe("jobs", () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plughive-jobs-"));
    db = new Database(join(dir, "q.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("enqueues and returns a queued job", () => {
    const q = new JobQueue({ db, concurrency: 2 });
    const id = q.enqueue("generate_video", { prompt: "hi" });
    expect(id).toMatch(/^job_/);
    const j = q.get(id);
    expect(j?.status).toBe("queued");
    expect((j?.input as any).prompt).toBe("hi");
    expect(j?.checkpoint).toEqual({});
  });

  it("runs queued jobs via handler, persists success", async () => {
    const q = new JobQueue({ db, concurrency: 2 });
    q.register("generate_video", async () => ({ artifacts: [{ id: "vid_1" }] }));
    const id = q.enqueue("generate_video", { prompt: "hi" });
    q.startWorker({ intervalMs: 5 });
    await waitFor(() => q.get(id)?.status === "succeeded", 1000);
    const j = q.get(id);
    expect((j?.result as any).artifacts[0].id).toBe("vid_1");
    q.stopWorker();
  });

  it("starts at most one worker and stops it reliably", () => {
    const q = new JobQueue({ db, concurrency: 1 });
    q.startWorker({ intervalMs: 5 });
    const firstTimer = (q as unknown as { timer: NodeJS.Timeout }).timer;
    q.startWorker({ intervalMs: 5 });
    expect((q as unknown as { timer: NodeJS.Timeout }).timer).toBe(firstTimer);
    expect(q.isWorkerRunning).toBe(true);
    q.stopWorker();
    expect(q.isWorkerRunning).toBe(false);
  });

  it("captures handler failures", async () => {
    const q = new JobQueue({ db, concurrency: 2 });
    q.register("generate_video", async () => {
      throw new Error("boom");
    });
    const id = q.enqueue("generate_video", {});
    q.startWorker({ intervalMs: 5 });
    await waitFor(() => q.get(id)?.status === "failed", 1000);
    expect(q.get(id)?.error).toContain("boom");
    q.stopWorker();
  });

  it("respects concurrency semaphore", async () => {
    const q = new JobQueue({ db, concurrency: 2 });
    let running = 0;
    let peak = 0;
    q.register("generate_video", async () => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 50));
      running--;
      return {};
    });
    for (let i = 0; i < 5; i++) q.enqueue("generate_video", {});
    q.startWorker({ intervalMs: 5 });
    await waitFor(() => {
      const rows = db.prepare("SELECT status FROM jobs").all() as any[];
      return rows.every((r) => r.status === "succeeded");
    }, 3000);
    expect(peak).toBeLessThanOrEqual(2);
    q.stopWorker();
  });

  it("recovers stale polling jobs while preserving their upstream checkpoint", () => {
    const q = new JobQueue({ db, concurrency: 2 });
    const id = q.enqueue("generate_video", {});
    db.prepare("UPDATE jobs SET status = ?, checkpoint_json = ? WHERE id = ?").run(
      "polling",
      JSON.stringify({ upstream_job_id: "upstream_123", polling_url: "https://poll.example/123" }),
      id,
    );

    const restarted = new JobQueue({ db, concurrency: 2 });
    expect(restarted.get(id)).toMatchObject({
      status: "queued",
      checkpoint: { upstream_job_id: "upstream_123", polling_url: "https://poll.example/123" },
    });
  });

  it("marks an ambiguously submitted stale job without an upstream id", () => {
    const q = new JobQueue({ db, concurrency: 2 });
    const id = q.enqueue("generate_video", {});
    db.prepare("UPDATE jobs SET status = ? WHERE id = ?").run("submitting", id);

    const restarted = new JobQueue({ db, concurrency: 2 });
    expect(restarted.get(id)).toMatchObject({ status: "submission_unknown" });
  });

  it("persists execution phase, progress, and checkpoint changes", async () => {
    const q = new JobQueue({ db, concurrency: 1 });
    q.register("generate_video", async (_input, execution) => {
      execution.setPhase("staging");
      execution.setProgress(0.25);
      execution.mergeCheckpoint({ staged_key: "frames/first.png" });
      expect(execution.getCheckpoint()).toEqual({ staged_key: "frames/first.png" });
      return { ok: true };
    });
    const id = q.enqueue("generate_video", {});
    q.startWorker({ intervalMs: 5 });
    await waitFor(() => q.get(id)?.status === "succeeded", 1000);
    expect(q.get(id)).toMatchObject({
      progress: 0.25,
      checkpoint: { staged_key: "frames/first.png" },
      result: { ok: true },
    });
    q.stopWorker();
  });

  it("persists terminal statuses selected by a job handler", async () => {
    const q = new JobQueue({ db, concurrency: 1 });
    q.register("generate_video", async () => {
      throw new JobTerminalError("cancelled", "cancelled upstream");
    });
    const id = q.enqueue("generate_video", {});
    q.startWorker({ intervalMs: 5 });
    await waitFor(() => q.get(id)?.status === "cancelled", 1000);
    expect(q.get(id)?.error).toBe("cancelled upstream");
    q.stopWorker();
  });

  it("migrates an existing jobs table without checkpoints", () => {
    db.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY, tool TEXT NOT NULL, status TEXT NOT NULL,
        input_json TEXT NOT NULL, result_json TEXT, error TEXT, progress REAL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    const q = new JobQueue({ db, concurrency: 1 });
    const id = q.enqueue("generate_video", {});
    expect(q.get(id)?.checkpoint).toEqual({});
  });

  // -------------------------------------------------------------------------
  // M3: bounded, pruned, private
  // -------------------------------------------------------------------------

  it("M3: caps the number of waiting jobs", () => {
    const q = new JobQueue({ db, concurrency: 1, maxQueued: 2 });
    q.enqueue("t", {});
    const second = q.enqueue("t", {});
    let thrown: unknown;
    try {
      q.enqueue("t", {});
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(JobLimitError);
    expect((thrown as JobLimitError).code).toBe("JOB_QUEUE_FULL");
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(2);
    // Room again once one leaves the queue.
    q.cancel(second);
    expect(() => q.enqueue("t", {})).not.toThrow();
    // The default is 200.
    expect(DEFAULT_MAX_QUEUED_JOBS).toBe(200);
  });

  it("M3: refuses arguments over 1 MB and stores nothing", () => {
    const q = new JobQueue({ db, concurrency: 1 });
    expect(MAX_JOB_INPUT_BYTES).toBe(1024 * 1024);
    let thrown: unknown;
    try {
      q.enqueue("t", { blob: "x".repeat(MAX_JOB_INPUT_BYTES) });
    } catch (e) {
      thrown = e;
    }
    expect((thrown as JobLimitError).code).toBe("JOB_INPUT_TOO_LARGE");
    expect((thrown as Error).message).not.toContain("xxxx");
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(0);
    expect(() => q.enqueue("t", { blob: "x".repeat(1000) })).not.toThrow();
  });

  it("M3: prunes finished jobs past the retention period, at open and on demand", () => {
    const q = new JobQueue({ db, concurrency: 1 });
    const old = q.enqueue("t", {});
    const oldQueued = q.enqueue("t", {});
    const recent = q.enqueue("t", {});
    const longAgo = new Date(Date.now() - JOB_RETENTION_MS - 60_000).toISOString();
    db.prepare("UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE id = ?").run(
      longAgo,
      old,
    );
    db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(longAgo, oldQueued);
    db.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").run(recent);
    expect(JOB_RETENTION_MS).toBe(7 * 24 * 60 * 60 * 1000);

    expect(q.prune()).toBe(1);
    expect(q.get(old)).toBeNull();
    // Unfinished work is never pruned, however old; recent results stay.
    expect(q.get(oldQueued)?.status).toBe("queued");
    expect(q.get(recent)?.status).toBe("failed");

    // A daemon that starts after a long pause prunes before it serves anything.
    db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(longAgo, recent);
    const restarted = new JobQueue({ db, concurrency: 1 });
    expect(restarted.get(recent)).toBeNull();
  });

  it("M3: keeps at most the newest N finished jobs", () => {
    const q = new JobQueue({ db, concurrency: 1, maxFinished: 3 });
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      const id = q.enqueue("t", {});
      ids.push(id);
      db.prepare("UPDATE jobs SET status = 'succeeded', updated_at = ? WHERE id = ?").run(
        new Date(Date.now() - (6 - i) * 1000).toISOString(),
        id,
      );
    }
    const waiting = q.enqueue("t", {});
    expect(q.prune()).toBe(3);
    expect(ids.map((id) => q.get(id) !== null)).toEqual([false, false, false, true, true, true]);
    expect(q.get(waiting)?.status).toBe("queued");
    expect(MAX_FINISHED_JOBS).toBe(1000);
  });

  it("D-M7: an unknown paid submission ages out but is never dropped to make room", () => {
    const q = new JobQueue({ db, concurrency: 1, maxFinished: 1 });
    const fresh = q.enqueue("t", {});
    const stale = q.enqueue("t", {});
    const done = q.enqueue("t", {});
    const longAgo = new Date(Date.now() - JOB_RETENTION_MS - 60_000).toISOString();
    db.prepare("UPDATE jobs SET status = 'submission_unknown' WHERE id IN (?, ?)").run(
      fresh,
      stale,
    );
    db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(longAgo, stale);
    db.prepare("UPDATE jobs SET status = 'succeeded' WHERE id = ?").run(done);
    expect(q.prune()).toBe(1);
    expect(q.get(stale)).toBeNull();
    expect(q.get(fresh)?.status).toBe("submission_unknown");
    expect(q.get(done)?.status).toBe("succeeded");
  });

  it("M3: the database file is owner-only, and an existing loose file is fixed at open", () => {
    const file = join(dir, "loose.db");
    const loose = new Database(file);
    loose.pragma("journal_mode = WAL");
    loose.prepare("CREATE TABLE t (x)").run();
    loose.prepare("INSERT INTO t VALUES (1)").run();
    chmodSync(file, 0o644);
    expectMode(file, 0o644);
    new JobQueue({ db: loose, concurrency: 1 });
    expectMode(file, 0o600);
    for (const sidecar of [`${file}-wal`, `${file}-shm`]) {
      if (existsSync(sidecar)) expectMode(sidecar, 0o600);
    }
    loose.close();
    // The shared queue of this suite too.
    new JobQueue({ db, concurrency: 1 });
    expectMode(join(dir, "q.db"), 0o600);
  });

  it("M3: secret-looking argument values never reach the disk; the handler still gets them", async () => {
    const q = new JobQueue({ db, concurrency: 1 });
    let seen: Record<string, unknown> | undefined;
    q.register("t", async (input) => {
      seen = input;
      return { ok: true };
    });
    const args = {
      prompt: "a cat",
      api_key: "sk-live-DO-NOT-STORE-1",
      max_tokens: 64,
      headers: { Authorization: "Bearer DO-NOT-STORE-2", accept: "json" },
      list: [{ clientSecret: "DO-NOT-STORE-3" }, { password: "DO-NOT-STORE-4" }],
      token: "",
    };
    const id = q.enqueue("t", args);
    const stored = (
      db.prepare("SELECT input_json FROM jobs WHERE id = ?").get(id) as { input_json: string }
    ).input_json;
    expect(stored).not.toContain("DO-NOT-STORE");
    expect(JSON.parse(stored)).toEqual({
      prompt: "a cat",
      api_key: SECRET_ARG_PLACEHOLDER,
      max_tokens: 64,
      headers: { Authorization: SECRET_ARG_PLACEHOLDER, accept: "json" },
      list: [{ clientSecret: SECRET_ARG_PLACEHOLDER }, { password: SECRET_ARG_PLACEHOLDER }],
      token: "",
    });
    expect(JSON.stringify(q.get(id))).not.toContain("DO-NOT-STORE");
    q.startWorker({ intervalMs: 5 });
    await waitFor(() => q.get(id)?.status === "succeeded", 1000);
    q.stopWorker();
    expect(seen).toEqual(args);
    // Nothing on disk afterwards either.
    const everything = JSON.stringify(db.prepare("SELECT * FROM jobs").all());
    expect(everything).not.toContain("DO-NOT-STORE");
    expect(scrubSecretArgs({ a: 1 })).toEqual({ value: { a: 1 }, changed: false });
  });

  // L3: the name is matched whole, as the tool-call log does, so ordinary
  // arguments whose name merely contains "key" or "token" are stored.
  it("L3: keywords, max_tokens and monkey are stored; real secret names are not", () => {
    const kept = {
      keywords: "cats, dogs",
      max_tokens: "64",
      monkey: "capuchin",
      keyframes: ["a", "b"],
      turkey: "roast",
    };
    expect(scrubSecretArgs(kept)).toEqual({ value: kept, changed: false });
    const secret = {
      api_key: "v",
      apiKey: "v",
      "x-api-key": "v",
      token: "v",
      access_token: "v",
      refreshToken: "v",
      Authorization: "v",
      clientSecret: "v",
      client_secret: "v",
      password: "v",
      db_password: "v",
      key: "v",
      private_key: "v",
      cookie: "v",
    };
    const scrubbed = scrubSecretArgs(secret);
    expect(scrubbed.changed).toBe(true);
    for (const [name, value] of Object.entries(scrubbed.value as Record<string, unknown>)) {
      expect(value, name).toBe(SECRET_ARG_PLACEHOLDER);
    }
  });

  it("D-M7: a secret nested past the walk depth is never stored", () => {
    let deep: Record<string, unknown> = { api_key: "sk-live-DO-NOT-STORE-deep" };
    for (let i = 0; i < 40; i++) deep = { n: deep };
    const scrubbed = scrubSecretArgs(deep);
    expect(scrubbed.changed).toBe(true);
    expect(JSON.stringify(scrubbed.value)).not.toContain("DO-NOT-STORE");
  });

  it("D-M7: URL userinfo and credential query values are not stored", () => {
    const scrubbed = scrubSecretArgs({
      image: "https://bob:hunter2-DO-NOT-STORE@example.com/a.png",
      list: ["https://cdn.example.com/x.mp4?X-Amz-Signature=DO-NOT-STORE-sig&w=640"],
      plain: "https://example.com/a.png?w=640",
    });
    expect(scrubbed.changed).toBe(true);
    expect(JSON.stringify(scrubbed.value)).not.toContain("DO-NOT-STORE");
    expect((scrubbed.value as { plain: string }).plain).toBe("https://example.com/a.png?w=640");
    expect((scrubbed.value as { list: string[] }).list[0]).toContain("w=640");
    expect(scrubSecretArgs({ url: "https://example.com/?page=2" }).changed).toBe(false);
  });

  it("D-M7: known secrets are masked in the stored result and error", async () => {
    const redactor = new Redactor();
    redactor.register("sk-live-RESULT-SECRET-1");
    const q = new JobQueue({ db, concurrency: 1, redactor });
    q.register("ok", async () => ({ echoed: "key sk-live-RESULT-SECRET-1" }));
    q.register("bad", async () => {
      throw new Error("upstream said sk-live-RESULT-SECRET-1 is invalid");
    });
    const ok = q.enqueue("ok", {});
    const bad = q.enqueue("bad", {});
    q.startWorker({ intervalMs: 5 });
    await waitFor(() => q.get(ok)?.status === "succeeded" && q.get(bad)?.status === "failed", 1000);
    q.stopWorker();
    const everything = JSON.stringify(db.prepare("SELECT * FROM jobs").all());
    expect(everything).not.toContain("RESULT-SECRET");
    expect(q.get(bad)?.error).toContain("[redacted]");
  });

  it("L3: two checkpoint merges keep each other's keys", () => {
    const q = new JobQueue({ db, concurrency: 1 });
    const id = q.enqueue("t", {});
    q.mergeCheckpoint(id, { a: 1 });
    expect(q.mergeCheckpoint(id, { b: 2 })).toEqual({ a: 1, b: 2 });
    expect(q.get(id)?.checkpoint).toEqual({ a: 1, b: 2 });
  });

  it("M3: a job whose secret arguments were lost in a restart fails clearly instead of running with a placeholder", async () => {
    const before = new JobQueue({ db, concurrency: 1 });
    const id = before.enqueue("t", { api_key: "sk-live-DO-NOT-STORE-1" });
    const after = new JobQueue({ db, concurrency: 1 });
    let ran = false;
    after.register("t", async () => (ran = true));
    after.startWorker({ intervalMs: 5 });
    await waitFor(() => after.get(id)?.status === "failed", 1000);
    after.stopWorker();
    expect(ran).toBe(false);
    expect(after.get(id)?.error).toMatch(/never stored; call the tool again/);
  });

  // -------------------------------------------------------------------------
  // M4: handlers and restarts
  // -------------------------------------------------------------------------

  it("M4: a job is not claimed before its handler is registered, then runs", async () => {
    const q = new JobQueue({ db, concurrency: 2 });
    q.register("other", async () => "other");
    const id = q.enqueue("late", { n: 1 });
    const otherId = q.enqueue("other", {});
    q.startWorker({ intervalMs: 5 });
    // The worker is busy with other tools; the job without a handler waits untouched.
    await waitFor(() => q.get(otherId)?.status === "succeeded", 1000);
    await new Promise((r) => setTimeout(r, 60));
    expect(q.get(id)).toMatchObject({ status: "queued", error: null });
    q.register("late", async (input) => ({ got: input.n }));
    await waitFor(() => q.get(id)?.status === "succeeded", 1000);
    q.stopWorker();
    expect(q.get(id)?.result).toEqual({ got: 1 });
  });

  it("M4: a job whose handler never appears fails clearly after the grace period", async () => {
    // A grace period well above the 30 ms check below: a loaded CI runner can
    // fire that timer late.
    const q = new JobQueue({ db, concurrency: 1, handlerGraceMs: 1000 });
    const id = q.enqueue("ghost_tool", {});
    q.startWorker({ intervalMs: 5 });
    await new Promise((r) => setTimeout(r, 30));
    expect(q.get(id)?.status).toBe("queued");
    await waitFor(() => q.get(id)?.status === "failed", 5000);
    q.stopWorker();
    expect(q.get(id)?.error).toBe(
      "no handler is registered for ghost_tool; the pack or feature that runs it is not loaded",
    );
    expect(DEFAULT_HANDLER_GRACE_MS).toBe(60_000);
  });

  it("M4: work that was running when the daemon died fails as interrupted, and is not run twice", async () => {
    const before = new JobQueue({ db, concurrency: 1 });
    const id = before.enqueue("send_email", { to: "a" });
    db.prepare("UPDATE jobs SET status = 'running' WHERE id = ?").run(id);

    const after = new JobQueue({ db, concurrency: 1 });
    let runs = 0;
    after.register("send_email", async () => ++runs);
    after.startWorker({ intervalMs: 5 });
    await waitFor(() => after.get(id)?.status === "failed", 1000);
    after.stopWorker();
    expect(runs).toBe(0);
    expect(after.get(id)?.error).toBe(INTERRUPTED_MESSAGE);
    expect(INTERRUPTED_MESSAGE).toContain("interrupted by restart");
  });

  it("M4: a resumable handler continues interrupted work from its checkpoint", async () => {
    const before = new JobQueue({ db, concurrency: 1 });
    const id = before.enqueue("generate_video", {});
    db.prepare("UPDATE jobs SET status = 'polling', checkpoint_json = ? WHERE id = ?").run(
      JSON.stringify({ upstream_job_id: "up_1" }),
      id,
    );
    const after = new JobQueue({ db, concurrency: 1 });
    after.register(
      "generate_video",
      async (_input, execution) => ({ resumed: execution.getCheckpoint().upstream_job_id }),
      { resumable: true },
    );
    after.startWorker({ intervalMs: 5 });
    await waitFor(() => after.get(id)?.status === "succeeded", 1000);
    after.stopWorker();
    expect(after.get(id)?.result).toEqual({ resumed: "up_1" });
  });

  it("M5: a job records the profile that started it", () => {
    const q = new JobQueue({ db, concurrency: 1 });
    expect(q.get(q.enqueue("t", {}, { profile: "media" }))?.profile).toBe("media");
    expect(q.get(q.enqueue("t", {}))?.profile).toBeNull();
  });
});

async function waitFor(cond: () => boolean, timeoutMs: number) {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe("result size cap (jobs.db bloat)", () => {
  let dir: string;
  let db: Database.Database;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plughive-jobs-"));
    db = new Database(join(dir, "q.db"));
  });
  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores a small result whole, and a marker past maxResultBytes", async () => {
    const q = new JobQueue({ db, concurrency: 2, maxResultBytes: 200 });
    q.register("small", async () => ({ ok: true }));
    q.register("huge", async () => ({ blob: "x".repeat(5000) }));
    const a = q.enqueue("small", {});
    const b = q.enqueue("huge", {});
    q.startWorker({ intervalMs: 5 });
    await waitFor(() => q.get(a)?.status === "succeeded" && q.get(b)?.status === "succeeded", 2000);
    q.stopWorker();
    expect(q.get(a)?.result).toEqual({ ok: true });
    const marker = q.get(b)?.result as Record<string, unknown>;
    expect(marker.truncated).toBe(true);
    expect(typeof marker.bytes).toBe("number");
    expect(marker.bytes).toBeGreaterThan(200);
    expect(marker.note).toMatch(/artifacts/);
    // The stored column really is small.
    const row = db.prepare("SELECT result_json FROM jobs WHERE id = ?").get(b) as {
      result_json: string;
    };
    expect(Buffer.byteLength(row.result_json, "utf8")).toBeLessThan(500);
  });
});
