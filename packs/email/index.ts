// packs/email/index.ts
//
// Send email through Resend, and read and answer AgentMail inboxes.
//   Resend:    https://resend.com/docs/api-reference/emails/send-email
//   AgentMail: https://docs.agentmail.to/api-reference
import { type PackContext, definePack, defineTool, z } from "plughive/pack";
import { arr, isPathSegment, noControl, num, obj, requestJson, str } from "./http.js";

const RESEND = "https://api.resend.com";
const AGENTMAIL = "https://api.agentmail.to/v0";
/** Resend refuses requests without a User-Agent. */
const USER_AGENT = "plughive-email/0.1";
/** Most characters of a message body returned. */
const MAX_BODY_CHARS = 100_000;

const email = z.email().max(320);
/** "Name <a@b.c>" or a bare address. */
const sender = z.string().min(3).max(400).refine(noControl, "no control characters");
const id = z
  .string()
  .min(1)
  .max(400)
  .refine(isPathSegment, "an id has no spaces, slashes or control characters");

const WHERE = "in the dashboard (Packs > Email > Settings)";

/** An allowedRecipients entry: a bare address or a "@domain" rule. */
const RECIPIENT_ENTRY =
  /^(@[A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})$/;

/**
 * The addresses this pack may email: bare addresses or "@domain" rules.
 * Unset or empty keeps the default behaviour (any address); a non-empty list
 * is the allow-list, and agents cannot change it.
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
      `this pack's allowedRecipients setting is not a list of addresses or "@domain" entries; fix it ${WHERE}`,
    );
  }
  const list = raw.map((r) => (r as string).trim().toLowerCase()).filter(Boolean);
  return list.length > 0 ? list : null;
}

function addressAllowed(addr: string, allowed: readonly string[]): boolean {
  const a = addr.toLowerCase();
  return allowed.some((p) => (p.startsWith("@") ? a.endsWith(p) : a === p));
}

/** Refuse recipients outside the allow-list, naming the setting to change. */
function checkRecipients(all: readonly string[], allowed: string[] | null): void {
  if (!allowed) return;
  const bad = all.find((a) => !addressAllowed(a, allowed));
  if (bad) {
    throw new Error(
      `${bad} is not in this pack's allowedRecipients setting; add it (or its "@domain") ${WHERE} to email it`,
    );
  }
}

/**
 * Every address in a message's from / reply_to / to / cc: a plain
 * "a@b" or "Name <a@b>" per comma-separated entry. Anything else (quoted local
 * parts, comments, groups) returns null so the caller fails closed instead of
 * guessing which address the provider would use.
 */
function replyAddresses(fields: unknown[]): string[] | null {
  const ENTRY = /^(?:[^<>"(),;:\\@]*<)?([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})>?$/;
  const out: string[] = [];
  const entries: string[] = [];
  const walk = (v: unknown): boolean => {
    if (v === undefined || v === null || v === "") return true;
    if (typeof v === "string") {
      entries.push(...v.split(","));
      return true;
    }
    if (Array.isArray(v)) return v.every(walk);
    return false;
  };
  if (!fields.every(walk)) return null;
  for (const raw of entries) {
    const e = raw.trim();
    if (e === "") continue;
    const m = ENTRY.exec(e);
    if (!m || e.includes("<") !== e.endsWith(">")) return null;
    out.push((m[1] as string).toLowerCase());
  }
  return out;
}

function cap(text: string | null): string | null {
  if (text === null) return null;
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}...` : text;
}

// ---------------------------------------------------------------------------
// Resend
// ---------------------------------------------------------------------------

const resendSend = defineTool({
  name: "resend_send_email",
  description:
    "Send an email through Resend. The sender (input from) must be on a domain verified in Resend (or set a default sender in the pack settings). Give `text`, `html` or both. Returns the Resend email id.",
  secrets: ["RESEND_API_KEY"],
  tags: ["sends"],
  annotations: {
    title: "Send email (Resend)",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z
    .object({
      to: z.array(email).min(1).max(50),
      subject: z.string().min(1).max(998).refine(noControl, "no control characters"),
      text: z.string().max(500_000).optional(),
      html: z.string().max(1_000_000).optional(),
      from: sender.optional(),
      cc: z.array(email).max(50).optional(),
      bcc: z.array(email).max(50).optional(),
      reply_to: z.array(email).max(50).optional(),
    })
    .refine((v) => v.text !== undefined || v.html !== undefined, {
      message: "give text, html or both",
    }),
  async run(input, ctx) {
    checkRecipients(
      [...input.to, ...(input.cc ?? []), ...(input.bcc ?? []), ...(input.reply_to ?? [])],
      allowedRecipients(ctx.settings.allowedRecipients),
    );
    const defaultFrom = str(ctx.settings.defaultFrom);
    if (ctx.settings.lockSender === true && defaultFrom !== null && input.from !== undefined) {
      throw new Error(
        `this pack's lockSender setting is on and a default sender is configured, so from cannot be set per call; change the defaultFrom setting ${WHERE}`,
      );
    }
    const from = input.from ?? defaultFrom;
    if (!from) {
      throw new Error(
        "No sender: pass a from address (one on a domain verified in Resend) or set the default sender in the email pack settings.",
      );
    }
    const key = await ctx.secrets.get("RESEND_API_KEY");
    const out = await requestJson<Record<string, unknown>>(
      ctx.fetch,
      "Resend",
      `${RESEND}/emails`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          "User-Agent": USER_AGENT,
        },
        body: JSON.stringify({
          from,
          to: input.to,
          subject: input.subject,
          text: input.text,
          html: input.html,
          cc: input.cc,
          bcc: input.bcc,
          reply_to: input.reply_to,
        }),
      },
      [key],
    );
    const sent = str(out.id);
    if (!sent) throw new Error("Resend accepted the request but returned no email id.");
    return { id: sent, from, to: input.to };
  },
});

// ---------------------------------------------------------------------------
// AgentMail
// ---------------------------------------------------------------------------

async function agentmail<T = Record<string, unknown>>(
  ctx: PackContext,
  path: string,
  init: { method?: string; body?: unknown } = {},
): Promise<T> {
  const key = await ctx.secrets.get("AGENTMAIL_API_KEY");
  return requestJson<T>(
    ctx.fetch,
    "AgentMail",
    `${AGENTMAIL}${path}`,
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

function query(params: Record<string, string | number | undefined>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
}

function messageSummary(m: unknown) {
  const o = obj(m);
  return {
    message_id: str(o.message_id),
    thread_id: str(o.thread_id),
    from: str(o.from),
    to: arr(o.to).filter((x): x is string => typeof x === "string"),
    subject: str(o.subject),
    preview: str(o.preview),
    timestamp: str(o.timestamp),
    labels: arr(o.labels).filter((x): x is string => typeof x === "string"),
  };
}

const listInboxes = defineTool({
  name: "agentmail_list_inboxes",
  description: "List the AgentMail inboxes on the account: inbox id, address and display name.",
  secrets: ["AGENTMAIL_API_KEY"],
  annotations: { title: "List AgentMail inboxes", readOnlyHint: true, openWorldHint: true },
  input: z.object({
    limit: z.number().int().min(1).max(100).optional(),
    page_token: z.string().max(2000).optional(),
  }),
  async run(input, ctx) {
    const out = await agentmail(
      ctx,
      `/inboxes${query({ limit: input.limit, page_token: input.page_token })}`,
    );
    return {
      inboxes: arr(out.inboxes).map((i) => {
        const o = obj(i);
        return {
          inbox_id: str(o.inbox_id),
          email: str(o.email),
          display_name: str(o.display_name),
        };
      }),
      next_page_token: str(out.next_page_token),
    };
  },
});

const listMessages = defineTool({
  name: "agentmail_list_messages",
  description:
    "List messages in an AgentMail inbox, newest first: ids, sender, subject, preview and labels. Read one in full with agentmail_get_message.",
  secrets: ["AGENTMAIL_API_KEY"],
  annotations: { title: "List AgentMail messages", readOnlyHint: true, openWorldHint: true },
  input: z.object({
    inbox_id: id,
    limit: z.number().int().min(1).max(100).optional(),
    page_token: z.string().max(2000).optional(),
  }),
  async run(input, ctx) {
    const out = await agentmail(
      ctx,
      `/inboxes/${encodeURIComponent(input.inbox_id)}/messages${query({
        limit: input.limit,
        page_token: input.page_token,
      })}`,
    );
    return {
      count: num(out.count),
      messages: arr(out.messages).map(messageSummary),
      next_page_token: str(out.next_page_token),
    };
  },
});

const getMessage = defineTool({
  name: "agentmail_get_message",
  description:
    "Read one AgentMail message: headers, text and HTML body (each capped at 100k characters), plus `extracted_text` (the reply without quoted history) when AgentMail provides it.",
  secrets: ["AGENTMAIL_API_KEY"],
  annotations: { title: "Read AgentMail message", readOnlyHint: true, openWorldHint: true },
  input: z.object({ inbox_id: id, message_id: id }),
  async run(input, ctx) {
    const m = await agentmail(
      ctx,
      `/inboxes/${encodeURIComponent(input.inbox_id)}/messages/${encodeURIComponent(input.message_id)}`,
    );
    return {
      ...messageSummary(m),
      cc: arr(m.cc).filter((x): x is string => typeof x === "string"),
      text: cap(str(m.text)),
      html: cap(str(m.html)),
      extracted_text: cap(str(m.extracted_text)),
    };
  },
});

const reply = defineTool({
  name: "agentmail_reply",
  description:
    "Reply to an AgentMail message from its inbox (sends an email). Give `text`, `html` or both; `reply_all` also answers everyone on the original.",
  secrets: ["AGENTMAIL_API_KEY"],
  tags: ["sends"],
  annotations: {
    title: "Reply to AgentMail message",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z
    .object({
      inbox_id: id,
      message_id: id,
      text: z.string().max(500_000).optional(),
      html: z.string().max(1_000_000).optional(),
      reply_all: z.boolean().optional(),
    })
    .refine((v) => v.text !== undefined || v.html !== undefined, {
      message: "give text, html or both",
    }),
  async run(input, ctx) {
    const allowed = allowedRecipients(ctx.settings.allowedRecipients);
    if (allowed) {
      // The recipients come from the original message, so read it and check
      // who the reply would reach before sending anything.
      const m = obj(
        await agentmail(
          ctx,
          `/inboxes/${encodeURIComponent(input.inbox_id)}/messages/${encodeURIComponent(input.message_id)}`,
        ),
      );
      const fields = [m.from, m.reply_to, ...(input.reply_all ? [m.to, m.cc] : [])];
      const own = input.inbox_id.toLowerCase();
      const all = replyAddresses(fields)?.filter((a) => a !== own) ?? [];
      if (all.length === 0) {
        throw new Error(
          `cannot tell who this reply would reach, so it is not sent while the allowedRecipients setting is on ${WHERE}`,
        );
      }
      checkRecipients(all, allowed);
    }
    const out = await agentmail(
      ctx,
      `/inboxes/${encodeURIComponent(input.inbox_id)}/messages/${encodeURIComponent(input.message_id)}/reply`,
      {
        method: "POST",
        body: { text: input.text, html: input.html, reply_all: input.reply_all },
      },
    );
    return { message_id: str(out.message_id), thread_id: str(out.thread_id) };
  },
});

export default definePack({
  tools: [resendSend, listInboxes, listMessages, getMessage, reply],
});
