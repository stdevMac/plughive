// Long-running tools (MCP tasks and the job fallback), progress, and the
// missing-key flow (URL elicitation, text fallback, the local setup page).
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOB_RETENTION_MS, JobQueue } from "../../src/lib/jobs.js";
import {
  type LiteHarness,
  TASK_CAPS,
  bootLite,
  legacyClient,
  mockTool,
  modernClient,
  needsSecretTool,
  rawModern,
  toolJson,
  until,
} from "./harness.js";

const SECRET_VALUE = "sk-demo-VALUE-that-must-not-leak-9431";
const URL_CAPS = { elicitation: { url: {} } };

describe("long-running tools", () => {
  let h: LiteHarness;
  let aborted: boolean;
  beforeEach(async () => {
    aborted = false;
    h = await bootLite({
      packs: {
        demo: [
          mockTool(
            "render",
            async (input, ctx) => {
              ctx.progress?.(0.5, "half way");
              await new Promise((resolve) => setTimeout(resolve, 60));
              return { doubled: Number(input.n) * 2 };
            },
            { longRunning: true },
          ),
          mockTool(
            "explode",
            async () => {
              throw new Error("boom");
            },
            { longRunning: true },
          ),
          mockTool(
            "forever",
            (_input, ctx) =>
              new Promise((resolve) => {
                ctx.signal?.addEventListener("abort", () => {
                  aborted = true;
                  resolve("late");
                });
              }),
            { longRunning: true },
          ),
          mockTool("quick", async (input, ctx) => {
            ctx.progress?.(0.25, "started");
            ctx.progress?.(1, "done");
            return { n: input.n };
          }),
        ],
      },
    });
  });
  afterEach(() => h.close());

  const call = (name: string, args: Record<string, unknown>, caps?: Record<string, unknown>) =>
    rawModern(h.base, "tools/call", { name, arguments: args }, caps ? { capabilities: caps } : {});
  const getTask = (taskId: string, caps: Record<string, unknown> = TASK_CAPS) =>
    rawModern(h.base, "tasks/get", { taskId }, { capabilities: caps });

  it("a client that declares the tasks extension gets a task and polls it to completion", async () => {
    const created = await call("render", { n: 21 }, TASK_CAPS);
    expect(created.status).toBe(200);
    expect(created.result).toMatchObject({
      resultType: "task",
      status: "working",
      pollIntervalMs: 1000,
    });
    // A real lifetime: the job row is kept for the retention period.
    expect(created.result?.ttlMs).toBe(JOB_RETENTION_MS);
    // SDK 2.4.0 adds an empty `content` to every tools/call result; nothing else rides along.
    expect(created.result?.content ?? []).toEqual([]);
    const taskId: string = created.result?.taskId;
    expect(taskId).toEqual(expect.any(String));
    expect(Date.parse(created.result?.createdAt)).not.toBeNaN();

    const done = await until(async () => {
      const reply = await getTask(taskId);
      return reply.result?.status === "completed" ? reply.result : undefined;
    });
    expect(done.taskId).toBe(taskId);
    expect(JSON.parse(done.result.content[0].text)).toEqual({ ok: true, result: { doubled: 42 } });
    expect(done.result.isError).toBeUndefined();
    // The same job is visible to the job tools.
    expect(h.jobs.get(taskId)).toMatchObject({ status: "succeeded", progress: 0.5 });
  });

  it("the SDK client can poll a task with a raw request", async () => {
    const created = await call("render", { n: 1 }, TASK_CAPS);
    const client = await modernClient(h.base, { capabilities: TASK_CAPS });
    try {
      const { z } = await import("zod");
      const state = await until(async () => {
        const reply = await client.request(
          { method: "tasks/get", params: { taskId: created.result?.taskId } } as never,
          z.looseObject({ status: z.string() }) as never,
        );
        return (reply as { status: string }).status === "completed" ? reply : undefined;
      });
      expect(state).toMatchObject({ status: "completed" });
    } finally {
      await client.close();
    }
  });

  it("task methods need the extension on the request and a known id", async () => {
    const created = await call("render", { n: 1 }, TASK_CAPS);
    const undeclared = await getTask(created.result?.taskId, {});
    expect(undeclared.error?.code).toBe(-32021);
    expect(undeclared.result).toBeUndefined();
    expect(
      (await rawModern(h.base, "tasks/cancel", { taskId: created.result?.taskId })).error?.code,
    ).toBe(-32021);
    expect((await getTask("01NOPE")).error?.code).toBe(-32602);
    expect((await getTask("x".repeat(500))).error?.code).toBe(-32602);
    expect(
      (await rawModern(h.base, "tasks/get", {}, { capabilities: TASK_CAPS })).error?.code,
    ).toBe(-32602);
    expect(
      (await rawModern(h.base, "tasks/cancel", { taskId: "01NOPE" }, { capabilities: TASK_CAPS }))
        .error?.code,
    ).toBe(-32602);
  });

  it("tasks/cancel stops the tool and the task ends cancelled", async () => {
    const created = await call("forever", {}, TASK_CAPS);
    const taskId: string = created.result?.taskId;
    await until(() => h.jobs.get(taskId)?.status === "running");
    const cancelled = await rawModern(
      h.base,
      "tasks/cancel",
      { taskId },
      { capabilities: TASK_CAPS },
    );
    expect(cancelled.result).toBeDefined();
    expect(cancelled.error).toBeUndefined();
    await until(() => aborted);
    const state = await until(async () => {
      const reply = await getTask(taskId);
      return reply.result?.status === "cancelled" ? reply.result : undefined;
    });
    expect(state.result).toBeUndefined();
    // Cancelling again is acknowledged and changes nothing.
    expect(
      (await rawModern(h.base, "tasks/cancel", { taskId }, { capabilities: TASK_CAPS })).error,
    ).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(h.jobs.get(taskId)?.status).toBe("cancelled");
  });

  it("L2: a tool that threw is a failed task with an error, never a completed one", async () => {
    const created = await call("explode", {}, TASK_CAPS);
    const done = await until(async () => {
      const reply = await getTask(created.result?.taskId);
      return reply.result && reply.result.status !== "working" ? reply.result : undefined;
    });
    expect(done.status).toBe("failed");
    expect(done.result).toBeUndefined();
    expect(done.error).toMatchObject({
      code: -32603,
      message: "boom",
      data: { code: "TOOL_ERROR" },
    });
  });

  it("L2: a tool unloaded between enqueue and run is a failed task, not a protocol error", async () => {
    h.jobs.stopWorker();
    const created = await call("render", { n: 2 }, TASK_CAPS);
    const taskId: string = created.result?.taskId;
    h.registry.unregisterPack("demo");
    h.jobs.startWorker({ intervalMs: 20 });
    const done = await until(async () => {
      const reply = await getTask(taskId);
      expect(reply.error).toBeUndefined();
      return reply.result && reply.result.status !== "working" ? reply.result : undefined;
    });
    expect(done.status).toBe("failed");
    expect(done.error.message).toContain("no longer available");
  });

  it("L2: a finished task reads the same from the job row after a restart", async () => {
    const created = await call("render", { n: 5 }, TASK_CAPS);
    const taskId: string = created.result?.taskId;
    await until(() => h.jobs.get(taskId)?.status === "succeeded");
    const first = (await getTask(taskId)).result;
    // Everything the reply says is in the job row, which is all a restarted daemon has.
    const { taskState } = await import("../../src/core/mcp/tasks.js");
    const db = new Database(join(h.home, "jobs.db"));
    const row = new JobQueue({ db, concurrency: 1 }).get(taskId);
    db.close();
    expect(row).toMatchObject({ status: "succeeded", result: { doubled: 10 } });
    expect(taskState(row!, JOB_RETENTION_MS)).toMatchObject({
      taskId,
      status: "completed",
      createdAt: first!.createdAt,
    });
    expect(first).toMatchObject({ status: "completed", ttlMs: JOB_RETENTION_MS });
    expect(JSON.parse(first!.result.content[0].text)).toEqual({
      ok: true,
      result: { doubled: 10 },
    });
  });

  it("invalid arguments start no job", async () => {
    const reply = await call("render", { n: "x" }, TASK_CAPS);
    expect(reply.error?.code).toBe(-32602);
    expect(reply.error?.message).toContain("invalid arguments for render");
  });

  it.each([["legacy"], ["modern"]])(
    "a %s client without the extension gets a job id and waits with wait_for_job",
    async (era) => {
      const client = await (era === "legacy" ? legacyClient : modernClient)(h.base);
      try {
        const names = (await client.listTools()).tools.map((t) => t.name);
        expect(names).toContain("wait_for_job");
        expect(names).toContain("cancel_job");
        const started = toolJson(await client.callTool({ name: "render", arguments: { n: 4 } }));
        expect(started).toEqual({
          ok: true,
          // L3: only tools this caller can call are named (get_job_status is not exposed here).
          result: {
            job_id: expect.any(String),
            status: "queued",
            wait_with: "wait_for_job",
            cancel_with: "cancel_job",
          },
        });
        const jobId: string = started.result.job_id;

        const waited = toolJson(
          await client.callTool({
            name: "wait_for_job",
            arguments: { job_id: jobId, timeout_s: 10 },
          }),
        );
        expect(waited.result).toMatchObject({
          job_id: jobId,
          status: "succeeded",
          done: true,
          result: { doubled: 8 },
        });

        // Still running after the timeout: not an error, with a hint to call again.
        const slow = toolJson(await client.callTool({ name: "forever", arguments: {} }));
        const pending = toolJson(
          await client.callTool({
            name: "wait_for_job",
            arguments: { job_id: slow.result.job_id, timeout_s: 1 },
          }),
        );
        expect(pending.result).toMatchObject({
          done: false,
          hint: expect.stringContaining("wait_for_job"),
        });
        expect(pending.result.result).toBeUndefined();
        h.jobs.cancel(slow.result.job_id);

        const failed = toolJson(await client.callTool({ name: "explode", arguments: {} }));
        const failure = toolJson(
          await client.callTool({
            name: "wait_for_job",
            arguments: { job_id: failed.result.job_id, timeout_s: 10 },
          }),
        );
        expect(failure.result).toMatchObject({
          status: "failed",
          done: true,
          error: { code: "JOB_FAILED", message: "boom" },
        });

        const unknown = await client.callTool({
          name: "wait_for_job",
          arguments: { job_id: "01NOPE", timeout_s: 1 },
        });
        expect(unknown.isError).toBe(true);
        expect(toolJson(unknown).error.message).toContain("not found");
      } finally {
        await client.close();
      }
    },
  );

  it("a legacy request never gets a task, even when it claims the extension", async () => {
    const client = await legacyClient(h.base, { capabilities: TASK_CAPS });
    try {
      const started = await client.callTool({ name: "render", arguments: { n: 1 } });
      expect((started as { resultType?: string }).resultType).not.toBe("task");
      expect(toolJson(started).result.wait_with).toBe("wait_for_job");
    } finally {
      await client.close();
    }
  });

  it("progress reaches the caller as notifications/progress when a token was sent", async () => {
    const reply = await rawModern(
      h.base,
      "tools/call",
      { name: "quick", arguments: { n: 3 } },
      { progressToken: "tok-1" },
    );
    expect(JSON.parse(reply.result?.content[0].text)).toEqual({ ok: true, result: { n: 3 } });
    const progress = reply.notifications
      .filter((n) => n.method === "notifications/progress")
      .map((n) => n.params);
    expect(progress).toEqual([
      { progressToken: "tok-1", progress: 0.25, total: 1, message: "started" },
      { progressToken: "tok-1", progress: 1, total: 1, message: "done" },
    ]);
    const silent = await rawModern(h.base, "tools/call", { name: "quick", arguments: {} });
    expect(silent.notifications).toEqual([]);

    const client = await modernClient(h.base);
    try {
      const seen: number[] = [];
      await client.callTool(
        { name: "quick", arguments: {} },
        { onprogress: (p) => void seen.push(p.progress) },
      );
      expect(seen).toEqual([0.25, 1]);
    } finally {
      await client.close();
    }
  });
});

describe("missing keys", () => {
  let h: LiteHarness;
  beforeEach(async () => {
    h = await bootLite({ packs: { demo: [needsSecretTool("needs_key", () => h.secrets)] } });
  });
  afterEach(() => h.close());

  const askForSetupUrl = async (): Promise<string> => {
    const reply = await rawModern(
      h.base,
      "tools/call",
      { name: "needs_key", arguments: {} },
      { capabilities: URL_CAPS },
    );
    expect(reply.result?.resultType).toBe("input_required");
    const request = reply.result?.inputRequests.secret_setup;
    expect(request).toMatchObject({ method: "elicitation/create", params: { mode: "url" } });
    expect(request.params.message).toContain("DEMO_API_KEY");
    return request.params.url;
  };
  const tokenOf = (url: string) => new URL(url).searchParams.get("token") ?? "";
  /** What the browser keeps from rendering the page: the setup cookie (empty when none was set). */
  const renderCookie = async (token: string): Promise<string> => {
    const page = await fetch(`${h.base}/setup/secret?token=${encodeURIComponent(token)}`);
    await page.arrayBuffer();
    return (page.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
  };
  /** The form as a browser posts it: the page is rendered first, its cookie is sent back. */
  const submit = async (
    fields: Record<string, string>,
    headers: Record<string, string> = { origin: h.base },
    { render = true }: { render?: boolean } = {},
  ) => {
    const cookie = render && fields.token !== undefined ? await renderCookie(fields.token) : "";
    return fetch(`${h.base}/setup/secret`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: new URLSearchParams(fields).toString(),
    });
  };
  const everythingLogged = () => JSON.stringify(h.logs);

  it("a client with URL elicitation is sent to the setup page, and the retried call succeeds", async () => {
    const client = await modernClient(h.base, { capabilities: URL_CAPS });
    const seen: Array<Record<string, any>> = [];
    try {
      client.setRequestHandler("elicitation/create", async (req) => {
        const params = req.params as Record<string, any>;
        seen.push(params);
        // What the user does in the browser: open the page, submit the form.
        const page = await fetch(params.url);
        expect(page.status).toBe(200);
        const saved = await submit({ token: tokenOf(params.url), value: SECRET_VALUE });
        expect(saved.status).toBe(200);
        return { action: "accept" } as never;
      });
      const result = await client.callTool({ name: "needs_key", arguments: {} });
      expect(toolJson(result)).toEqual({ ok: true, result: { used_key: true } });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ mode: "url" });
      expect(seen[0]!.url.startsWith(`${h.base}/setup/secret?token=`)).toBe(true);
      expect(JSON.stringify(seen)).not.toContain(SECRET_VALUE);
      expect(JSON.stringify(result)).not.toContain(SECRET_VALUE);
      expect(h.secrets.get("DEMO_API_KEY")).toBe(SECRET_VALUE);
      expect(everythingLogged()).not.toContain(SECRET_VALUE);
    } finally {
      await client.close();
    }
  });

  it("asks once: a client that accepts without setting the key gets the text error", async () => {
    const client = await modernClient(h.base, { capabilities: URL_CAPS });
    let asked = 0;
    try {
      client.setRequestHandler("elicitation/create", async () => {
        asked += 1;
        return { action: "accept" } as never;
      });
      const result = await client.callTool({ name: "needs_key", arguments: {} });
      expect(asked).toBe(1);
      expect(result.isError).toBe(true);
      expect(toolJson(result).error.code).toBe("MISSING_SECRET");
    } finally {
      await client.close();
    }
  });

  it.each([["legacy"], ["modern"]])(
    "a %s client without URL elicitation gets an explanatory error",
    async (era) => {
      const client = await (era === "legacy" ? legacyClient : modernClient)(h.base, {
        // Declaring it on a legacy client changes nothing: a legacy request cannot be asked.
        ...(era === "legacy" ? { capabilities: URL_CAPS } : {}),
      });
      try {
        const result = await client.callTool({ name: "needs_key", arguments: {} });
        expect(result.isError).toBe(true);
        expect(toolJson(result)).toMatchObject({
          ok: false,
          error: { code: "MISSING_SECRET", pack: "demo", secret: "DEMO_API_KEY" },
        });
        const help = (result.content as Array<{ text: string }>)[1]!.text;
        expect(help).toContain("DEMO_API_KEY (Demo API key)");
        expect(help).toContain('pack "demo"');
        expect(help).toContain(`${h.base}/`);
        expect(help).toContain("environment variable DEMO_API_KEY");
        expect(help).toContain("https://example.com/keys");
        expect(help).not.toContain("token=");
        expect(help).not.toContain("—");
      } finally {
        await client.close();
      }
    },
  );

  describe("setup page", () => {
    it("serves a locked-down form that names the key and never a value", async () => {
      const url = await askForSetupUrl();
      const page = await fetch(url);
      expect(page.status).toBe(200);
      const csp = page.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'none'");
      expect(csp).toContain("form-action 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(page.headers.get("cache-control")).toBe("no-store");
      expect(page.headers.get("referrer-policy")).toBe("same-origin");
      expect(page.headers.get("x-frame-options")).toBe("DENY");
      expect(page.headers.get("x-content-type-options")).toBe("nosniff");
      const html = await page.text();
      expect(html).toContain("DEMO_API_KEY");
      expect(html).toContain("Demo API key");
      expect(html).toContain('type="password"');
      expect(html).toContain("https://example.com/keys");
      expect(html).not.toContain("<script");
    });

    it("stores the value once; the link cannot be reused", async () => {
      const token = tokenOf(await askForSetupUrl());
      const saved = await submit({ token, value: `  ${SECRET_VALUE}\n` });
      expect(saved.status).toBe(200);
      const html = await saved.text();
      expect(html).toContain("Key saved");
      expect(html).not.toContain(SECRET_VALUE);
      expect(h.secrets.get("DEMO_API_KEY")).toBe(SECRET_VALUE);

      const again = await submit({ token, value: "another-value-1234" });
      expect(again.status).toBe(400);
      expect(await again.text()).toContain("already used");
      expect(h.secrets.get("DEMO_API_KEY")).toBe(SECRET_VALUE);
      const reopened = await fetch(`${h.base}/setup/secret?token=${token}`);
      expect(reopened.status).toBe(400);
      expect(await reopened.text()).toContain("already used");

      expect(everythingLogged()).not.toContain(SECRET_VALUE);
      expect(everythingLogged()).not.toContain("another-value-1234");
      expect(h.logs.some((l) => l.msg === "secret set through the setup page")).toBe(true);
    });

    it("rejects tampered, foreign and missing tokens", async () => {
      const token = tokenOf(await askForSetupUrl());
      const [body, sig] = token.split(".") as [string, string];
      const claim = JSON.parse(Buffer.from(body, "base64url").toString());
      const forged = Buffer.from(JSON.stringify({ ...claim, secret: "OTHER_API_KEY" })).toString(
        "base64url",
      );
      for (const bad of [
        `${forged}.${sig}`,
        `${body}.${"A".repeat(sig.length)}`,
        body,
        "garbage",
        "",
      ]) {
        const page = await fetch(`${h.base}/setup/secret?token=${encodeURIComponent(bad)}`);
        expect(page.status).toBe(400);
        expect(await page.text()).toContain("not valid");
        const post = await submit({ token: bad, value: SECRET_VALUE });
        expect(post.status).toBe(400);
        expect(await post.text()).not.toContain(SECRET_VALUE);
      }
      expect((await fetch(`${h.base}/setup/secret`)).status).toBe(400);
      expect((await fetch(`${h.base}/setup/secret?token=a&token=b`)).status).toBe(400);
      expect(h.secrets.size).toBe(0);
      // The untouched token still works.
      expect((await submit({ token, value: SECRET_VALUE })).status).toBe(200);
    });

    it("C1: refuses the form from another origin or another site", async () => {
      const token = tokenOf(await askForSetupUrl());
      for (const headers of [
        { origin: "https://evil.example" },
        { origin: "http://127.0.0.1:1" },
        { origin: "null", "sec-fetch-site": "cross-site" },
        { "sec-fetch-site": "cross-site" },
        { origin: h.base, "sec-fetch-site": "same-site" },
        { origin: h.base, "sec-fetch-site": "none" },
        { origin: "https://evil.example", "sec-fetch-site": "same-origin" },
        // M1: no fetch metadata and no Origin is what curl or a script sends.
        {},
        { origin: "null" },
        { origin: "" },
      ] as Array<Record<string, string>>) {
        const res = await submit({ token, value: SECRET_VALUE }, headers);
        expect(res.status).toBe(403);
        expect(await res.text()).not.toContain(SECRET_VALUE);
      }
      expect(h.secrets.size).toBe(0);
      // A refused submission does not burn the token.
      expect((await submit({ token, value: SECRET_VALUE })).status).toBe(200);
    });

    it("M1: a blind POST of a handed-out token stores nothing (the reviewer's curl proof)", async () => {
      const token = tokenOf(await askForSetupUrl());
      // curl -X POST /setup/secret --data-urlencode token=... --data-urlencode value=...
      const blind = await submit({ token, value: SECRET_VALUE }, {}, { render: false });
      expect(blind.status).toBe(403);
      // Forging the browser headers is not enough without the page's cookie.
      for (const headers of [
        { origin: h.base, "sec-fetch-site": "same-origin" },
        { origin: "null", "sec-fetch-site": "same-origin" },
        { origin: h.base },
      ] as Array<Record<string, string>>) {
        const res = await submit({ token, value: SECRET_VALUE }, headers, { render: false });
        expect(res.status).toBe(403);
        expect(await res.text()).toContain("Open the setup link in your browser");
      }
      // A cookie from another link, or a tampered one, does not count.
      const other = tokenOf(await askForSetupUrl());
      const otherCookie = await renderCookie(other);
      const [name] = (await renderCookie(token)).split("=") as [string];
      const borrowed = `${name}=${otherCookie.split("=")[1]}`;
      for (const cookie of [otherCookie, borrowed, `${name}=x.y`, `${name}=`]) {
        const res = await submit(
          { token, value: SECRET_VALUE },
          { origin: h.base, "sec-fetch-site": "same-origin", cookie },
          { render: false },
        );
        expect(res.status, cookie).toBe(403);
      }
      expect(h.secrets.size).toBe(0);
      expect(everythingLogged()).not.toContain(SECRET_VALUE);
      // Refused submissions do not burn the link: the real browser flow still works.
      expect((await submit({ token, value: SECRET_VALUE })).status).toBe(200);
    });

    it("M1: the render cookie is HttpOnly, SameSite=Strict, scoped to /setup, fresh per render", async () => {
      const url = await askForSetupUrl();
      const first = (await fetch(url)).headers.getSetCookie();
      const second = (await fetch(url)).headers.getSetCookie();
      expect(first).toHaveLength(1);
      const attrs = first[0]!.split(";").map((s) => s.trim().toLowerCase());
      expect(attrs).toEqual(
        expect.arrayContaining(["path=/setup", "httponly", "samesite=strict", "max-age=600"]),
      );
      expect(attrs).not.toContain("secure"); // plain http on loopback
      expect(first[0]!.split(";")[0]).not.toBe(second[0]!.split(";")[0]);
      expect(first[0]!.split("=")[0]).toBe(second[0]!.split("=")[0]);
      expect(first[0]).not.toContain(tokenOf(url));
      // Either render's cookie is accepted.
      const res = await submit(
        { token: tokenOf(url), value: SECRET_VALUE },
        { origin: h.base, cookie: first[0]!.split(";")[0]! },
        { render: false },
      );
      expect(res.status).toBe(200);
      // A save clears the cookie.
      expect(res.headers.getSetCookie().join(";")).toMatch(/max-age=0/i);
    });

    // The exact headers each browser sends when the form on the page is submitted
    // (the page is served with Referrer-Policy: same-origin). SELF is the daemon's origin.
    const NAVIGATE = {
      "sec-fetch-mode": "navigate",
      "sec-fetch-dest": "document",
      "sec-fetch-user": "?1",
    };
    it.each([
      ["Chrome / Edge", { origin: "SELF", "sec-fetch-site": "same-origin", ...NAVIGATE }],
      ["Firefox 90+", { origin: "SELF", "sec-fetch-site": "same-origin", ...NAVIGATE }],
      [
        "Safari 16.4+",
        {
          origin: "SELF",
          "sec-fetch-site": "same-origin",
          "sec-fetch-mode": "navigate",
          "sec-fetch-dest": "document",
        },
      ],
      ["Safari before 16.4 (no fetch metadata)", { origin: "SELF" }],
      [
        "Chromium with a strict referrer policy",
        { origin: "null", "sec-fetch-site": "same-origin", ...NAVIGATE },
      ],
      ["a browser that sends no Origin", { "sec-fetch-site": "same-origin" }],
    ] as Array<[string, Record<string, string>]>)(
      "C1: accepts the form as posted by %s",
      async (_who, raw) => {
        const token = tokenOf(await askForSetupUrl());
        const headers = Object.fromEntries(
          Object.entries(raw).map(([k, v]) => [k, v === "SELF" ? h.base : v]),
        );
        const res = await submit({ token, value: SECRET_VALUE }, headers);
        expect(res.status).toBe(200);
        expect(h.secrets.get("DEMO_API_KEY")).toBe(SECRET_VALUE);
        // The link is dead after a save: neither the form nor a second post works.
        expect((await fetch(`${h.base}/setup/secret?token=${token}`)).status).toBe(400);
        expect((await submit({ token, value: "replayed-value-000" }, headers)).status).toBe(400);
        expect(h.secrets.get("DEMO_API_KEY")).toBe(SECRET_VALUE);
      },
    );

    it("C1: a multi-line value (PEM) is stored whole through the textarea mode", async () => {
      const url = await askForSetupUrl();
      const page = await (await fetch(`${url}&multiline=1`)).text();
      expect(page).toContain("<textarea");
      expect(page).not.toContain('type="password"');
      expect(await (await fetch(url)).text()).toContain("multiline=1");
      const pem = [
        "-----BEGIN PRIVATE KEY-----",
        "x".repeat(64),
        "y".repeat(64),
        "-----END PRIVATE KEY-----",
      ];
      // Browsers submit textarea line breaks as CRLF.
      const res = await submit(
        { token: tokenOf(url), value: `${pem.join("\r\n")}\r\n` },
        {
          origin: "null",
          "sec-fetch-site": "same-origin",
        },
      );
      expect(res.status).toBe(200);
      expect(h.secrets.get("DEMO_API_KEY")).toBe(pem.join("\n"));
      expect(everythingLogged()).not.toContain("BEGIN PRIVATE KEY");
    });

    it("refuses empty and oversized values without burning the link", async () => {
      const token = tokenOf(await askForSetupUrl());
      expect((await submit({ token, value: "   " })).status).toBe(400);
      expect((await submit({ token })).status).toBe(400);
      expect((await submit({ token, value: "x".repeat(8193) })).status).toBe(400);
      expect((await submit({ token, value: "x".repeat(40_000) })).status).toBe(413);
      expect(h.secrets.size).toBe(0);
      expect((await submit({ token, value: SECRET_VALUE })).status).toBe(200);
    });
  });
});

describe("missing keys behind an access key", () => {
  it("the setup page works without the access key; the token is the authorization", async () => {
    const KEY = "test-access-key-0123456789";
    const h: LiteHarness = await bootLite({
      accessKey: KEY,
      packs: { demo: [needsSecretTool("needs_key", () => h.secrets)] },
    });
    try {
      const client = await modernClient(h.base, {
        capabilities: URL_CAPS,
        headers: { authorization: `Bearer ${KEY}` },
      });
      let url = "";
      client.setRequestHandler("elicitation/create", async (req) => {
        url = (req.params as { url: string }).url;
        return { action: "decline" } as never;
      });
      const result = await client.callTool({ name: "needs_key", arguments: {} });
      await client.close();
      expect(result.isError).toBe(true);
      expect((await fetch(url)).status).toBe(200);
      expect((await fetch(`${h.base}/setup/secret?token=nope`)).status).toBe(400);
    } finally {
      await h.close();
    }
  });
});

describe("M1: a setup link never replaces a key that is set", () => {
  it("refuses at render time and at submit time once the key has a value", async () => {
    const h: LiteHarness = await bootLite({
      packs: { demo: [needsSecretTool("needs_key", () => h.secrets)] },
      hasSecret: (name) => h.secrets.has(name),
    });
    try {
      const ask = async () => {
        const reply = await rawModern(
          h.base,
          "tools/call",
          { name: "needs_key", arguments: {} },
          { capabilities: URL_CAPS },
        );
        return new URL(reply.result?.inputRequests.secret_setup.params.url as string);
      };
      const url = await ask();
      const token = url.searchParams.get("token") ?? "";
      const page = await fetch(url);
      expect(page.status).toBe(200);
      const html = await page.text();
      // The page says which pack and which key it is for.
      expect(html).toContain("<code>demo</code>");
      expect(html).toContain("<code>DEMO_API_KEY</code>");
      const cookie = (page.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";

      // The user sets the key some other way while the link is still open.
      h.secrets.set("DEMO_API_KEY", "set-from-the-dashboard");
      const res = await fetch(`${h.base}/setup/secret`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: h.base,
          "sec-fetch-site": "same-origin",
          cookie,
        },
        body: new URLSearchParams({ token, value: SECRET_VALUE }).toString(),
      });
      expect(res.status).toBe(409);
      const refused = await res.text();
      expect(refused).toContain("Key already set");
      expect(refused).toContain("DEMO_API_KEY");
      expect(refused).not.toContain(SECRET_VALUE);
      expect(h.secrets.get("DEMO_API_KEY")).toBe("set-from-the-dashboard");

      // A fresh link for a key that is set shows the same page and sets no cookie.
      h.secrets.delete("DEMO_API_KEY");
      const next = await ask();
      h.secrets.set("DEMO_API_KEY", "set-from-the-dashboard");
      const again = await fetch(next);
      expect(again.status).toBe(409);
      expect(await again.text()).toContain("Key already set");
      expect(again.headers.getSetCookie()).toHaveLength(0);
    } finally {
      await h.close();
    }
  });
});
