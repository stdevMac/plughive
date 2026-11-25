// L12: a long-running call sent twice with the same idempotency key starts one
// job. The key lives in `_meta` (MCP) or the Idempotency-Key header (HTTP API),
// is bound to the tool and its arguments, and is scoped to the profile.
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IDEMPOTENCY_META_KEY } from "../../src/core/mcp/tasks.js";
import { JobIdempotencyError, JobQueue, isIdempotencyKey } from "../../src/lib/jobs.js";
import {
  type LiteHarness,
  TASK_CAPS,
  adminFetch,
  bootLite,
  mockTool,
  rawModern,
  toolJson,
  until,
} from "./harness.js";

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
};

describe("JobQueue idempotency keys", () => {
  let db: Database.Database;
  let q: JobQueue;
  beforeEach(() => {
    db = new Database(":memory:");
    q = new JobQueue({ db, concurrency: 1, retentionMs: 60_000 });
  });
  afterEach(() => db.close());
  const count = () => (db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n;

  it("the same key, tool and arguments return the job that already exists", () => {
    const first = q.enqueue("t", { a: 1, nested: { x: [1, 2], y: "z" } }, { idempotencyKey: "k1" });
    // Key order is not a difference.
    const second = q.enqueue(
      "t",
      { nested: { y: "z", x: [1, 2] }, a: 1 },
      { idempotencyKey: "k1" },
    );
    expect(second).toBe(first);
    expect(count()).toBe(1);
    // Without a key every call is a new job.
    expect(q.enqueue("t", { a: 1 })).not.toBe(q.enqueue("t", { a: 1 }));
  });

  it("a __proto__ key in the arguments is bound into the digest like any other key", () => {
    const first = q.enqueue("t", JSON.parse('{"a":1,"__proto__":{"x":9}}'), {
      idempotencyKey: "kproto",
    });
    // Dropping the key from the digest would make this look like the same call.
    const err = thrown(() => q.enqueue("t", { a: 1 }, { idempotencyKey: "kproto" }));
    expect(err).toBeInstanceOf(JobIdempotencyError);
    // The same arguments, whatever the key order, still deduplicate.
    expect(
      q.enqueue("t", JSON.parse('{"__proto__":{"x":9},"a":1}'), { idempotencyKey: "kproto" }),
    ).toBe(first);
  });

  it("the same key with other arguments, or another tool, is an error and queues nothing", () => {
    const first = q.enqueue("t", { a: 1 }, { idempotencyKey: "k1" });
    for (const again of [
      () => q.enqueue("t", { a: 2 }, { idempotencyKey: "k1" }),
      () => q.enqueue("t", { a: 1, b: undefined, c: 0 }, { idempotencyKey: "k1" }),
      () => q.enqueue("other", { a: 1 }, { idempotencyKey: "k1" }),
    ]) {
      const err = thrown(again);
      expect(err).toBeInstanceOf(JobIdempotencyError);
      expect(err).toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
      expect((err as Error).message).toContain(first);
    }
    expect(count()).toBe(1);
  });

  it("is scoped to the profile", () => {
    const a = q.enqueue("t", { a: 1 }, { idempotencyKey: "k1", profile: "kids" });
    const b = q.enqueue("t", { a: 2 }, { idempotencyKey: "k1", profile: "work" });
    const none = q.enqueue("t", { a: 3 }, { idempotencyKey: "k1" });
    expect(new Set([a, b, none]).size).toBe(3);
    expect(q.enqueue("t", { a: 1 }, { idempotencyKey: "k1", profile: "kids" })).toBe(a);
    expect(q.enqueue("t", { a: 2 }, { idempotencyKey: "k1", profile: "work" })).toBe(b);
    expect(q.enqueue("t", { a: 3 }, { idempotencyKey: "k1" })).toBe(none);
    expect(() => q.enqueue("t", { a: 2 }, { idempotencyKey: "k1", profile: "kids" })).toThrow(
      JobIdempotencyError,
    );
  });

  it("returns a finished job too, until the retention period is over", () => {
    const first = q.enqueue("t", { a: 1 }, { idempotencyKey: "k1" });
    q.cancel(first);
    expect(q.get(first)?.status).toBe("cancelled");
    expect(q.enqueue("t", { a: 1 }, { idempotencyKey: "k1" })).toBe(first);

    // Finished longer ago than the retention period: the key is free, even
    // before the pruner removed the row.
    db.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run(
      new Date(Date.now() - 120_000).toISOString(),
      first,
    );
    const fresh = q.enqueue("t", { a: 2 }, { idempotencyKey: "k1" });
    expect(fresh).not.toBe(first);
    expect(q.enqueue("t", { a: 2 }, { idempotencyKey: "k1" })).toBe(fresh);
    q.prune();
    expect(q.get(first)).toBeNull();
    expect(q.enqueue("t", { a: 2 }, { idempotencyKey: "k1" })).toBe(fresh);
  });

  it("an unfinished job keeps its key however old it is", () => {
    const first = q.enqueue("t", { a: 1 }, { idempotencyKey: "k1" });
    db.prepare("UPDATE jobs SET updated_at = ?, created_at = ? WHERE id = ?").run(
      new Date(Date.now() - 120_000).toISOString(),
      new Date(Date.now() - 120_000).toISOString(),
      first,
    );
    expect(q.enqueue("t", { a: 1 }, { idempotencyKey: "k1" })).toBe(first);
  });

  it("an existing job is returned even when the queue is full", () => {
    const small = new JobQueue({ db, concurrency: 1, maxQueued: 1 });
    const first = small.enqueue("t", { a: 1 }, { idempotencyKey: "k1" });
    expect(small.enqueue("t", { a: 1 }, { idempotencyKey: "k1" })).toBe(first);
    expect(() => small.enqueue("t", { a: 1 }, { idempotencyKey: "k2" })).toThrow(/too many jobs/);
  });

  it("compares the real arguments, and stores neither them nor the key's secret values", () => {
    const first = q.enqueue("t", { api_key: "sk-DO-NOT-STORE-1", n: 1 }, { idempotencyKey: "k1" });
    expect(q.enqueue("t", { api_key: "sk-DO-NOT-STORE-1", n: 1 }, { idempotencyKey: "k1" })).toBe(
      first,
    );
    expect(() =>
      q.enqueue("t", { api_key: "sk-DO-NOT-STORE-2", n: 1 }, { idempotencyKey: "k1" }),
    ).toThrow(JobIdempotencyError);
    expect(JSON.stringify(db.prepare("SELECT * FROM jobs").all())).not.toContain("DO-NOT-STORE");
    // Equal calls of two profiles do not share a digest.
    q.enqueue("t", { n: 1 }, { idempotencyKey: "k9", profile: "a" });
    q.enqueue("t", { n: 1 }, { idempotencyKey: "k9", profile: "b" });
    const digests = db.prepare("SELECT idem_hash FROM jobs WHERE idem_key = 'k9'").all() as Array<{
      idem_hash: string;
    }>;
    expect(new Set(digests.map((d) => d.idem_hash)).size).toBe(2);
  });

  it("refuses a malformed key", () => {
    for (const bad of ["", "has space", "x".repeat(129), "tab\there", "ünï", 7, null, {}]) {
      expect(isIdempotencyKey(bad), String(bad)).toBe(false);
      const err = thrown(() => q.enqueue("t", {}, { idempotencyKey: bad as string }));
      expect(err).toMatchObject({ name: "JobIdempotencyError", code: "IDEMPOTENCY_KEY_INVALID" });
    }
    expect(isIdempotencyKey("x".repeat(128))).toBe(true);
    expect(isIdempotencyKey("req_01J-abc:1/2")).toBe(true);
    expect(count()).toBe(0);
  });

  it("opens a database written before the key existed", () => {
    const old = new Database(":memory:");
    old
      .prepare(
        `CREATE TABLE jobs (id TEXT PRIMARY KEY, tool TEXT NOT NULL, status TEXT NOT NULL,
         input_json TEXT NOT NULL, result_json TEXT, error TEXT, progress REAL,
         created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`,
      )
      .run();
    const queue = new JobQueue({ db: old, concurrency: 1 });
    const id = queue.enqueue("t", { a: 1 }, { idempotencyKey: "k1" });
    expect(queue.enqueue("t", { a: 1 }, { idempotencyKey: "k1" })).toBe(id);
    old.close();
  });
});

describe("idempotent long-running tool calls", () => {
  let h: LiteHarness;
  let runs: number;
  const slow = () =>
    mockTool(
      "slow",
      (_input, ctx) =>
        new Promise((resolve) => {
          runs++;
          ctx.signal?.addEventListener("abort", () => resolve("stopped"));
        }),
      { longRunning: true },
    );
  beforeEach(async () => {
    runs = 0;
    h = await bootLite({
      packs: { demo: [slow(), mockTool("quick", async () => ({ ok: true }))] },
    });
    h.profiles.put({ id: "kids", name: "Kids", mode: "list", include: ["*"] });
  });
  afterEach(async () => {
    for (const job of h.jobs.list({ limit: 200 })) h.jobs.cancel(job.id);
    await h.close();
  });

  const call = (
    args: Record<string, unknown>,
    key: unknown,
    opts: { path?: string; tasks?: boolean; name?: string } = {},
  ) =>
    rawModern(
      h.base,
      "tools/call",
      { name: opts.name ?? "slow", arguments: args },
      {
        ...(opts.path ? { path: opts.path } : {}),
        ...(opts.tasks ? { capabilities: TASK_CAPS } : {}),
        ...(key !== undefined ? { meta: { [IDEMPOTENCY_META_KEY]: key } } : {}),
      },
    );
  const jobIdOf = (reply: Awaited<ReturnType<typeof call>>): string =>
    toolJson(reply.result).result.job_id;

  it("the key is a namespaced _meta entry", () => {
    expect(IDEMPOTENCY_META_KEY).toBe("plughive/idempotency-key");
  });

  it("a re-sent call returns the same job and runs the tool once", async () => {
    const first = jobIdOf(await call({ prompt: "a" }, "retry-1"));
    await until(() => h.jobs.get(first)?.status === "running");
    expect(jobIdOf(await call({ prompt: "a" }, "retry-1"))).toBe(first);
    // As a task for a client that declares the extension: the same task id.
    const asTask = await call({ prompt: "a" }, "retry-1", { tasks: true });
    expect(asTask.result).toMatchObject({ resultType: "task", taskId: first, status: "working" });
    expect(h.jobs.list({ limit: 200 })).toHaveLength(1);
    expect(runs).toBe(1);
    // No key: a second job, as before.
    const other = jobIdOf(await call({ prompt: "a" }, undefined));
    expect(other).not.toBe(first);
  });

  it("the same key with different arguments is an error and starts nothing", async () => {
    const first = jobIdOf(await call({ prompt: "a" }, "retry-2"));
    const clash = await call({ prompt: "b" }, "retry-2");
    expect(clash.result?.isError).toBe(true);
    expect(toolJson(clash.result).error).toMatchObject({
      code: "IDEMPOTENCY_KEY_REUSED",
      retryable: false,
    });
    expect(toolJson(clash.result).error.message).toContain(first);
    expect(h.jobs.list({ limit: 200 })).toHaveLength(1);
  });

  it("keys of two profiles never meet", async () => {
    const mine = jobIdOf(await call({ prompt: "a" }, "shared"));
    const theirs = jobIdOf(await call({ prompt: "b" }, "shared", { path: "/p/kids/mcp" }));
    expect(theirs).not.toBe(mine);
    expect(jobIdOf(await call({ prompt: "b" }, "shared", { path: "/p/kids/mcp" }))).toBe(theirs);
    expect(h.jobs.get(theirs)?.profile).toBe("kids");
  });

  it("a malformed key is a protocol error, not a silently unprotected call", async () => {
    for (const bad of ["has space", "", 42, "x".repeat(200)]) {
      const reply = await call({ prompt: "a" }, bad);
      expect(reply.error?.code, String(bad)).toBe(-32602);
      expect(reply.error?.message).toContain(IDEMPOTENCY_META_KEY);
    }
    expect(h.jobs.list({ limit: 200 })).toHaveLength(0);
    expect(runs).toBe(0);
  });

  it("an inline call ignores the key", async () => {
    const reply = await call({}, "inline-1", { name: "quick" });
    expect(toolJson(reply.result)).toMatchObject({ ok: true });
    expect(
      toolJson(await call({ other: 1 }, "inline-1", { name: "quick" }).then((r) => r.result)),
    ).toMatchObject({
      ok: true,
    });
  });

  it("the HTTP API takes the Idempotency-Key header", async () => {
    const post = (args: unknown, key?: string) =>
      adminFetch(`${h.base}/api/tools/slow/call`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-plughive-csrf": "1",
          ...(key !== undefined ? { "idempotency-key": key } : {}),
        },
        body: JSON.stringify({ arguments: args }),
      });
    const a = await post({ n: 1 }, "http-1");
    expect(a.status).toBe(202);
    const first = ((await a.json()) as { job_id: string }).job_id;
    const b = await post({ n: 1 }, "http-1");
    expect(b.status).toBe(202);
    expect(((await b.json()) as { job_id: string }).job_id).toBe(first);
    // The parsed arguments are what is compared: a default spelled out is the same call.
    expect(((await (await post({}, "http-1")).json()) as { job_id: string }).job_id).toBe(first);
    const clash = await post({ n: 2 }, "http-1");
    expect(clash.status).toBe(409);
    expect(((await clash.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_REUSED",
    );
    const bad = await post({ n: 1 }, "has space");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { code: string } }).error.code).toBe(
      "IDEMPOTENCY_KEY_INVALID",
    );
    expect(h.jobs.list({ limit: 200 })).toHaveLength(1);
  });
});
