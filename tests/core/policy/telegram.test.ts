// tests/core/policy/telegram.test.ts
//
// Telegram approvals with a fake Bot API: nothing leaves the process. Only a
// button press from an allowed chat decides a request; the feature is off by
// default and the token never reaches a log line.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ApprovalStore } from "../../../src/core/policy/approvals.js";
import { PolicyGate } from "../../../src/core/policy/gate.js";
import { writePolicy } from "../../../src/core/policy/policy.js";
import { TelegramApprover } from "../../../src/core/policy/telegram.js";

const TOKEN = "123456:SECRET-token_value";
const TTL = 30 * 60_000;

interface Call {
  method: string;
  body: Record<string, unknown>;
}

describe("Telegram approvals", () => {
  let home: string;
  let db: Database.Database;
  let gate: PolicyGate;
  let calls: Call[];
  let updates: unknown[];
  let logs: string[];
  let bot: TelegramApprover;

  const fakeFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const method = url.split("/").pop() ?? "";
    expect(url.startsWith(`https://api.telegram.org/bot${TOKEN}/`)).toBe(true);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    let result: unknown = true;
    if (method === "getUpdates") result = updates.splice(0);
    if (method === "sendMessage") result = { message_id: 100 + calls.length };
    if (method === "editMessageText") {
      return new Response(JSON.stringify({ ok: false, description: `bad ${url}` }), {
        status: 400,
      });
    }
    return new Response(JSON.stringify({ ok: true, result }), { status: 200 });
  };

  const request = (n: number) =>
    gate.approvals.request(
      {
        kind: "tool",
        tool: "buy",
        args: { n },
        estimateUsd: 0.5,
        estimateBasis: "static table",
        reason: "buy always asks.",
        profile: "default",
        fingerprint: `fp-${n}`,
      },
      TTL,
    );
  const press = (chat: number, data: string, id = 1) => ({
    update_id: id,
    callback_query: {
      id: `cb${id}`,
      from: { id: 7, username: "owner" },
      data,
      message: { message_id: 101, chat: { id: chat } },
    },
  });
  const flush = () => new Promise((r) => setTimeout(r, 20));
  const stranger2 = (chat: number, data: string) => ({
    update_id: 500,
    callback_query: {
      id: "cb500",
      from: { id: 1234, username: "other-member" },
      data,
      message: { message_id: 101, chat: { id: chat } },
    },
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mcp-tg-"));
    db = new Database(":memory:");
    gate = new PolicyGate({
      home,
      approvals: new ApprovalStore({ db }),
      spend: { spent: () => 0 },
      baseUrl: "http://127.0.0.1:7777",
    });
    calls = [];
    updates = [];
    logs = [];
    const log = (o: object, msg: string) => logs.push(`${msg} ${JSON.stringify(o)}`);
    bot = new TelegramApprover({
      gate,
      token: async () => TOKEN,
      fetch: fakeFetch,
      logger: { info: log, warn: log },
      idleMs: 10,
      minPollMs: 10,
    });
  });
  afterEach(async () => {
    await bot.stop();
    db.close();
    rmSync(home, { recursive: true, force: true });
  });

  const enable = (chats: string[] = ["42"]) =>
    writePolicy(home, { version: 1, telegram: { enabled: true, allowed_chat_ids: chats } });

  it("is off by default: no poll, no message", async () => {
    expect(await bot.pollOnce(0)).toBe(false);
    bot.start();
    request(1);
    await flush();
    expect(calls).toEqual([]);
  });

  it("sends each new request to the allowed chats with Approve and Deny buttons", async () => {
    enable(["42", "-1001"]);
    gate.cache.invalidate();
    bot.start();
    const a = request(2);
    await until(() => calls.filter((c) => c.method === "sendMessage").length === 2);
    const sent = calls.filter((c) => c.method === "sendMessage");
    expect(sent.map((c) => c.body.chat_id)).toEqual(["42", "-1001"]);
    expect(String(sent[0]?.body.text)).toContain(`/approvals?id=${a.id}`);
    expect(JSON.stringify(sent[0]?.body.reply_markup)).toContain(`approve:${a.id}`);
  });

  it("ignores a button press from a chat that is not allowed", async () => {
    enable(["42"]);
    gate.cache.invalidate();
    const a = request(3);
    updates.push(press(999, `approve:${a.id}`));
    expect(await bot.pollOnce(0)).toBe(true);
    expect(gate.approvals.get(a.id)?.status).toBe("pending");
    // Not even answered: the other chat learns nothing.
    expect(calls.map((c) => c.method)).toEqual(["getUpdates"]);
  });

  it("an allowed chat approves or denies once; malformed data is ignored", async () => {
    enable(["42"]);
    gate.cache.invalidate();
    const a = request(4);
    const b = request(5);
    updates.push(press(42, "approve:apr_nope", 1));
    updates.push(press(42, `approve:${a.id}`, 2));
    updates.push(press(42, `deny:${b.id}`, 3));
    updates.push(press(42, `deny:${a.id}`, 4));
    await bot.pollOnce(0);
    expect(gate.approvals.get(a.id)?.status).toBe("approved");
    expect(gate.approvals.get(a.id)?.decided_by).toBe("telegram:@owner");
    expect(gate.approvals.get(b.id)?.status).toBe("denied");
    const answers = calls.filter((c) => c.method === "answerCallbackQuery");
    expect(answers.map((c) => c.body.text)).toEqual([
      "Request approved.",
      "Request denied.",
      "Already approved.",
    ]);
    // The next poll starts after the last update.
    await bot.pollOnce(0);
    expect(calls.filter((c) => c.method === "getUpdates").at(-1)?.body.offset).toBe(5);
  });

  it("a disabled policy stops decisions even for a listed chat", async () => {
    writePolicy(home, { version: 1, telegram: { enabled: false, allowed_chat_ids: ["42"] } });
    gate.cache.invalidate();
    const a = request(6);
    expect(await bot.handleUpdate(press(42, `approve:${a.id}`), TOKEN)).toBe("ignored");
    expect(gate.approvals.get(a.id)?.status).toBe("pending");
  });

  it("when allowed_user_ids is set, only those users' presses in an allowed chat decide", async () => {
    writePolicy(home, {
      version: 1,
      telegram: { enabled: true, allowed_chat_ids: ["42"], allowed_user_ids: [7] },
    });
    gate.cache.invalidate();
    const a = request(8);
    // Another member of the allowed group chat: ignored, not even answered.
    const stranger = {
      ...press(42, `approve:${a.id}`, 1),
      callback_query: {
        ...press(42, "", 1).callback_query!,
        from: { id: 99, username: "stranger" },
      },
    };
    expect(await bot.handleUpdate(stranger, TOKEN)).toBe("ignored");
    expect(gate.approvals.get(a.id)?.status).toBe("pending");
    // The configured user: decided.
    expect(await bot.handleUpdate(press(42, `approve:${a.id}`, 2), TOKEN)).toBe("approved");
    expect(gate.approvals.get(a.id)?.status).toBe("approved");
    // Without the setting, any member of the allowed chat may decide (unchanged).
    writePolicy(home, { version: 1, telegram: { enabled: true, allowed_chat_ids: ["42"] } });
    gate.cache.invalidate();
    const b = request(9);
    expect(await bot.handleUpdate(stranger2(42, `deny:${b.id}`), TOKEN)).toBe("denied");
    expect(gate.approvals.get(b.id)?.status).toBe("denied");
  });

  it("never logs the token", async () => {
    enable(["42"]);
    gate.cache.invalidate();
    bot.start();
    const a = request(7);
    await until(() => calls.some((c) => c.method === "sendMessage"));
    gate.approvals.decide(a.id, "approved", "dashboard", TTL);
    await until(() => logs.some((l) => l.includes("could not update")));
    expect(logs.join("\n")).not.toContain("SECRET");
  });
});

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}
