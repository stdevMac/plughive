// Triggers over HTTP: /api/triggers (admin, CSRF) and signed webhooks at
// /hooks/<id> that start a workflow job, with every refusal (bad signature,
// stale timestamp, replay, oversize body, rate limit).
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { sign } from "../../src/core/triggers/service.js";
import { ADMIN_AUTH, type LiteHarness, bootLite, mockTool, until } from "./harness.js";

const CSRF = { "x-plughive-csrf": "1", "content-type": "application/json" };
const callbacks: Array<{ url: string; body: string }> = [];

let h: LiteHarness;
const runs: Array<Record<string, unknown>> = [];

beforeAll(async () => {
  h = await bootLite({
    packs: {
      workflows: [
        mockTool(
          "wf_digest",
          async (i) => {
            runs.push(i);
            return { done: i.topic };
          },
          { input: z.object({ topic: z.string(), n: z.number().default(1) }), longRunning: true },
        ),
      ],
      demo: [mockTool("not_a_workflow", async () => 1)],
    },
    triggers: {
      hookRatePerMinute: 8,
      tickMs: 50,
      fetch: async (url: string, init: RequestInit) => {
        callbacks.push({ url, body: String(init.body) });
        return new Response(null, { status: 200 });
      },
    },
  });
});
afterAll(async () => {
  await h?.close();
});

const api = (path: string, init: RequestInit = {}) =>
  fetch(`${h.base}/api/triggers${path}`, {
    ...init,
    headers: { ...ADMIN_AUTH, ...CSRF, ...(init.headers as Record<string, string>) },
  });

async function createHook(extra: Record<string, unknown> = {}) {
  const res = await api("", {
    method: "POST",
    body: JSON.stringify({ name: "hook", kind: "webhook", workflow: "wf_digest", ...extra }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as { trigger: { id: string; webhook_url: string }; secret: string };
}

function signed(secret: string, body: string, ts = Math.floor(Date.now() / 1000)) {
  const t = String(ts);
  return {
    "content-type": "application/json",
    "x-plughive-timestamp": t,
    "x-plughive-signature": sign(secret, t, body),
  };
}

describe("/api/triggers", () => {
  it("needs the admin token and the CSRF header", async () => {
    expect((await fetch(`${h.base}/api/triggers`)).status).toBe(401);
    const noCsrf = await fetch(`${h.base}/api/triggers`, {
      method: "POST",
      headers: { ...ADMIN_AUTH, "content-type": "application/json" },
      body: JSON.stringify({ name: "x", kind: "webhook", workflow: "wf_digest" }),
    });
    expect(noCsrf.status).toBe(403);
  });

  it("validates the workflow, the schedule and the args", async () => {
    const post = (body: Record<string, unknown>) =>
      api("", { method: "POST", body: JSON.stringify(body) });
    const bad = async (body: Record<string, unknown>, code: string) => {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe(code);
    };
    await bad(
      { name: "a", kind: "cron", workflow: "not_a_workflow", schedule: "* * * * *" },
      "UNKNOWN_WORKFLOW",
    );
    await bad(
      {
        name: "a",
        kind: "cron",
        workflow: "wf_digest",
        schedule: "61 * * * *",
        args: { topic: "t" },
      },
      "INVALID_SCHEDULE",
    );
    await bad(
      {
        name: "a",
        kind: "cron",
        workflow: "wf_digest",
        schedule: "0 0 31 2 *",
        args: { topic: "t" },
      },
      "INVALID_SCHEDULE",
    );
    await bad(
      { name: "a", kind: "cron", workflow: "wf_digest", schedule: "* * * * *" },
      "INVALID_INPUT",
    );
    await bad(
      {
        name: "a",
        kind: "webhook",
        workflow: "wf_digest",
        callback: { type: "webhook", url: "ftp://x" },
      },
      "INVALID_REQUEST",
    );
  });

  it("creates, lists (no secret), disables, runs and deletes a cron trigger", async () => {
    const res = await api("", {
      method: "POST",
      body: JSON.stringify({
        name: "nightly",
        kind: "cron",
        workflow: "wf_digest",
        schedule: "0 3 * * *",
        args: { topic: "news" },
      }),
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as {
      trigger: { id: string; next_run_at: string };
      secret: string;
    };
    expect(created.secret).toMatch(/^whsec_/);
    expect(created.trigger.next_run_at).toMatch(/T03:00:00/);
    const list = (await (await api("")).json()) as { triggers: Array<Record<string, unknown>> };
    expect(JSON.stringify(list)).not.toContain(created.secret);
    const id = created.trigger.id;
    const off = await api(`/${id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    expect(
      ((await off.json()) as { trigger: { enabled: boolean; next_run_at: unknown } }).trigger,
    ).toMatchObject({
      enabled: false,
      next_run_at: null,
    });
    const run = await api(`/${id}/run`, { method: "POST" });
    expect(run.status).toBe(202);
    const { job_id } = (await run.json()) as { job_id: string };
    await until(() => h.jobs.get(job_id)?.status === "succeeded");
    const detail = (await (await api(`/${id}`)).json()) as {
      trigger: { last_run: { job_id: string } };
      runs: unknown[];
    };
    expect(detail.trigger.last_run.job_id).toBe(job_id);
    expect(detail.runs).toHaveLength(1);
    expect((await api(`/${id}`, { method: "DELETE" })).status).toBe(200);
    expect((await api(`/${id}`)).status).toBe(404);
  });

  it("lists the loaded workflows", async () => {
    const res = (await (await api("/workflows")).json()) as { workflows: Array<{ name: string }> };
    expect(res.workflows.map((w) => w.name)).toEqual(["wf_digest"]);
  });
});

describe("/hooks/<id>", () => {
  it("starts the workflow for a signed request, with the body merged over the args", async () => {
    const { trigger, secret } = await createHook({
      use_body: true,
      args: { n: 2 },
      callback: { type: "webhook", url: "https://example.com/done" },
    });
    expect(trigger.webhook_url).toBe(`${h.base}/hooks/${trigger.id}`);
    const body = JSON.stringify({ topic: "from-hook" });
    const res = await fetch(trigger.webhook_url, {
      method: "POST",
      headers: signed(secret, body),
      body,
    });
    expect(res.status).toBe(202);
    const { job_id } = (await res.json()) as { job_id: string };
    const job = await until(() => {
      const j = h.jobs.get(job_id);
      return j?.status === "succeeded" ? j : undefined;
    });
    expect(job.result).toEqual({ done: "from-hook" });
    expect(runs.at(-1)).toEqual({ topic: "from-hook", n: 2 });
    // The job-done callback goes out once.
    await until(() => callbacks.some((c) => c.body.includes(job_id)));
    await new Promise((r) => setTimeout(r, 200));
    const mine = callbacks.filter((c) => c.body.includes(job_id));
    expect(mine).toHaveLength(1);
    expect(JSON.parse(mine[0]?.body ?? "{}")).toMatchObject({
      status: "succeeded",
      result: { done: "from-hook" },
    });
  });

  it("refuses a bad signature, a stale timestamp, a replay and an unknown hook", async () => {
    const { trigger, secret } = await createHook({ args: { topic: "t" } });
    const body = "{}";
    const send = (headers: Record<string, string>, b = body) =>
      fetch(trigger.webhook_url, { method: "POST", headers, body: b });
    const code = async (r: Response) =>
      ((await r.json()) as { error: { code: string } }).error.code;

    const wrong = await send(signed("whsec_wrong", body));
    expect([wrong.status, await code(wrong)]).toEqual([401, "BAD_SIGNATURE"]);
    const tampered = await send(signed(secret, body), '{"x":1}');
    expect([tampered.status, await code(tampered)]).toEqual([401, "BAD_SIGNATURE"]);
    const stale = await send(signed(secret, body, Math.floor(Date.now() / 1000) - 3600));
    expect([stale.status, await code(stale)]).toEqual([401, "STALE_TIMESTAMP"]);
    const noTs = await send({ "x-plughive-signature": "sha256=00" });
    expect([noTs.status, await code(noTs)]).toEqual([401, "BAD_TIMESTAMP"]);

    const headers = signed(secret, body);
    expect((await send(headers)).status).toBe(202);
    const replay = await send(headers);
    expect([replay.status, await code(replay)]).toEqual([409, "REPLAYED"]);

    const unknown = await fetch(`${h.base}/hooks/trg_doesnotexist`, {
      method: "POST",
      headers,
      body,
    });
    expect(unknown.status).toBe(404);
    expect((await fetch(trigger.webhook_url)).status).toBe(405);
  });

  it("refuses an oversize body before reading it all", async () => {
    const { trigger, secret } = await createHook({ args: { topic: "t" } });
    const big = "x".repeat(300 * 1024);
    const res = await fetch(trigger.webhook_url, {
      method: "POST",
      headers: signed(secret, big),
      body: big,
    });
    expect(res.status).toBe(413);
  });

  it("refuses a disabled hook and rate-limits each hook", async () => {
    const { trigger, secret } = await createHook({ args: { topic: "t" } });
    await api(`/${trigger.id}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
    const body = "{}";
    const off = await fetch(trigger.webhook_url, {
      method: "POST",
      headers: signed(secret, body),
      body,
    });
    expect(off.status).toBe(409);
    const statuses: number[] = [];
    for (let i = 0; i < 10; i++) {
      const b = JSON.stringify({ i });
      statuses.push(
        (await fetch(trigger.webhook_url, { method: "POST", headers: signed(secret, b), body: b }))
          .status,
      );
    }
    expect(statuses).toContain(429);
  });

  it("rotating the secret invalidates the old one", async () => {
    const { trigger, secret } = await createHook({ args: { topic: "t" } });
    const rotated = (await (
      await api(`/${trigger.id}/rotate-secret`, { method: "POST" })
    ).json()) as { secret: string };
    expect(rotated.secret).not.toBe(secret);
    const body = "{}";
    expect(
      (await fetch(trigger.webhook_url, { method: "POST", headers: signed(secret, body), body }))
        .status,
    ).toBe(401);
    expect(
      (
        await fetch(trigger.webhook_url, {
          method: "POST",
          headers: signed(rotated.secret, body),
          body,
        })
      ).status,
    ).toBe(202);
  });
  // Last in the file: it spends the shared webhook budget of this server.
  it("requests for unknown hook ids do not use up the real hooks' budget", async () => {
    const { trigger, secret } = await createHook({ args: { topic: "t" } });
    const base = trigger.webhook_url.slice(0, trigger.webhook_url.lastIndexOf("/"));
    const guesses = await Promise.all(
      Array.from({ length: 90 }, (_, i) =>
        fetch(`${base}/trg_guess${String(i).padStart(4, "0")}`, { method: "POST", body: "{}" }),
      ),
    );
    const statuses = guesses.map((r) => r.status);
    expect(statuses).toContain(429);
    expect(statuses).toContain(404);
    const b = JSON.stringify({ topic: "real" });
    const real = await fetch(trigger.webhook_url, {
      method: "POST",
      headers: signed(secret, b),
      body: b,
    });
    expect(real.status).toBe(202);
  });
});
