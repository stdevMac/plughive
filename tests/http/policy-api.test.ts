// Spend approvals end to end: the admin routes (token and CSRF rule), the URL
// elicitation an MCP client is sent to, a job that waits for a decision, and
// the policy editor (an invalid or broken policy.json is never overwritten).
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writePolicy } from "../../src/core/policy/policy.js";
import {
  ADMIN_AUTH,
  type LiteHarness,
  adminFetch,
  bootLite,
  jsonBody,
  legacyClient,
  mockTool,
  modernClient,
  toolJson,
  until,
} from "./harness.js";

const URL_CAPS = { elicitation: { url: {} } };
const CSRF = { "x-plughive-csrf": "1" };

describe("spend approvals over HTTP and MCP", () => {
  let h: LiteHarness;
  let runs: number;
  beforeEach(async () => {
    runs = 0;
    h = await bootLite({
      policy: {},
      packs: {
        demo: [
          mockTool("buy", async (input) => {
            runs += 1;
            return { bought: input.n };
          }),
          mockTool(
            "buy_slow",
            async (input) => {
              runs += 1;
              return { bought: input.n };
            },
            { longRunning: true },
          ),
          mockTool("free", async () => ({ ok: 1 })),
        ],
      },
    });
    writePolicy(h.home, {
      version: 1,
      rules: { always_ask_tools: ["buy", "buy_slow"] },
    });
  });
  afterEach(() => h.close());

  const pending = async () => {
    const res = await adminFetch(`${h.base}/api/approvals?status=pending`);
    expect(res.status).toBe(200);
    return jsonBody(res);
  };
  const decide = (id: string, verb: "approve" | "deny", headers: Record<string, string> = CSRF) =>
    fetch(`${h.base}/api/approvals/${id}/${verb}`, {
      method: "POST",
      headers: { ...ADMIN_AUTH, ...headers },
    });

  it("the approval routes need the admin token, and decisions need the CSRF header", async () => {
    const client = await legacyClient(h.base);
    try {
      const first = await client.callTool({ name: "buy", arguments: { n: 2 } });
      expect(toolJson(first).error.code).toBe("APPROVAL_REQUIRED");
    } finally {
      await client.close();
    }
    expect((await fetch(`${h.base}/api/approvals`)).status).toBe(401);
    expect((await fetch(`${h.base}/api/policy`)).status).toBe(401);
    const { approvals, pending: count } = await pending();
    expect(count).toBe(1);
    const id = approvals[0].id as string;
    // No credential: refused before anything is decided.
    const anon = await fetch(`${h.base}/api/approvals/${id}/approve`, {
      method: "POST",
      headers: CSRF,
    });
    expect(anon.status).toBe(401);
    // The token without the CSRF header (and no Origin): refused.
    expect((await decide(id, "approve", {})).status).toBe(403);
    // A foreign Origin: refused.
    expect((await decide(id, "approve", { origin: "https://evil.example" })).status).toBe(403);
    expect((await pending()).pending).toBe(1);
    const ok = await decide(id, "approve");
    expect(ok.status).toBe(200);
    expect((await jsonBody(ok)).approval.status).toBe("approved");
    // Decided once only.
    expect((await decide(id, "deny")).status).toBe(409);
    expect(runs).toBe(0);
  });

  it("an MCP client with URL elicitation is sent to the approval page; the retry runs once", async () => {
    const client = await modernClient(h.base, { capabilities: URL_CAPS });
    const urls: string[] = [];
    try {
      client.setRequestHandler("elicitation/create", async (req) => {
        const url = String((req.params as Record<string, unknown>).url);
        urls.push(url);
        // What the person does on the dashboard page.
        const id = new URL(url).searchParams.get("id") ?? "";
        expect((await decide(id, "approve")).status).toBe(200);
        return { action: "accept" } as never;
      });
      const result = await client.callTool({ name: "buy", arguments: { n: 3 } });
      expect(toolJson(result)).toEqual({ ok: true, result: { bought: 3 } });
      expect(runs).toBe(1);
      expect(urls).toHaveLength(1);
      expect(urls[0]!.startsWith(`${h.base}/approvals?id=apr_`)).toBe(true);
      // The same call again needs a new approval (the first one was used).
      const again = await client.callTool({ name: "buy", arguments: { n: 3 } });
      expect(toolJson(again).ok).toBe(true);
      expect(urls).toHaveLength(2);
      expect(urls[1]).not.toBe(urls[0]);
      expect(runs).toBe(2);
    } finally {
      await client.close();
    }
  });

  it("a client without URL elicitation gets the link as text and retries itself", async () => {
    const client = await legacyClient(h.base);
    try {
      const first = await client.callTool({ name: "buy", arguments: { n: 4 } });
      expect(first.isError).toBe(true);
      const body = toolJson(first);
      expect(body.error.code).toBe("APPROVAL_REQUIRED");
      expect(body.error.approval.url).toContain("/approvals?id=apr_");
      expect(JSON.stringify(first)).toContain("same arguments");
      // Different arguments are a different request.
      const other = await client.callTool({ name: "buy", arguments: { n: 5 } });
      expect(toolJson(other).error.approval.id).not.toBe(body.error.approval.id);
      expect((await decide(body.error.approval.id, "approve")).status).toBe(200);
      expect(toolJson(await client.callTool({ name: "buy", arguments: { n: 5 } })).error.code).toBe(
        "APPROVAL_REQUIRED",
      );
      expect(toolJson(await client.callTool({ name: "buy", arguments: { n: 4 } }))).toEqual({
        ok: true,
        result: { bought: 4 },
      });
      expect(runs).toBe(1);
    } finally {
      await client.close();
    }
  });

  describe("in-chat approval forms (approve_in_chat)", () => {
    const FORM_CAPS = { elicitation: { form: {}, url: {} } };
    const optIn = () =>
      writePolicy(h.home, {
        version: 1,
        rules: { always_ask_tools: ["buy", "buy_slow"], approve_in_chat: true },
      });

    it("a form-capable client approves in the chat and the call runs once", async () => {
      optIn();
      const client = await modernClient(h.base, { capabilities: FORM_CAPS });
      const asked: Record<string, unknown>[] = [];
      try {
        client.setRequestHandler("elicitation/create", async (req) => {
          asked.push(req.params as Record<string, unknown>);
          return { action: "accept", content: { decision: "approve" } } as never;
        });
        const result = await client.callTool({ name: "buy", arguments: { n: 6 } });
        expect(toolJson(result)).toEqual({ ok: true, result: { bought: 6 } });
        expect(runs).toBe(1);
        expect(asked).toHaveLength(1);
        expect(asked[0]?.mode ?? "form").toBe("form");
        expect(String(asked[0]?.message)).toContain("buy");
        expect(JSON.stringify(asked[0]?.requestedSchema)).toContain("approve");
        const { approvals } = await jsonBody(await adminFetch(`${h.base}/api/approvals`));
        expect(approvals[0]).toMatchObject({ status: "consumed", decided_by: "mcp-chat" });
      } finally {
        await client.close();
      }
    });

    it("deny (or decline) in the chat fails the call with APPROVAL_DENIED", async () => {
      optIn();
      for (const answer of [
        { action: "accept", content: { decision: "deny" } },
        { action: "decline" },
      ]) {
        const client = await modernClient(h.base, { capabilities: FORM_CAPS });
        try {
          client.setRequestHandler("elicitation/create", async () => answer as never);
          const result = await client.callTool({ name: "buy", arguments: { n: 7 } });
          expect(toolJson(result).error.code).toBe("APPROVAL_DENIED");
        } finally {
          await client.close();
        }
      }
      expect(runs).toBe(0);
    });

    it("off by default: a form-capable client still gets the dashboard link", async () => {
      const client = await modernClient(h.base, { capabilities: FORM_CAPS });
      const modes: unknown[] = [];
      try {
        client.setRequestHandler("elicitation/create", async (req) => {
          const params = req.params as Record<string, unknown>;
          modes.push(params.mode);
          if (params.mode === "form") {
            return { action: "accept", content: { decision: "approve" } } as never;
          }
          return { action: "cancel" } as never;
        });
        const result = await client.callTool({ name: "buy", arguments: { n: 8 } });
        expect(toolJson(result).error.code).toBe("APPROVAL_REQUIRED");
        expect(modes).toEqual(["url"]);
        expect(runs).toBe(0);
      } finally {
        await client.close();
      }
    });

    it("R2-M2: an answer sent before the form was shown approves nothing", async () => {
      optIn();
      const client = await modernClient(h.base, { capabilities: FORM_CAPS });
      const asked: unknown[] = [];
      try {
        client.setRequestHandler("elicitation/create", async (req) => {
          asked.push(req.params);
          return { action: "cancel" } as never;
        });
        const result = await client.callTool({
          name: "buy",
          arguments: { n: 10 },
          inputResponses: {
            approval_decision: { action: "accept", content: { decision: "approve" } },
          },
        } as never);
        expect(toolJson(result).error.code).toBe("APPROVAL_REQUIRED");
        expect(runs).toBe(0);
        expect((await pending()).pending).toBe(1);
      } finally {
        await client.close();
      }
    });

    it("closing the form without an answer leaves the request pending for the dashboard", async () => {
      optIn();
      const client = await modernClient(h.base, { capabilities: FORM_CAPS });
      const modes: unknown[] = [];
      try {
        client.setRequestHandler("elicitation/create", async (req) => {
          modes.push((req.params as Record<string, unknown>).mode ?? "form");
          return { action: "cancel" } as never;
        });
        const result = await client.callTool({ name: "buy", arguments: { n: 9 } });
        expect(toolJson(result).error.code).toBe("APPROVAL_REQUIRED");
        expect(modes).toEqual(["form"]);
        expect(toolJson(result).error.approval.url).toContain("/approvals?id=apr_");
        expect((await pending()).pending).toBe(1);
        expect(runs).toBe(0);
      } finally {
        await client.close();
      }
    });
  });

  it("a denied request fails the call once with APPROVAL_DENIED", async () => {
    const client = await legacyClient(h.base);
    try {
      const first = toolJson(await client.callTool({ name: "buy", arguments: { n: 6 } }));
      expect((await decide(first.error.approval.id, "deny")).status).toBe(200);
      const denied = toolJson(await client.callTool({ name: "buy", arguments: { n: 6 } }));
      expect(denied.error.code).toBe("APPROVAL_DENIED");
      expect(runs).toBe(0);
    } finally {
      await client.close();
    }
  });

  it("a background job waits as awaiting_approval and runs once approved", async () => {
    const client = await legacyClient(h.base);
    let jobId: string;
    try {
      const started = toolJson(await client.callTool({ name: "buy_slow", arguments: { n: 7 } }));
      jobId = started.result?.job_id ?? started.job_id;
      expect(typeof jobId).toBe("string");
    } finally {
      await client.close();
    }
    await until(() => h.jobs.get(jobId)?.status === "awaiting_approval");
    const job = h.jobs.get(jobId)!;
    expect(String(job.checkpoint.progress_message)).toContain("/approvals?id=apr_");
    expect(runs).toBe(0);
    const { approvals } = await pending();
    expect(approvals[0].job_id).toBe(jobId);
    expect((await decide(approvals[0].id, "approve")).status).toBe(200);
    await until(() => h.jobs.get(jobId)?.status === "succeeded", 8000);
    expect(runs).toBe(1);
  });

  it("the approval event is pushed on the event stream", async () => {
    const ac = new AbortController();
    const res = await fetch(`${h.base}/api/events`, { headers: ADMIN_AUTH, signal: ac.signal });
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const read = async (needle: string) => {
      while (!text.includes(needle)) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    };
    try {
      await read("event: hello");
      const client = await legacyClient(h.base);
      try {
        await client.callTool({ name: "buy", arguments: { n: 8 } });
      } finally {
        await client.close();
      }
      await read("event: approval");
      const line = text.split("\n").find((l, i, all) => all[i - 1] === "event: approval");
      const data = JSON.parse(line!.slice(5));
      expect(data).toMatchObject({ status: "pending", tool: "buy", pending: 1 });
      expect(JSON.stringify(data)).not.toContain('"n"');
    } finally {
      ac.abort();
      await reader.cancel().catch(() => undefined);
    }
  });

  it("free tools are not gated", async () => {
    const client = await legacyClient(h.base);
    try {
      expect(toolJson(await client.callTool({ name: "free", arguments: {} })).ok).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("policy editor", () => {
  let h: LiteHarness;
  beforeEach(async () => {
    h = await bootLite({ policy: { spent: () => 4 }, packs: { demo: [] } });
  });
  afterEach(() => h.close());

  const put = (body: unknown, headers: Record<string, string> = CSRF) =>
    fetch(`${h.base}/api/policy`, {
      method: "PUT",
      headers: { ...ADMIN_AUTH, "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });

  it("reads the defaults, saves a valid policy and reports spend against each cap", async () => {
    const first = await jsonBody(await adminFetch(`${h.base}/api/policy`));
    expect(first).toMatchObject({ ok: true, valid: true, exists: false, caps: [] });
    const policy = {
      version: 1,
      caps: [{ scope: "global", period: "monthly", limit_usd: 10, mode: "ask" }],
    };
    expect((await put({ policy }, {})).status).toBe(403);
    const saved = await put({ policy });
    expect(saved.status).toBe(200);
    const body = await jsonBody(saved);
    expect(body.caps[0]).toMatchObject({ spent_usd: 4, remaining_usd: 6 });
    expect(JSON.parse(readFileSync(join(h.home, "policy.json"), "utf8")).caps).toHaveLength(1);
  });

  it("refuses an invalid policy (400) and never overwrites a broken file (409)", async () => {
    const bad = await put({
      policy: { version: 1, caps: [{ scope: "global", period: "weekly" }] },
    });
    expect(bad.status).toBe(400);
    expect((await jsonBody(bad)).error.code).toBe("POLICY_INVALID");
    writeFileSync(join(h.home, "policy.json"), "{ half an edit");
    const state = await jsonBody(await adminFetch(`${h.base}/api/policy`));
    expect(state.valid).toBe(false);
    expect(state.error).toContain("not valid JSON");
    const refused = await put({ policy: { version: 1 } });
    expect(refused.status).toBe(409);
    expect((await jsonBody(refused)).error.code).toBe("POLICY_FILE_BROKEN");
    expect(readFileSync(join(h.home, "policy.json"), "utf8")).toBe("{ half an edit");
  });
});
