import { describe, expect, it } from "vitest";
import phonePack from "../../../packs/phone/index.js";
import {
  expectHostDenied,
  expectMissingSecret,
  expectNoSecrets,
  harness,
} from "../action-support.js";
import { failure, routerFetch } from "../provider-support.js";
import { jsonResponse, toolNames, toolOf } from "../support.js";

const SID = `AC${"a1".repeat(16)}`;
const SECRETS = {
  TWILIO_ACCOUNT_SID: SID,
  TWILIO_AUTH_TOKEN: "tw_secret_token_123",
  VAPI_API_KEY: "vapi_secret_key_456",
};
const VALUES = [
  SECRETS.TWILIO_AUTH_TOKEN,
  SECRETS.VAPI_API_KEY,
  Buffer.from(`${SID}:${SECRETS.TWILIO_AUTH_TOKEN}`).toString("base64"),
];

describe("phone pack", () => {
  it("exposes Twilio and Vapi tools, destructive where they text or call", () => {
    expect(toolNames(phonePack)).toEqual([
      "twilio_send_sms",
      "twilio_list_messages",
      "vapi_create_call",
      "vapi_get_call",
    ]);
    for (const n of ["twilio_send_sms", "vapi_create_call"]) {
      expect(toolOf(phonePack, n).annotations?.destructiveHint, n).toBe(true);
    }
    for (const n of ["twilio_list_messages", "vapi_get_call"]) {
      expect(toolOf(phonePack, n).annotations?.readOnlyHint, n).toBe(true);
    }
  });

  it("sends an SMS as a form post with basic auth", async () => {
    const fetch = routerFetch([
      {
        method: "POST",
        match: new RegExp(`/2010-04-01/Accounts/${SID}/Messages\\.json$`),
        reply: () =>
          jsonResponse(
            { sid: "SM1", status: "queued", to: "+14155550100", from: "+14155550199", body: "hi" },
            201,
          ),
      },
    ]);
    const h = harness(phonePack, "phone", "twilio_send_sms", { secrets: SECRETS, fetch });
    const out = await h.call({ to: "+14155550100", body: "hi", from: "+14155550199" });
    expect(out).toMatchObject({ sid: "SM1", status: "queued", to: "+14155550100" });
    const call = fetch.calls[0]!;
    expect(call.headers.authorization).toBe(
      `Basic ${Buffer.from(`${SID}:tw_secret_token_123`).toString("base64")}`,
    );
    expect(call.headers["content-type"]).toBe("application/x-www-form-urlencoded");
    const form = new URLSearchParams(call.body!);
    expect(form.get("To")).toBe("+14155550100");
    expect(form.get("From")).toBe("+14155550199");
    expect(form.get("Body")).toBe("hi");
    expectNoSecrets(out, VALUES);
  });

  it("falls back to the default Messaging Service, and refuses without a sender", async () => {
    const fetch = routerFetch([
      { match: /Messages\.json$/, reply: () => jsonResponse({ sid: "SM2", status: "accepted" }) },
    ]);
    const mg = `MG${"b2".repeat(16)}`;
    const h = harness(phonePack, "phone", "twilio_send_sms", {
      secrets: SECRETS,
      fetch,
      settings: { defaultMessagingServiceSid: mg },
    });
    await h.call({ to: "+14155550100", body: "hi" });
    const form = new URLSearchParams(fetch.calls[0]!.body!);
    expect(form.get("MessagingServiceSid")).toBe(mg);
    expect(form.has("From")).toBe(false);

    const bare = harness(phonePack, "phone", "twilio_send_sms", { secrets: SECRETS, fetch });
    expect((await failure(bare.call({ to: "+14155550100", body: "x" }))).message).toMatch(
      /No sender/,
    );
  });

  it("refuses a malformed account SID before any request", async () => {
    const fetch = routerFetch([]);
    const h = harness(phonePack, "phone", "twilio_list_messages", {
      secrets: { ...SECRETS, TWILIO_ACCOUNT_SID: "AC../../x" },
      fetch,
    });
    expect((await failure(h.call({}))).message).toMatch(/Account SID/);
    expect(fetch.calls).toEqual([]);
  });

  it("lists messages with filters", async () => {
    const fetch = routerFetch([
      {
        method: "GET",
        match: /Messages\.json\?PageSize=5&To=%2B14155550100&DateSent=2026-01-02$/,
        reply: () =>
          jsonResponse({ messages: [{ sid: "SM3", status: "delivered", error_code: null }] }),
      },
    ]);
    const h = harness(phonePack, "phone", "twilio_list_messages", { secrets: SECRETS, fetch });
    const out = (await h.call({ to: "+14155550100", date_sent: "2026-01-02", limit: 5 })) as {
      messages: { sid: string; status: string }[];
    };
    expect(out.messages).toHaveLength(1);
    expect(out.messages[0]).toMatchObject({ sid: "SM3", status: "delivered" });
  });

  it("scrubs the token and its basic-auth form from a Twilio error", async () => {
    const basic = Buffer.from(`${SID}:tw_secret_token_123`).toString("base64");
    const fetch = routerFetch([
      {
        match: /Messages\.json/,
        reply: () =>
          jsonResponse(
            { code: 20003, message: `Authenticate tw_secret_token_123 ${basic}`, status: 401 },
            401,
          ),
      },
    ]);
    const h = harness(phonePack, "phone", "twilio_send_sms", { secrets: SECRETS, fetch });
    const err = await failure(h.call({ to: "+14155550100", body: "x", from: "+14155550199" }));
    expect(err.message).toBe("Twilio 401: Authenticate [redacted] [redacted]");
    expectNoSecrets(err, VALUES);
  });

  it("validates numbers", () => {
    const tool = toolOf(phonePack, "twilio_send_sms");
    expect(tool.input.safeParse({ to: "4155550100", body: "x" }).success).toBe(false);
    expect(tool.input.safeParse({ to: "+14155550100", body: "" }).success).toBe(false);
    expect(tool.input.safeParse({ to: "+14155550100", body: "x".repeat(1601) }).success).toBe(
      false,
    );
  });

  it("places a Vapi call and reads it back", async () => {
    const fetch = routerFetch([
      {
        method: "POST",
        match: /^POST https:\/\/api\.vapi\.ai\/call$/,
        reply: () =>
          jsonResponse({ id: "call_1", status: "queued", type: "outboundPhoneCall" }, 201),
      },
      {
        method: "GET",
        match: /^GET https:\/\/api\.vapi\.ai\/call\/call_1$/,
        reply: () =>
          jsonResponse({
            id: "call_1",
            status: "ended",
            endedReason: "customer-ended-call",
            cost: 0.12,
            artifact: { transcript: "AI: hello" },
            analysis: { summary: "Short call." },
          }),
      },
    ]);
    const create = harness(phonePack, "phone", "vapi_create_call", {
      secrets: SECRETS,
      fetch,
      settings: { defaultAssistantId: "asst_1", defaultPhoneNumberId: "pn_1" },
    });
    expect(await create.call({ customer_number: "+14155550100" })).toMatchObject({
      id: "call_1",
      status: "queued",
    });
    const sent = fetch.calls[0]!;
    expect(sent.headers.authorization).toBe("Bearer vapi_secret_key_456");
    expect(JSON.parse(sent.body!)).toEqual({
      assistantId: "asst_1",
      phoneNumberId: "pn_1",
      customer: { number: "+14155550100" },
    });
    const get = harness(phonePack, "phone", "vapi_get_call", { secrets: SECRETS, fetch });
    const out = await get.call({ call_id: "call_1" });
    expect(out).toMatchObject({
      status: "ended",
      ended_reason: "customer-ended-call",
      cost_usd: 0.12,
      transcript: "AI: hello",
      summary: "Short call.",
    });
    expectNoSecrets(out, VALUES);
  });

  it("asks for an assistant and number when no default is set", async () => {
    const h = harness(phonePack, "phone", "vapi_create_call", {
      secrets: SECRETS,
      fetch: routerFetch([]),
    });
    expect((await failure(h.call({ customer_number: "+14155550100" }))).message).toMatch(
      /assistant_id/,
    );
  });

  it("can reach only the declared hosts", async () => {
    const h = harness(phonePack, "phone", "vapi_get_call", {
      secrets: SECRETS,
      fetch: routerFetch([]),
    });
    await expectHostDenied(h.ctx);
    await expectHostDenied(h.ctx, "https://api.twilio.com.evil.example/x");
  });

  it("loads via the loader and reports MISSING_SECRET", async () => {
    await expectMissingSecret([
      {
        tool: "twilio_list_messages",
        args: {},
        pack: "phone",
        secret: "TWILIO_ACCOUNT_SID",
      },
      { tool: "vapi_get_call", args: { call_id: "c1" }, pack: "phone", secret: "VAPI_API_KEY" },
    ]);
  });

  it("refuses recipients outside allowedRecipients (numbers and prefixes)", async () => {
    const fetch = routerFetch([
      { match: /Messages\.json$/, reply: () => jsonResponse({ sid: "SM9", status: "queued" }) },
      { method: "POST", match: /api\.vapi\.ai\/call$/, reply: () => jsonResponse({ id: "c1" }) },
    ]);
    const settings = { allowedRecipients: ["+14155550100", "+44"], defaultFrom: "+14155550199" };
    const h = harness(phonePack, "phone", "twilio_send_sms", { secrets: SECRETS, fetch, settings });
    await h.call({ to: "+14155550100", body: "hi" });
    await h.call({ to: "+441234567890", body: "hi" }); // covered by the "+44" prefix
    expect(fetch.calls).toHaveLength(2);
    const err = await failure(h.call({ to: "+14155550101", body: "hi" }));
    expect(err.message).toMatch(/\+14155550101 is not in this pack's allowedRecipients/);
    expect(err.message).toMatch(/Packs > Phone > Settings/);
    expect(fetch.calls).toHaveLength(2);

    // The same list gates Vapi calls.
    const calls = harness(phonePack, "phone", "vapi_create_call", {
      secrets: SECRETS,
      fetch,
      settings: { ...settings, defaultAssistantId: "asst_1", defaultPhoneNumberId: "pn_1" },
    });
    await calls.call({ customer_number: "+14155550100" });
    expect(fetch.calls).toHaveLength(3);
    const err2 = await failure(calls.call({ customer_number: "+19995550100" }));
    expect(err2.message).toMatch(/not in this pack's allowedRecipients/);
    expect(fetch.calls).toHaveLength(3);

    // Unset (the default) keeps the old behaviour: any E.164 number goes through.
    const open = harness(phonePack, "phone", "twilio_send_sms", {
      secrets: SECRETS,
      fetch,
      settings: { defaultFrom: "+14155550199" },
    });
    await open.call({ to: "+19995550100", body: "hi" });
    expect(fetch.calls).toHaveLength(4);

    // A malformed list refuses rather than allow everything.
    const bad = harness(phonePack, "phone", "twilio_send_sms", {
      secrets: SECRETS,
      fetch,
      settings: { allowedRecipients: ["4155550100"], defaultFrom: "+14155550199" },
    });
    const err3 = await failure(bad.call({ to: "+14155550100", body: "hi" }));
    expect(err3.message).toMatch(/allowedRecipients setting is not a list/);
    expect(fetch.calls).toHaveLength(4);
  });

  it("lockSender refuses per-call sender overrides when a default is configured", async () => {
    const fetch = routerFetch([
      { match: /Messages\.json$/, reply: () => jsonResponse({ sid: "SM8", status: "queued" }) },
      { match: /api\.vapi\.ai\/call$/, method: "POST", reply: () => jsonResponse({ id: "c9" }) },
    ]);
    const locked = harness(phonePack, "phone", "twilio_send_sms", {
      secrets: SECRETS,
      fetch,
      settings: { lockSender: true, defaultFrom: "+14155550199" },
    });
    const err = await failure(
      locked.call({ to: "+14155550100", body: "hi", from: "+14155550111" }),
    );
    expect(err.message).toMatch(/lockSender setting is on/);
    expect(err.message).toMatch(/from \/ messaging_service_sid/);
    // Without an override the default sender is used.
    await locked.call({ to: "+14155550100", body: "hi" });
    expect(new URLSearchParams(fetch.calls[0]!.body!).get("From")).toBe("+14155550199");
    // lockSender off (the default) keeps allowing overrides.
    const unlocked = harness(phonePack, "phone", "twilio_send_sms", {
      secrets: SECRETS,
      fetch,
      settings: { defaultFrom: "+14155550199" },
    });
    await unlocked.call({ to: "+14155550100", body: "hi", from: "+14155550111" });
    expect(new URLSearchParams(fetch.calls[1]!.body!).get("From")).toBe("+14155550111");

    // Vapi: assistant_id / phone_number_id are locked the same way.
    const vapiLocked = harness(phonePack, "phone", "vapi_create_call", {
      secrets: SECRETS,
      fetch,
      settings: {
        lockSender: true,
        defaultAssistantId: "asst_1",
        defaultPhoneNumberId: "pn_1",
      },
    });
    const err2 = await failure(
      vapiLocked.call({ customer_number: "+14155550100", assistant_id: "asst_evil" }),
    );
    expect(err2.message).toMatch(/assistant_id \/ phone_number_id/);
    await vapiLocked.call({ customer_number: "+14155550100" });
    expect(JSON.parse(fetch.calls[2]!.body!)).toMatchObject({
      assistantId: "asst_1",
      phoneNumberId: "pn_1",
    });
    expect(fetch.calls).toHaveLength(3);
  });

  it("declares allowedRecipients and lockSender in the manifest settings", async () => {
    const { readFileSync } = await import("node:fs");
    const manifest = JSON.parse(
      readFileSync(new URL("../../../packs/phone/pack.json", import.meta.url), "utf8"),
    ) as { settings: { properties: Record<string, unknown> } };
    expect(manifest.settings.properties.allowedRecipients).toMatchObject({
      type: "array",
      items: { type: "string" },
    });
    expect(manifest.settings.properties.lockSender).toMatchObject({ type: "boolean" });
  });
});
