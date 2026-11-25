// src/core/policy/telegram.ts
//
// Opt-in spend approvals over Telegram (docs/spend-and-approvals.md).
//
// Off unless policy.json has `telegram.enabled: true` and at least one chat id
// in `telegram.allowed_chat_ids`; the bot token is the TELEGRAM_BOT_TOKEN
// secret (the one the telegram pack uses). Nothing listens on a port: the
// daemon long-polls getUpdates over HTTPS, so it stays bound to 127.0.0.1.
//
// Each new pending request is sent to every allowed chat with Approve and
// Deny buttons. A button press counts only when the message it came from is in
// an allowed chat and — when `telegram.allowed_user_ids` is set, because a
// group chat lets any member press the button — only when it comes from one of
// those users; anything else (another chat, a forwarded message, a typed
// command, a stale button) is ignored without a reply. The policy is re-read
// on every loop, so turning the feature off or removing a chat takes effect
// within one poll.
//
// What leaves the machine: the tool and provider ids, the estimate, the reason
// and the argument summary, which is redacted when the request is stored. The
// token appears in request URLs only, never in logs or errors.
import type { Approval, ApprovalStore } from "./approvals.js";
import { APPROVAL_ID_RE } from "./approvals.js";
import type { PolicyState } from "./policy.js";

export const TELEGRAM_TOKEN_SECRET = "TELEGRAM_BOT_TOKEN";
const API = "https://api.telegram.org";
const POLL_SECONDS = 25;
const IDLE_MS = 30_000;
const BACKOFF_MS = 5_000;
const MIN_POLL_MS = 1_000;
const MAX_TRACKED = 500;

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface TelegramApproverOptions {
  gate: {
    readonly approvals: ApprovalStore;
    policy(): PolicyState;
    approvalUrl(id: string): string;
  };
  /** The bot token, or null when it is not set. */
  token: () => Promise<string | null>;
  fetch?: FetchLike;
  logger?: { info(o: object, msg: string): void; warn(o: object, msg: string): void };
  /** Wait between polls when the feature is off (tests shorten it). */
  idleMs?: number;
  /** Shortest time between two polls. */
  minPollMs?: number;
}

interface TgUpdate {
  update_id: number;
  callback_query?: {
    id: string;
    from?: { id?: number; username?: string };
    data?: string;
    message?: { message_id: number; chat?: { id?: number } };
  };
}

interface Sent {
  chat: string;
  message: number;
}

function money(usd: number | null): string {
  if (usd === null) return "unknown";
  return `$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`;
}

/** The message text for a request (plain text, no parse mode: nothing to escape). */
export function approvalText(a: Approval, url: string): string {
  return [
    "plughive spend approval",
    `Tool: ${a.tool}${a.provider ? ` via ${a.provider}` : ""}`,
    `Estimate: ${money(a.estimate_usd)}${a.estimate_basis ? ` (${a.estimate_basis})` : ""}`,
    `Why: ${a.reason}`,
    `Profile: ${a.profile}`,
    `Arguments: ${a.args_summary}`,
    `Expires: ${a.expires_at}`,
    `Details: ${url}`,
  ].join("\n");
}

export class TelegramApprover {
  private readonly fetch: FetchLike;
  private readonly idleMs: number;
  private readonly minPollMs: number;
  private readonly sent = new Map<string, Sent[]>();
  private offset = 0;
  private stopped = false;
  private loop: Promise<void> | null = null;
  private readonly abort = new AbortController();
  private warnedNoToken = false;

  constructor(private readonly opts: TelegramApproverOptions) {
    this.fetch = opts.fetch ?? ((url, init) => fetch(url, init));
    this.idleMs = opts.idleMs ?? IDLE_MS;
    this.minPollMs = opts.minPollMs ?? MIN_POLL_MS;
  }

  /** The allowed chats when the feature is on and the policy valid, else []. */
  private chats(): string[] {
    const state = this.opts.gate.policy();
    if (!state.ok || !state.policy.telegram.enabled) return [];
    return state.policy.telegram.allowed_chat_ids;
  }

  /**
   * The users whose button presses count, when configured (opt-in). Empty:
   * any member of an allowed chat may decide, which is only safe for a
   * private chat.
   */
  private users(): number[] {
    const state = this.opts.gate.policy();
    if (!state.ok || !state.policy.telegram.enabled) return [];
    return state.policy.telegram.allowed_user_ids;
  }

  start(): void {
    if (this.loop) return;
    this.opts.gate.approvals.events.on("change", this.onChange);
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.opts.gate.approvals.events.off("change", this.onChange);
    this.abort.abort();
    await this.loop?.catch(() => undefined);
  }

  private readonly onChange = (a: Approval): void => {
    if (this.stopped) return;
    if (a.status === "pending") {
      if (!this.sent.has(a.id)) void this.notify(a);
    } else if (this.sent.has(a.id) && a.status !== "consumed") {
      void this.closeOut(a);
    }
  };

  private async api(token: string, method: string, body: unknown, signal?: AbortSignal) {
    const res = await this.fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: signal ?? this.abort.signal,
    });
    const json = (await res.json().catch(() => null)) as {
      ok?: boolean;
      result?: unknown;
      description?: string;
    } | null;
    if (!res.ok || !json?.ok) {
      // The description comes from Telegram; the URL (with the token) is never included.
      throw new Error(`telegram ${method} failed: ${res.status} ${json?.description ?? ""}`.trim());
    }
    return json.result;
  }

  private warn(err: unknown, msg: string): void {
    const text = err instanceof Error ? err.message : String(err);
    this.opts.logger?.warn({ err: text.replace(/bot\d+:[\w-]+/g, "bot<redacted>") }, msg);
  }

  /** Send a new pending request to every allowed chat. */
  async notify(a: Approval): Promise<void> {
    const chats = this.chats();
    if (chats.length === 0) return;
    const token = await this.opts.token();
    if (!token) return;
    const sent: Sent[] = [];
    this.track(a.id, sent);
    const text = approvalText(a, this.opts.gate.approvalUrl(a.id));
    const keyboard = {
      inline_keyboard: [
        [
          { text: "Approve", callback_data: `approve:${a.id}` },
          { text: "Deny", callback_data: `deny:${a.id}` },
        ],
      ],
    };
    for (const chat of chats) {
      try {
        const msg = (await this.api(token, "sendMessage", {
          chat_id: chat,
          text,
          reply_markup: keyboard,
        })) as { message_id?: number } | undefined;
        if (typeof msg?.message_id === "number") sent.push({ chat, message: msg.message_id });
      } catch (e) {
        this.warn(e, "could not send the approval request to Telegram");
      }
    }
  }

  private track(id: string, sent: Sent[]): void {
    this.sent.set(id, sent);
    while (this.sent.size > MAX_TRACKED) {
      const oldest = this.sent.keys().next().value;
      if (oldest === undefined) break;
      this.sent.delete(oldest);
    }
  }

  /** Remove the buttons once a request is decided anywhere (or expires). */
  private async closeOut(a: Approval): Promise<void> {
    const sent = this.sent.get(a.id) ?? [];
    this.sent.delete(a.id);
    const token = await this.opts.token();
    if (!token) return;
    const by = a.decided_by ? ` (${a.decided_by})` : "";
    for (const s of sent) {
      try {
        await this.api(token, "editMessageText", {
          chat_id: s.chat,
          message_id: s.message,
          text: `plughive: ${a.tool} ${a.status}${by}.`,
        });
      } catch (e) {
        this.warn(e, "could not update the Telegram approval message");
      }
    }
  }

  /**
   * Handle one update. Only a button press on a message in an allowed chat
   * decides anything — and, when `allowed_user_ids` is configured, only from
   * one of those users (in a group chat any member can press the button).
   * Every other update is ignored. Returns what happened.
   */
  async handleUpdate(update: TgUpdate, token: string): Promise<"approved" | "denied" | "ignored"> {
    const cb = update.callback_query;
    if (!cb) return "ignored";
    const chat = cb.message?.chat?.id;
    if (typeof chat !== "number" || !this.chats().includes(String(chat))) return "ignored";
    const users = this.users();
    if (users.length > 0) {
      const fromId = cb.from?.id;
      if (typeof fromId !== "number" || !users.includes(fromId)) return "ignored";
    }
    const m = /^(approve|deny):(apr_[0-9A-Z]{26})$/.exec(cb.data ?? "");
    if (!m || !APPROVAL_ID_RE.test(m[2] ?? "")) return "ignored";
    const id = m[2] as string;
    const decision = m[1] === "approve" ? "approved" : "denied";
    const state = this.opts.gate.policy();
    const ttlMs = state.policy.approval_ttl_minutes * 60_000;
    const who = cb.from?.username ? `telegram:@${cb.from.username}` : `telegram:${chat}`;
    const ok = this.opts.gate.approvals.decide(id, decision, who, ttlMs);
    const current = this.opts.gate.approvals.get(id);
    try {
      await this.api(token, "answerCallbackQuery", {
        callback_query_id: cb.id,
        text: ok ? `Request ${decision}.` : `Already ${current?.status ?? "gone"}.`,
      });
    } catch (e) {
      this.warn(e, "could not answer the Telegram button press");
    }
    if (ok) this.opts.logger?.info({ approval: id, decision, by: who }, "approval decided");
    return ok ? decision : "ignored";
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.abort.signal.aborted) return resolve();
      const t = setTimeout(done, ms);
      function done() {
        clearTimeout(t);
        resolve();
      }
      this.abort.signal.addEventListener("abort", done, { once: true });
    });
  }

  /** One getUpdates round. False when the feature is off or has no token. */
  async pollOnce(timeoutSeconds = POLL_SECONDS): Promise<boolean> {
    if (this.chats().length === 0) return false;
    const token = await this.opts.token();
    if (!token) {
      if (!this.warnedNoToken) {
        this.warnedNoToken = true;
        this.opts.logger?.warn(
          { secret: TELEGRAM_TOKEN_SECRET },
          "Telegram approvals are on but the bot token is not set",
        );
      }
      return false;
    }
    this.warnedNoToken = false;
    const updates = (await this.api(token, "getUpdates", {
      offset: this.offset,
      timeout: timeoutSeconds,
      allowed_updates: ["callback_query"],
    })) as TgUpdate[] | undefined;
    for (const u of updates ?? []) {
      this.offset = Math.max(this.offset, u.update_id + 1);
      await this.handleUpdate(u, token);
    }
    return true;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      const started = Date.now();
      try {
        if (!(await this.pollOnce())) await this.sleep(this.idleMs);
        // A long poll normally takes POLL_SECONDS; one that returns at once
        // (updates waiting, or a proxy that ignores the timeout) never spins.
        else await this.sleep(Math.max(0, this.minPollMs - (Date.now() - started)));
      } catch (e) {
        if (this.stopped) return;
        this.warn(e, "Telegram approvals poll failed");
        await this.sleep(BACKOFF_MS);
      }
    }
  }
}
