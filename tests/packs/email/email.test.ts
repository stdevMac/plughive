import { describe, expect, it } from "vitest";
import emailPack from "../../../packs/email/index.js";
import {
  expectHostDenied,
  expectMissingSecret,
  expectNoSecrets,
  harness,
} from "../action-support.js";
import { failure, routerFetch } from "../provider-support.js";
import { jsonResponse, toolNames, toolOf } from "../support.js";

const SECRETS = { RESEND_API_KEY: "re_secret_key_123", AGENTMAIL_API_KEY: "am_secret_key_456" };
const VALUES = Object.values(SECRETS);

describe("email pack", () => {
  it("exposes the Resend and AgentMail tools, destructive where they send", () => {
    expect(toolNames(emailPack)).toEqual([
      "resend_send_email",
      "agentmail_list_inboxes",
      "agentmail_list_messages",
      "agentmail_get_message",
      "agentmail_reply",
    ]);
    expect(toolOf(emailPack, "resend_send_email").annotations?.destructiveHint).toBe(true);
    expect(toolOf(emailPack, "agentmail_reply").annotations?.destructiveHint).toBe(true);
    expect(toolOf(emailPack, "agentmail_get_message").annotations?.readOnlyHint).toBe(true);
  });

  it("sends through Resend with bearer auth and a User-Agent", async () => {
    const fetch = routerFetch([
      {
        match: /^POST https:\/\/api\.resend\.com\/emails$/,
        reply: () => jsonResponse({ id: "em_1" }),
      },
    ]);
    const h = harness(emailPack, "email", "resend_send_email", { secrets: SECRETS, fetch });
    const out = await h.call({
      to: ["a@example.com"],
      subject: "Hi",
      text: "Hello",
      from: "Acme <hello@acme.test>",
    });
    expect(out).toEqual({ id: "em_1", from: "Acme <hello@acme.test>", to: ["a@example.com"] });
    const call = fetch.calls[0]!;
    expect(call.headers.authorization).toBe("Bearer re_secret_key_123");
    expect(call.headers["user-agent"]).toMatch(/plughive/);
    expect(JSON.parse(call.body!)).toMatchObject({
      to: ["a@example.com"],
      subject: "Hi",
      text: "Hello",
    });
    expectNoSecrets(out, VALUES);
  });

  it("uses the default sender setting, and refuses without any sender", async () => {
    const fetch = routerFetch([{ match: /resend/, reply: () => jsonResponse({ id: "em_2" }) }]);
    const h = harness(emailPack, "email", "resend_send_email", {
      secrets: SECRETS,
      fetch,
      settings: { defaultFrom: "bot@acme.test" },
    });
    await h.call({ to: ["a@example.com"], subject: "s", html: "<p>x</p>" });
    expect(JSON.parse(fetch.calls[0]!.body!).from).toBe("bot@acme.test");

    const bare = harness(emailPack, "email", "resend_send_email", { secrets: SECRETS, fetch });
    const err = await failure(bare.call({ to: ["a@example.com"], subject: "s", text: "x" }));
    expect(err.message).toMatch(/No sender/);
  });

  it("requires a body and limits recipients", () => {
    const tool = toolOf(emailPack, "resend_send_email");
    expect(tool.input.safeParse({ to: ["a@example.com"], subject: "s" }).success).toBe(false);
    const many = Array.from({ length: 51 }, (_, i) => `u${i}@example.com`);
    expect(tool.input.safeParse({ to: many, subject: "s", text: "x" }).success).toBe(false);
    expect(tool.input.safeParse({ to: ["not an email"], subject: "s", text: "x" }).success).toBe(
      false,
    );
  });

  it("scrubs the key from a Resend error", async () => {
    const fetch = routerFetch([
      {
        match: /resend/,
        reply: () =>
          jsonResponse(
            { name: "validation_error", message: "API key re_secret_key_123 is invalid" },
            401,
          ),
      },
    ]);
    const h = harness(emailPack, "email", "resend_send_email", { secrets: SECRETS, fetch });
    const err = await failure(
      h.call({ to: ["a@example.com"], subject: "s", text: "x", from: "a@b.co" }),
    );
    expect(err.message).toBe("Resend 401: API key [redacted] is invalid");
    expectNoSecrets(err, VALUES);
  });

  it("lists AgentMail inboxes and messages", async () => {
    const fetch = routerFetch([
      {
        match: /^GET https:\/\/api\.agentmail\.to\/v0\/inboxes\?limit=5$/,
        reply: () =>
          jsonResponse({
            count: 1,
            inboxes: [
              { inbox_id: "bot@agentmail.to", email: "bot@agentmail.to", display_name: "Bot" },
            ],
          }),
      },
      {
        match: /^GET https:\/\/api\.agentmail\.to\/v0\/inboxes\/bot%40agentmail\.to\/messages$/,
        reply: () =>
          jsonResponse({
            count: 1,
            messages: [
              {
                message_id: "m1",
                thread_id: "t1",
                from: "a@example.com",
                to: ["bot@agentmail.to"],
                subject: "Q",
                preview: "hello",
                timestamp: "2026-01-01T00:00:00Z",
                labels: ["received"],
              },
            ],
            next_page_token: "p2",
          }),
      },
    ]);
    const inboxes = harness(emailPack, "email", "agentmail_list_inboxes", {
      secrets: SECRETS,
      fetch,
    });
    expect(await inboxes.call({ limit: 5 })).toEqual({
      inboxes: [{ inbox_id: "bot@agentmail.to", email: "bot@agentmail.to", display_name: "Bot" }],
      next_page_token: null,
    });
    const msgs = harness(emailPack, "email", "agentmail_list_messages", {
      secrets: SECRETS,
      fetch,
    });
    const out = (await msgs.call({ inbox_id: "bot@agentmail.to" })) as {
      messages: { subject: string }[];
      next_page_token: string;
    };
    expect(out.messages[0]?.subject).toBe("Q");
    expect(out.next_page_token).toBe("p2");
    expect(fetch.calls[0]!.headers.authorization).toBe("Bearer am_secret_key_456");
    expectNoSecrets(out, VALUES);
  });

  it("reads a message with capped bodies and replies to it", async () => {
    const fetch = routerFetch([
      {
        method: "GET",
        match: /\/inboxes\/bot%40agentmail\.to\/messages\/m1$/,
        reply: () =>
          jsonResponse({
            message_id: "m1",
            from: "a@example.com",
            text: "x".repeat(200_000),
            extracted_text: "hi",
          }),
      },
      {
        method: "POST",
        match: /\/inboxes\/bot%40agentmail\.to\/messages\/m1\/reply$/,
        reply: () => jsonResponse({ message_id: "m2", thread_id: "t1" }),
      },
    ]);
    const get = harness(emailPack, "email", "agentmail_get_message", { secrets: SECRETS, fetch });
    const msg = (await get.call({ inbox_id: "bot@agentmail.to", message_id: "m1" })) as {
      text: string;
      extracted_text: string;
    };
    expect(msg.text.length).toBeLessThanOrEqual(100_003);
    expect(msg.extracted_text).toBe("hi");
    const rep = harness(emailPack, "email", "agentmail_reply", { secrets: SECRETS, fetch });
    expect(
      await rep.call({ inbox_id: "bot@agentmail.to", message_id: "m1", text: "thanks" }),
    ).toEqual({
      message_id: "m2",
      thread_id: "t1",
    });
    expect(JSON.parse(fetch.calls[1]!.body!)).toEqual({ text: "thanks" });
  });

  it("agentmail_reply checks who the reply reaches against allowedRecipients", async () => {
    const original = {
      message_id: "m1",
      from: "Ann <ann@example.com>",
      to: ["bot@agentmail.to", "boss@other.test"],
      cc: [],
    };
    const fetch = routerFetch([
      {
        method: "GET",
        match: /\/messages\/m1$/,
        reply: () => jsonResponse(original),
      },
      {
        method: "POST",
        match: /\/messages\/m1\/reply$/,
        reply: () => jsonResponse({ message_id: "m2", thread_id: "t1" }),
      },
    ]);
    const rep = harness(emailPack, "email", "agentmail_reply", {
      secrets: SECRETS,
      fetch,
      settings: { allowedRecipients: ["@example.com"] },
    });
    const base = { inbox_id: "bot@agentmail.to", message_id: "m1", text: "ok" };
    expect(await rep.call(base)).toEqual({ message_id: "m2", thread_id: "t1" });
    // reply_all would also reach boss@other.test: refused, nothing sent.
    const err = await failure(rep.call({ ...base, reply_all: true }));
    expect(err.message).toMatch(/boss@other\.test is not in this pack's allowedRecipients/);
    const posts = () => fetch.calls.filter((c) => c.method === "POST").length;
    expect(posts()).toBe(1);
    // A sender outside the list is refused too.
    original.from = "Eve <eve@evil.test>";
    await failure(rep.call(base));
    // No address at all fails closed.
    original.from = "";
    const none = await failure(rep.call(base));
    expect(none.message).toMatch(/cannot tell who this reply would reach/);
    // Quoted local parts and comments are not guessed at: refused.
    for (const from of [
      '"ann@example.com"@evil.test',
      "ann@example.com (x) <eve@evil.test>",
      "Ann <ann@example.com> eve@evil.test",
    ]) {
      original.from = from;
      const e = await failure(rep.call(base));
      expect(e.message, from).toMatch(/cannot tell who this reply would reach|not in this pack/);
    }
    expect(posts()).toBe(1);
  });

  it("rejects ids that would change the path", () => {
    const tool = toolOf(emailPack, "agentmail_get_message");
    expect(tool.input.safeParse({ inbox_id: "../admin", message_id: "m" }).success).toBe(false);
    expect(tool.input.safeParse({ inbox_id: "a", message_id: "m?x=1" }).success).toBe(false);
  });

  it("can reach only the declared hosts", async () => {
    const h = harness(emailPack, "email", "resend_send_email", {
      secrets: SECRETS,
      fetch: routerFetch([]),
    });
    await expectHostDenied(h.ctx);
    await expectHostDenied(h.ctx, "https://api.resend.com.evil.example/emails");
  });

  it("loads via the loader and reports MISSING_SECRET", async () => {
    await expectMissingSecret([
      {
        tool: "resend_send_email",
        args: { to: ["a@example.com"], subject: "s", text: "x", from: "a@b.co" },
        pack: "email",
        secret: "RESEND_API_KEY",
      },
      {
        tool: "agentmail_list_inboxes",
        args: {},
        pack: "email",
        secret: "AGENTMAIL_API_KEY",
      },
    ]);
  });

  it("refuses recipients outside allowedRecipients (addresses and @domain)", async () => {
    const fetch = routerFetch([{ match: /resend/, reply: () => jsonResponse({ id: "em_9" }) }]);
    const settings = {
      allowedRecipients: ["vip@example.com", "@acme.test"],
      defaultFrom: "bot@example.com",
    };
    const h = harness(emailPack, "email", "resend_send_email", {
      secrets: SECRETS,
      fetch,
      settings,
    });
    await h.call({ to: ["vip@example.com"], subject: "s", text: "x" });
    await h.call({ to: ["anyone@acme.test"], subject: "s", text: "x", cc: ["VIP@example.com"] });
    expect(fetch.calls).toHaveLength(2);
    const err = await failure(
      h.call({ to: ["vip@example.com"], cc: ["stranger@other.test"], subject: "s", text: "x" }),
    );
    expect(err.message).toMatch(/stranger@other\.test is not in this pack's allowedRecipients/);
    expect(err.message).toMatch(/Packs > Email > Settings/);
    expect(fetch.calls).toHaveLength(2);

    // Unset (the default) keeps the old behaviour: any address goes through.
    const open = harness(emailPack, "email", "resend_send_email", {
      secrets: SECRETS,
      fetch,
      settings: { defaultFrom: "bot@example.com" },
    });
    await open.call({ to: ["stranger@other.test"], subject: "s", text: "x" });
    expect(fetch.calls).toHaveLength(3);

    // A malformed list refuses rather than allow everything.
    const bad = harness(emailPack, "email", "resend_send_email", {
      secrets: SECRETS,
      fetch,
      settings: { allowedRecipients: ["not-an-email"], defaultFrom: "bot@example.com" },
    });
    const err2 = await failure(bad.call({ to: ["a@example.com"], subject: "s", text: "x" }));
    expect(err2.message).toMatch(/allowedRecipients setting is not a list/);
    expect(fetch.calls).toHaveLength(3);
  });

  it("lockSender refuses a per-call from when a default sender is configured", async () => {
    const fetch = routerFetch([{ match: /resend/, reply: () => jsonResponse({ id: "em_8" }) }]);
    const locked = harness(emailPack, "email", "resend_send_email", {
      secrets: SECRETS,
      fetch,
      settings: { lockSender: true, defaultFrom: "bot@example.com" },
    });
    const err = await failure(
      locked.call({ to: ["a@example.com"], subject: "s", text: "x", from: "evil@other.test" }),
    );
    expect(err.message).toMatch(/lockSender setting is on/);
    expect(err.message).toMatch(/from cannot be set per call/);
    await locked.call({ to: ["a@example.com"], subject: "s", text: "x" });
    expect(JSON.parse(fetch.calls[0]!.body!).from).toBe("bot@example.com");
    // lockSender off (the default) keeps allowing overrides.
    const unlocked = harness(emailPack, "email", "resend_send_email", {
      secrets: SECRETS,
      fetch,
      settings: { defaultFrom: "bot@example.com" },
    });
    await unlocked.call({ to: ["a@example.com"], subject: "s", text: "x", from: "me@example.com" });
    expect(JSON.parse(fetch.calls[1]!.body!).from).toBe("me@example.com");
    expect(fetch.calls).toHaveLength(2);
  });

  it("rejects control characters in the subject", () => {
    const tool = toolOf(emailPack, "resend_send_email");
    expect(tool.input.safeParse({ to: ["a@example.com"], subject: "s", text: "x" }).success).toBe(
      true,
    );
    expect(
      tool.input.safeParse({ to: ["a@example.com"], subject: "hi\r\nBcc: evil@x.test", text: "x" })
        .success,
    ).toBe(false);
  });

  it("declares allowedRecipients and lockSender in the manifest settings", async () => {
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(
      readFileSync(new URL("../../../packs/email/pack.json", import.meta.url), "utf8"),
    ) as { settings: { properties: Record<string, unknown> } };
    expect(manifest.settings.properties.allowedRecipients).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(manifest.settings.properties.lockSender).toMatchObject({ type: "boolean" });
  });
});
