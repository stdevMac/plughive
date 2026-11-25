// packs/phone/index.ts
//
// Text messages through Twilio and outbound AI phone calls through Vapi.
//   Twilio: https://www.twilio.com/docs/messaging/api/message-resource
//   Vapi:   https://docs.vapi.ai/api-reference/calls/create
import { type PackContext, definePack, defineTool, z } from "plughive/pack";
import { arr, isPathSegment, num, obj, requestJson, str } from "./http.js";

const TWILIO = "https://api.twilio.com/2010-04-01";
const VAPI = "https://api.vapi.ai";

const e164 = z.string().regex(/^\+[1-9]\d{6,14}$/, "an E.164 phone number such as +14155550100");
/** A Twilio sender: an E.164 number, a short code, or an alphanumeric sender id. */
const twilioFrom = z.string().regex(/^(\+[1-9]\d{6,14}|\d{3,8}|[A-Za-z0-9 ]{1,11})$/);
const messagingServiceSid = z
  .string()
  .regex(/^MG[0-9a-fA-F]{32}$/, "a Messaging Service SID (MG...)");
const ACCOUNT_SID = /^AC[0-9a-fA-F]{32}$/;
const vapiId = z.string().min(1).max(200).refine(isPathSegment, "not a valid id");

const WHERE = "in the dashboard (Packs > Phone > Settings)";

/** An E.164 number or prefix ("+1") from the allowedRecipients setting. */
const RECIPIENT_ENTRY = /^\+\d{1,14}$/;

/**
 * The recipients this pack may reach: E.164 numbers or prefixes ("+1" covers
 * every +1 number). Unset or empty keeps the default behaviour (any number);
 * a non-empty list is the allow-list, and agents cannot change it.
 */
function allowedRecipients(setting: unknown): string[] | null {
  if (setting === undefined || setting === null) return null;
  const raw: unknown[] | null = Array.isArray(setting)
    ? setting
    : typeof setting === "string"
      ? setting.split(",")
      : null;
  if (!raw || raw.some((r) => typeof r !== "string" || !RECIPIENT_ENTRY.test(r.trim()))) {
    throw new Error(
      `this pack's allowedRecipients setting is not a list of E.164 numbers or prefixes such as "+1"; fix it ${WHERE}`,
    );
  }
  const list = raw.map((r) => (r as string).trim()).filter(Boolean);
  return list.length > 0 ? list : null;
}

/** Refuse a recipient outside the allow-list, naming the setting to change. */
function checkRecipient(kind: string, to: string, allowed: string[] | null): void {
  if (!allowed) return;
  if (allowed.some((p) => to.startsWith(p))) return;
  throw new Error(
    `${to} is not in this pack's allowedRecipients setting; add it (or a prefix such as "+1") ${WHERE} to ${kind} it`,
  );
}

/** Refuse per-call sender overrides when lockSender is on and a default is set. */
function checkSenderLock(
  lock: unknown,
  hasDefault: boolean,
  overridden: boolean,
  fields: string,
): void {
  if (lock === true && hasDefault && overridden) {
    throw new Error(
      `this pack's lockSender setting is on and a default sender is configured, so ${fields} cannot be set per call; change the default ${WHERE}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------

interface TwilioAuth {
  sid: string;
  header: string;
  secrets: string[];
}

async function twilioAuth(ctx: PackContext): Promise<TwilioAuth> {
  const sid = (await ctx.secrets.get("TWILIO_ACCOUNT_SID")).trim();
  const token = await ctx.secrets.get("TWILIO_AUTH_TOKEN");
  const basic = Buffer.from(`${sid}:${token}`).toString("base64");
  const secrets = [token, basic, `${sid}:${token}`];
  if (!ACCOUNT_SID.test(sid)) {
    throw new Error("TWILIO_ACCOUNT_SID must be an Account SID: AC followed by 32 hex characters.");
  }
  return { sid, header: `Basic ${basic}`, secrets };
}

function twilioMessage(m: unknown) {
  const o = obj(m);
  return {
    sid: str(o.sid),
    status: str(o.status),
    direction: str(o.direction),
    to: str(o.to),
    from: str(o.from),
    body: str(o.body),
    num_segments: str(o.num_segments) ?? num(o.num_segments),
    price: str(o.price),
    price_unit: str(o.price_unit),
    date_created: str(o.date_created),
    date_sent: str(o.date_sent),
    error_code: num(o.error_code),
    error_message: str(o.error_message),
  };
}

const sendSms = defineTool({
  name: "twilio_send_sms",
  description:
    "Send a text message (SMS) through Twilio. Uses the from number, or the pack's default sender or Messaging Service. Costs money per segment. Returns the Twilio message SID and its first status (usually queued).",
  secrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
  tags: ["sends", "paid"],
  annotations: {
    title: "Send SMS (Twilio)",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    to: e164,
    body: z.string().min(1).max(1600),
    from: twilioFrom.optional(),
    messaging_service_sid: messagingServiceSid.optional(),
  }),
  async run(input, ctx) {
    checkRecipient("text", input.to, allowedRecipients(ctx.settings.allowedRecipients));
    const defaultFrom = str(ctx.settings.defaultFrom);
    const defaultService = str(ctx.settings.defaultMessagingServiceSid);
    checkSenderLock(
      ctx.settings.lockSender,
      defaultFrom !== null || defaultService !== null,
      input.from !== undefined || input.messaging_service_sid !== undefined,
      "from / messaging_service_sid",
    );
    const service =
      input.messaging_service_sid ??
      (input.from ? null : str(ctx.settings.defaultMessagingServiceSid));
    const from = input.from ?? (service ? null : str(ctx.settings.defaultFrom));
    if (!from && !service) {
      throw new Error(
        "No sender: pass a from number or `messaging_service_sid`, or set a default sender in the phone pack settings.",
      );
    }
    if (service && !messagingServiceSid.safeParse(service).success) {
      throw new Error(
        "The default Messaging Service SID in the pack settings is not valid (MG...).",
      );
    }
    if (from && !twilioFrom.safeParse(from).success) {
      throw new Error("The default sender in the pack settings is not a valid Twilio sender.");
    }
    const auth = await twilioAuth(ctx);
    const form = new URLSearchParams({ To: input.to, Body: input.body });
    if (service) form.set("MessagingServiceSid", service);
    else if (from) form.set("From", from);
    const out = await requestJson(
      ctx.fetch,
      "Twilio",
      `${TWILIO}/Accounts/${auth.sid}/Messages.json`,
      {
        method: "POST",
        headers: {
          Authorization: auth.header,
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body: form.toString(),
      },
      auth.secrets,
    );
    const msg = twilioMessage(out);
    if (!msg.sid) throw new Error("Twilio accepted the request but returned no message SID.");
    return msg;
  },
});

const listSms = defineTool({
  name: "twilio_list_messages",
  description:
    "List recent Twilio messages on the account, newest first, optionally filtered by recipient, sender or the day sent (YYYY-MM-DD, UTC).",
  secrets: ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"],
  annotations: { title: "List SMS (Twilio)", readOnlyHint: true, openWorldHint: true },
  input: z.object({
    to: e164.optional(),
    from: twilioFrom.optional(),
    date_sent: z.iso.date().optional(),
    limit: z.number().int().min(1).max(100).default(20),
  }),
  async run(input, ctx) {
    const auth = await twilioAuth(ctx);
    const q = new URLSearchParams({ PageSize: String(input.limit) });
    if (input.to) q.set("To", input.to);
    if (input.from) q.set("From", input.from);
    if (input.date_sent) q.set("DateSent", input.date_sent);
    const out = await requestJson<Record<string, unknown>>(
      ctx.fetch,
      "Twilio",
      `${TWILIO}/Accounts/${auth.sid}/Messages.json?${q}`,
      { headers: { Authorization: auth.header, Accept: "application/json" } },
      auth.secrets,
    );
    return { messages: arr(out.messages).map(twilioMessage) };
  },
});

// ---------------------------------------------------------------------------
// Vapi
// ---------------------------------------------------------------------------

async function vapi(
  ctx: PackContext,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<Record<string, unknown>> {
  const key = await ctx.secrets.get("VAPI_API_KEY");
  return requestJson(
    ctx.fetch,
    "Vapi",
    `${VAPI}${path}`,
    {
      method: init.method ?? "GET",
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    },
    [key],
  );
}

function vapiCall(c: Record<string, unknown>) {
  const artifact = obj(c.artifact);
  const analysis = obj(c.analysis);
  return {
    id: str(c.id),
    status: str(c.status),
    type: str(c.type),
    customer_number: str(obj(c.customer).number),
    created_at: str(c.createdAt),
    started_at: str(c.startedAt),
    ended_at: str(c.endedAt),
    ended_reason: str(c.endedReason),
    cost_usd: num(c.cost),
    transcript: str(artifact.transcript) ?? str(c.transcript),
    summary: str(analysis.summary) ?? str(c.summary),
  };
}

const createCall = defineTool({
  name: "vapi_create_call",
  description:
    "Place an outbound phone call with a Vapi assistant to `customer_number`. Uses the pack's default assistant and phone number unless given. Costs money per minute. Returns the call id; follow it with vapi_get_call.",
  secrets: ["VAPI_API_KEY"],
  tags: ["sends", "paid"],
  annotations: {
    title: "Place a call (Vapi)",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    customer_number: e164,
    customer_name: z.string().min(1).max(40).optional(),
    assistant_id: vapiId.optional(),
    phone_number_id: vapiId.optional(),
  }),
  async run(input, ctx) {
    checkRecipient(
      "call",
      input.customer_number,
      allowedRecipients(ctx.settings.allowedRecipients),
    );
    const defaultAssistantId = str(ctx.settings.defaultAssistantId);
    const defaultPhoneNumberId = str(ctx.settings.defaultPhoneNumberId);
    checkSenderLock(
      ctx.settings.lockSender,
      defaultAssistantId !== null && defaultPhoneNumberId !== null,
      input.assistant_id !== undefined || input.phone_number_id !== undefined,
      "assistant_id / phone_number_id",
    );
    const assistantId = input.assistant_id ?? defaultAssistantId;
    const phoneNumberId = input.phone_number_id ?? defaultPhoneNumberId;
    if (!assistantId || !phoneNumberId) {
      throw new Error(
        "Pass assistant_id and phone_number_id, or set the default assistant and phone number in the phone pack settings.",
      );
    }
    const out = await vapi(ctx, "/call", {
      method: "POST",
      body: {
        assistantId,
        phoneNumberId,
        customer: { number: input.customer_number, name: input.customer_name },
      },
    });
    const call = vapiCall(out);
    if (!call.id) throw new Error("Vapi accepted the request but returned no call id.");
    return call;
  },
});

const getCall = defineTool({
  name: "vapi_get_call",
  description:
    "Status of a Vapi call: queued, ringing, in-progress, forwarding or ended, with the end reason, cost, transcript and summary once it has ended.",
  secrets: ["VAPI_API_KEY"],
  annotations: { title: "Get call (Vapi)", readOnlyHint: true, openWorldHint: true },
  input: z.object({ call_id: vapiId }),
  async run(input, ctx) {
    return vapiCall(await vapi(ctx, `/call/${encodeURIComponent(input.call_id)}`));
  },
});

export default definePack({ tools: [sendSms, listSms, createCall, getCall] });
