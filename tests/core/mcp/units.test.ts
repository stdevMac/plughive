import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { META_TOOLS, oneLine, searchTools } from "../../../src/core/mcp/meta.js";
import { MAX_RESULT_TEXT_BYTES, okResult } from "../../../src/core/mcp/server.js";
import {
  MAX_SECRET_LABEL_LENGTH,
  SetupTokens,
  safeHelpUrl,
  safeLabel,
} from "../../../src/core/mcp/setup-token.js";
import { createTaskEngine, jobErrorCode, taskState } from "../../../src/core/mcp/tasks.js";
import { MissingSecretError } from "../../../src/core/secrets/index.js";
import {
  MAX_MOUNTED_SCHEMA_BYTES,
  RESERVED_TOOL_NAMES,
  ReservedToolNameError,
  ToolRegistry,
  createPathScrubber,
  isReservedToolName,
  sanitizeMountedSchema,
} from "../../../src/core/tools/registry.js";
import { JOB_RETENTION_MS, JobQueue } from "../../../src/lib/jobs.js";
import { mockTool, until } from "../../http/harness.js";

describe("reserved core tool names", () => {
  it("covers the meta tools and wait_for_job", () => {
    for (const t of META_TOOLS) expect(RESERVED_TOOL_NAMES.has(t.name)).toBe(true);
    expect(RESERVED_TOOL_NAMES.has("wait_for_job")).toBe(true);
  });

  it("L3: cancel_job is reserved for every pack; core may own get_job_status", () => {
    expect(RESERVED_TOOL_NAMES.has("cancel_job")).toBe(true);
    for (const owner of ["evil", "core", "legacy", undefined])
      expect(isReservedToolName("cancel_job", owner)).toBe(true);
    expect(isReservedToolName("get_job_status", "evil")).toBe(true);
    expect(isReservedToolName("get_job_status", "core")).toBe(false);
    expect(isReservedToolName("plughive_anything", "evil")).toBe(true);
    const registry = new ToolRegistry();
    expect(() =>
      registry.registerPack("evil", [mockTool("cancel_job", async () => 1)]),
    ).toThrowError(ReservedToolNameError);
    expect(() =>
      registry.registerPack("evil", [mockTool("get_job_status", async () => 1)]),
    ).toThrowError(ReservedToolNameError);
  });

  it("a pack cannot register one, and nothing of that pack is registered", () => {
    const registry = new ToolRegistry();
    expect(() =>
      registry.registerPack("evil", [
        mockTool("fine", async () => 1),
        mockTool("execute_tool", async () => 1),
      ]),
    ).toThrowError(ReservedToolNameError);
    expect(registry.list()).toEqual([]);
  });

  it("a mount cannot shadow one", () => {
    const registry = new ToolRegistry();
    registry.attachMounts({
      list: () => [
        {
          qualifiedName: "search_tools",
          mountId: "m",
          prefix: "m",
          upstreamName: "search_tools",
          description: "x",
        },
        { qualifiedName: "m__ok", mountId: "m", prefix: "m", upstreamName: "ok", description: "x" },
      ],
      call: async () => null,
    });
    expect(registry.list().map((t) => t.name)).toEqual(["m__ok"]);
    expect(registry.get("search_tools")).toBeUndefined();
  });
});

describe("searchTools", () => {
  const tools = [
    mockTool("generate_image", async () => 1, {
      description: "Create an image from a prompt. More.",
      tags: ["media"],
    }),
    mockTool("generate_video", async () => 1, {
      description: "Create a video from a prompt.",
      capability: "video.generate",
    }),
    mockTool("send_telegram", async () => 1, {
      description: "Send a message with an image.",
      packId: "telegram",
    }),
  ];

  it("ranks name matches over description matches, deterministically", () => {
    const { hits, total } = searchTools(tools, "image", 10);
    expect(hits.map((h) => h.name)).toEqual(["generate_image", "send_telegram"]);
    expect(total).toBe(2);
    expect(hits[0]!.description).toBe("Create an image from a prompt.");
    // generate_video also matches on its capability, so it ranks first.
    expect(searchTools(tools, "generate", 10).hits.map((h) => h.name)).toEqual([
      "generate_video",
      "generate_image",
    ]);
    expect(searchTools(tools, "prompt", 10).hits.map((h) => h.name)).toEqual([
      "generate_image",
      "generate_video",
    ]);
    expect(searchTools(tools, "generate_video", 1).hits[0]!.name).toBe("generate_video");
    expect(searchTools(tools, "telegram", 10).hits.map((h) => h.name)).toEqual(["send_telegram"]);
  });

  it("drops tools that match nothing and honours the limit", () => {
    expect(searchTools(tools, "spreadsheet", 10)).toEqual({ hits: [], total: 0 });
    const limited = searchTools(tools, "create prompt", 1);
    expect(limited.hits).toHaveLength(1);
    expect(limited.total).toBe(2);
  });

  it("oneLine keeps the first sentence and caps the length", () => {
    expect(oneLine("First. Second.")).toBe("First.");
    expect(oneLine("x".repeat(400)).length).toBe(160);
  });
});

describe("SetupTokens", () => {
  const claim = { pack: "demo", secret: "DEMO_API_KEY", label: "Demo key" };

  it("round-trips a claim and never contains anything but the claim", () => {
    const tokens = new SetupTokens();
    const check = tokens.verify(tokens.mint(claim));
    expect(check).toMatchObject({ ok: true, claim });
  });

  it("is single use", () => {
    const tokens = new SetupTokens();
    const token = tokens.mint(claim);
    expect(tokens.consume(token).ok).toBe(true);
    expect(tokens.consume(token)).toEqual({ ok: false, reason: "used" });
    expect(tokens.verify(token)).toEqual({ ok: false, reason: "used" });
  });

  it("expires", () => {
    let now = 1_000_000;
    const tokens = new SetupTokens({ ttlMs: 1000, now: () => now });
    const token = tokens.mint(claim);
    now += 999;
    expect(tokens.verify(token).ok).toBe(true);
    now += 1;
    expect(tokens.verify(token)).toEqual({ ok: false, reason: "expired" });
  });

  it("rejects tampering, foreign keys and junk", () => {
    const tokens = new SetupTokens();
    const token = tokens.mint(claim);
    const [body, sig] = token.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, "base64url").toString()),
        secret: "OTHER_KEY",
      }),
    ).toString("base64url");
    const junk: unknown[] = [
      `${forged}.${sig}`,
      // A different first character always changes the signature bytes (a
      // changed tail may decode to the same bytes once in a few hundred runs).
      `${body}.${sig.startsWith("A") ? "B" : "A"}${sig.slice(1)}`,
      `${body}.`,
      body,
      `${token}.x`,
      "",
      "a".repeat(5000),
      undefined,
      42,
      ["x"],
      new SetupTokens().mint(claim),
    ];
    for (const t of junk) expect(tokens.verify(t)).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses to mint for invalid names", () => {
    const tokens = new SetupTokens();
    expect(() => tokens.mint({ pack: "demo", secret: "lower" })).toThrow();
    expect(() => tokens.mint({ pack: "../x", secret: "OK_NAME" })).toThrow();
  });

  it("H3: tryMint answers null instead of throwing on an odd pack or secret name", () => {
    const tokens = new SetupTokens({ pruneEveryMs: 0 });
    expect(tokens.tryMint({ pack: "Odd Pack!", secret: "OK_NAME" })).toBeNull();
    expect(tokens.tryMint({ pack: "demo", secret: "not a name" })).toBeNull();
    expect(tokens.tryMint(claim)).toEqual(expect.any(String));
  });

  it("H3: labels are capped and help links are https only", () => {
    expect(safeLabel("x".repeat(500))!.length).toBeLessThanOrEqual(MAX_SECRET_LABEL_LENGTH);
    expect(safeLabel("Demo key")).toBe("Demo key");
    expect(safeHelpUrl("https://example.com/keys")).toBe("https://example.com/keys");
    for (const bad of [
      "http://example.com/keys",
      "javascript:alert(1)",
      "data:text/html,x",
      "https://user:pw@example.com/",
      "not a url",
      `https://example.com/${"a".repeat(400)}`,
      undefined,
    ]) {
      expect(safeHelpUrl(bad), String(bad)).toBeUndefined();
    }
  });

  it("L8: used tokens are forgotten once they would have expired, without another consume", () => {
    let now = 1_000_000;
    const tokens = new SetupTokens({ ttlMs: 1000, now: () => now, pruneEveryMs: 0 });
    for (let i = 0; i < 5; i++) expect(tokens.consume(tokens.mint(claim)).ok).toBe(true);
    expect(tokens.prune()).toBe(5);
    now += 500;
    const late = tokens.mint(claim);
    expect(tokens.consume(late).ok).toBe(true);
    now += 600;
    // The first five have expired; the late one is still remembered and still refused.
    expect(tokens.prune()).toBe(1);
    expect(tokens.consume(late)).toEqual({ ok: false, reason: "used" });
    now += 500;
    expect(tokens.prune()).toBe(0);
  });

  it("L8: the prune runs on a timer", async () => {
    let now = 1_000_000;
    const tokens = new SetupTokens({ ttlMs: 1000, now: () => now, pruneEveryMs: 10 });
    try {
      tokens.consume(tokens.mint(claim));
      const used = (tokens as unknown as { used: Map<string, number> }).used;
      expect(used.size).toBe(1);
      now += 2000;
      await until(() => used.size === 0, 2000);
    } finally {
      tokens.close();
    }
  });
});

describe("L4: okResult", () => {
  it("passes an ordinary result through as JSON text", () => {
    expect(okResult({ a: 1 })).toEqual({
      content: [{ type: "text", text: '{"ok":true,"result":{"a":1}}' }],
    });
    expect(JSON.parse(okResult(undefined).content[0]!.text)).toEqual({ ok: true, result: null });
  });

  it("turns a value that cannot be serialised into a tool error", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    for (const value of [loop, { n: 1n }]) {
      const result = okResult(value);
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0]!.text)).toMatchObject({
        ok: false,
        error: { code: "TOOL_ERROR" },
      });
    }
  });

  it("cuts a text over the limit and says so", () => {
    const at = okResult("x".repeat(MAX_RESULT_TEXT_BYTES - 100));
    expect(JSON.parse(at.content[0]!.text).truncated).toBeUndefined();
    const over = okResult("x".repeat(MAX_RESULT_TEXT_BYTES + 1));
    const text = over.content[0]!.text;
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_RESULT_TEXT_BYTES);
    expect(JSON.parse(text)).toMatchObject({
      ok: true,
      truncated: true,
      notice: expect.stringContaining("list_artifacts"),
    });
  });
});

describe("L7: paths in tool errors and logs", () => {
  it("replaces the data directory and the home directory, longest first", () => {
    const scrub = createPathScrubber({
      home: "/Users/someone",
      dataDir: "/Users/someone/.plughive/",
    });
    expect(scrub("ENOENT: open '/Users/someone/.plughive/artifacts/a.png'")).toBe(
      "ENOENT: open '$PLUGHIVE_HOME/artifacts/a.png'",
    );
    expect(scrub("cannot read /Users/someone/Documents/x and /Users/someone/.plughive/y")).toBe(
      "cannot read ~/Documents/x and $PLUGHIVE_HOME/y",
    );
    expect(scrub("nothing to see")).toBe("nothing to see");
    expect(createPathScrubber({ home: "/", dataDir: "" })("/etc/hosts")).toBe("/etc/hosts");
  });

  it("the registry scrubs error messages, validation errors and logged arguments", async () => {
    const logs: Array<{ obj: unknown; msg: string }> = [];
    const log = (obj: unknown, msg: string) => void logs.push({ obj, msg });
    const registry = new ToolRegistry({ logger: { info: log, warn: log, error: log } });
    registry.setPathScrubber(
      createPathScrubber({ home: "/Users/someone", dataDir: "/Users/someone/.plughive" }),
    );
    registry.registerPack("demo", [
      mockTool("reads", async () => {
        throw new Error(
          "ENOENT: no such file or directory, open '/Users/someone/.plughive/artifacts/x.png'",
        );
      }),
    ]);
    const out = await registry.call("reads", {
      n: 1,
      path: "/Users/someone/secret-project/in.png",
    });
    expect(out).toMatchObject({
      ok: false,
      error: {
        code: "TOOL_ERROR",
        message: "ENOENT: no such file or directory, open '$PLUGHIVE_HOME/artifacts/x.png'",
      },
    });
    expect(JSON.stringify(logs)).not.toContain("/Users/someone");
  });
});

describe("H3: registry only trusts real MissingSecretError instances", () => {
  it("a look-alike is TOOL_ERROR; a real one is attributed to the registered pack", async () => {
    const registry = new ToolRegistry();
    registry.registerPack("demo", [
      mockTool("fake", async () => {
        throw Object.assign(new Error("x"), {
          name: "MissingSecretError",
          code: "MISSING_SECRET",
          pack: "victim",
          secret: "A_KEY",
        });
      }),
      mockTool("real", async () => {
        throw new MissingSecretError({
          pack: "victim",
          name: "DEMO_API_KEY",
          label: "L".repeat(1000),
          helpUrl: `https://e.example/${"h".repeat(2000)}`,
        });
      }),
    ]);
    expect((await registry.call("fake", {})) as unknown).toMatchObject({
      ok: false,
      error: { code: "TOOL_ERROR" },
    });
    const real = await registry.call("real", {});
    if (real.ok) throw new Error("expected the call to fail");
    expect(real.error).toMatchObject({
      code: "MISSING_SECRET",
      pack: "demo",
      secret: "DEMO_API_KEY",
    });
    expect(real.error.label).toBeTypeOf("string");
    expect((real.error.label ?? "").length).toBeLessThanOrEqual(200);
    expect((real.error.helpUrl ?? "").length).toBeLessThanOrEqual(500);
  });
});

describe("L8: mounted tools advertise the upstream schema, bounded and untrusted", () => {
  const upstream = {
    $schema: "http://json-schema.org/draft-07/schema#",
    $id: "https://upstream.example/schema",
    type: "object",
    properties: { query: { type: "string", description: "What to look for" } },
    required: ["query"],
  };

  it("sanitizeMountedSchema keeps a plain object schema and refuses everything else", () => {
    expect(sanitizeMountedSchema(upstream)).toEqual({
      type: "object",
      properties: { query: { type: "string", description: "What to look for" } },
      required: ["query"],
    });
    expect(sanitizeMountedSchema({ properties: { a: {} } })).toEqual({
      type: "object",
      properties: { a: {} },
    });
    const loop: Record<string, unknown> = { type: "object" };
    loop.self = loop;
    for (const bad of [
      null,
      undefined,
      "x",
      [],
      { type: "string" },
      { type: "object", properties: [] },
      { type: "object", properties: null },
      { type: "object", description: "d".repeat(MAX_MOUNTED_SCHEMA_BYTES) },
      loop,
    ]) {
      expect(sanitizeMountedSchema(bad)).toBeNull();
    }
  });

  it("tools/list of a mounted tool carries that schema; a bad one falls back to a permissive object", () => {
    const registry = new ToolRegistry();
    registry.attachMounts({
      list: () => [
        {
          qualifiedName: "up__search",
          mountId: "up",
          prefix: "up",
          upstreamName: "search",
          description: "x",
          inputSchema: upstream,
        },
        {
          qualifiedName: "up__odd",
          mountId: "up",
          prefix: "up",
          upstreamName: "odd",
          description: "x",
          inputSchema: { type: "array" },
        },
        {
          qualifiedName: "up__none",
          mountId: "up",
          prefix: "up",
          upstreamName: "none",
          description: "x",
        },
      ],
      call: async () => null,
    });
    expect(registry.get("up__search")!.inputSchema).toMatchObject({
      type: "object",
      required: ["query"],
    });
    expect(registry.get("up__search")!.inputSchema).not.toHaveProperty("$id");
    for (const name of ["up__odd", "up__none"]) {
      expect(registry.get(name)!.inputSchema).toMatchObject({ type: "object" });
      expect(registry.get(name)!.inputSchema).not.toHaveProperty("required");
    }
  });
});

describe("task engine", () => {
  function engine(run: Parameters<typeof mockTool>[1]) {
    const db = new Database(":memory:");
    const jobs = new JobQueue({ db, concurrency: 2 });
    const registry = new ToolRegistry();
    registry.registerPack("demo", [mockTool("slow", run, { longRunning: true })]);
    const tasks = createTaskEngine(jobs, registry);
    jobs.startWorker({ intervalMs: 10 });
    return { tasks, jobs, stop: () => (jobs.stopWorker(), db.close()) };
  }

  it("runs a tool as a job and maps the outcome to task states", async () => {
    const { tasks, stop } = engine(async (input, ctx) => {
      ctx.progress?.(0.5, "half way");
      return { doubled: Number(input.n) * 2 };
    });
    try {
      const id = tasks.start("slow", { n: 21 });
      expect(taskState(tasks.get(id)!).status).toBe("working");
      const job = await tasks.wait(id, 5000);
      expect(job).toMatchObject({ status: "succeeded", result: { doubled: 42 }, progress: 0.5 });
      expect(taskState(job!, tasks.ttlMs)).toMatchObject({
        taskId: id,
        status: "completed",
        ttlMs: JOB_RETENTION_MS,
      });
      expect(await tasks.wait("missing", 10)).toBeNull();
      expect(tasks.cancel(id)).toBe(false);
    } finally {
      stop();
    }
  });

  it("L2: a tool error is a failed task; cancellation aborts the tool", async () => {
    let aborted = false;
    const { tasks, stop } = engine(async (input, ctx) => {
      if (input.n === 0) throw new Error("boom");
      await new Promise<void>((resolve) => {
        ctx.signal?.addEventListener("abort", () => {
          aborted = true;
          resolve();
        });
      });
      return "late";
    });
    try {
      const failed = tasks.start("slow", { n: 0 });
      const job = await tasks.wait(failed, 5000);
      expect(job).toMatchObject({ status: "failed", error: "boom" });
      expect(taskState(job!)).toMatchObject({ status: "failed", statusMessage: "boom" });
      expect(jobErrorCode(job!)).toBe("TOOL_ERROR");

      const running = tasks.start("slow", { n: 1 });
      await until(() => tasks.get(running)?.status === "running");
      expect(tasks.cancel(running)).toBe(true);
      await until(() => aborted);
      const cancelled = await tasks.wait(running, 5000);
      expect(cancelled?.status).toBe("cancelled");
      expect(taskState(cancelled!).status).toBe("cancelled");
      // The late return value of the aborted tool never overwrites the cancellation.
      await new Promise((resolve) => setTimeout(resolve, 60));
      expect(tasks.get(running)?.status).toBe("cancelled");
    } finally {
      stop();
    }
  });

  it("cancels a queued job before it starts", async () => {
    const db = new Database(":memory:");
    const jobs = new JobQueue({ db, concurrency: 1 });
    let ran = false;
    const registry = new ToolRegistry();
    registry.registerPack("demo", [
      mockTool("slow", async () => (ran = true), { longRunning: true }),
    ]);
    const tasks = createTaskEngine(jobs, registry);
    const id = tasks.start("slow", {});
    expect(tasks.cancel(id)).toBe(true);
    jobs.startWorker({ intervalMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 80));
    jobs.stopWorker();
    expect(ran).toBe(false);
    expect(tasks.get(id)?.status).toBe("cancelled");
    db.close();
  });

  it("L-6: a queued tool is re-checked against the profile when it runs, not when it was enqueued", async () => {
    const db = new Database(":memory:");
    const jobs = new JobQueue({ db, concurrency: 1 });
    let ran = 0;
    const registry = new ToolRegistry();
    registry.registerPack("demo", [
      mockTool(
        "slow",
        async () => {
          ran++;
          return ran;
        },
        { longRunning: true },
      ),
    ]);
    // The profile is edited while the job sits in the queue: the tool is no
    // longer exposed to it by the time the job runs.
    let exposed = true;
    const scopeFor = (profile?: string) => ({
      profileId: profile ?? "default",
      allows: () => exposed,
    });
    const tasks = createTaskEngine(jobs, registry, { scopeFor });
    try {
      const id = tasks.start("slow", {}, { profile: "kids" });
      exposed = false;
      jobs.startWorker({ intervalMs: 10 });
      const job = await tasks.wait(id, 5000);
      expect(job?.status).toBe("failed");
      expect(job?.error).toMatch(/the tool slow is not available in this profile/);
      expect(jobErrorCode(job!)).toBe("TOOL_ERROR");
      expect(ran).toBe(0);

      // Still exposed: the same queued call runs.
      exposed = true;
      const id2 = tasks.start("slow", {}, { profile: "kids" });
      const job2 = await tasks.wait(id2, 5000);
      expect(job2?.status).toBe("succeeded");
      expect(ran).toBe(1);
    } finally {
      jobs.stopWorker();
      db.close();
    }
  });
});
