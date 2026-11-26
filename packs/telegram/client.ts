// packs/telegram/client.ts
//
// Minimal Telegram Bot API client. The fetch and token are injected, so the
// client never reaches the network on its own and never reads the environment.
import type { PackFetch } from "plughive/pack";

export interface TelegramMessage {
  message_id: number;
  chat?: { id?: number | string };
}

/** Telegram answers a send with a small JSON object; anything bigger is refused. */
const MAX_RESPONSE_BYTES = 1024 * 1024;

export type MediaField = "photo" | "video" | "document";

const METHOD_FOR: Record<MediaField, string> = {
  photo: "sendPhoto",
  video: "sendVideo",
  document: "sendDocument",
};

export class TelegramClient {
  constructor(
    private readonly fetch: PackFetch,
    private readonly token: string,
  ) {}

  sendMessage(
    chatId: string,
    text: string,
    parseMode?: "Markdown" | "HTML",
  ): Promise<TelegramMessage> {
    return this.call("sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(parseMode ? { parse_mode: parseMode } : {}),
      }),
    });
  }

  sendMedia(
    field: MediaField,
    chatId: string,
    file: { blob: Blob; filename: string },
    caption?: string,
    parseMode?: "Markdown" | "HTML",
  ): Promise<TelegramMessage> {
    const form = new FormData();
    form.set("chat_id", chatId);
    if (caption) {
      form.set("caption", caption);
      if (parseMode) form.set("parse_mode", parseMode);
    }
    form.set(field, file.blob, file.filename);
    return this.call(METHOD_FOR[field], { method: "POST", body: form });
  }

  private async call(method: string, init: RequestInit): Promise<TelegramMessage> {
    // The bot token is part of the URL, and transport errors can quote the URL.
    // The daemon redacts known secret values on the way out, but that is a
    // seatbelt, not a boundary: this client never lets the URL or a raw
    // transport error leave, so it does not depend on the redactor.
    let r: Response;
    try {
      r = await this.fetch(`https://api.telegram.org/bot${this.token}/${method}`, init);
    } catch (e) {
      const kind = e instanceof Error && e.name !== "Error" ? ` (${e.name})` : "";
      throw new Error(`telegram ${method} -> request failed${kind}`);
    }
    if (!r.ok) {
      await r.body?.cancel().catch(() => {});
      throw new Error(`telegram ${method} -> ${r.status}`);
    }
    let j: { ok: boolean; description?: string; result?: TelegramMessage };
    try {
      j = JSON.parse(await readCapped(r, MAX_RESPONSE_BYTES)) as typeof j;
    } catch {
      throw new Error(`telegram ${method} -> unreadable response`);
    }
    if (!j || !j.ok || !j.result) {
      throw new Error(`telegram ${method} -> ${this.scrub(String(j?.description ?? "unknown"))}`);
    }
    return j.result;
  }

  /** The token in any form it may be quoted in (raw, URL-encoded, base64) becomes [token]. */
  private scrub(text: string): string {
    let out = text;
    const t = this.token;
    for (const form of new Set([t, encodeURIComponent(t), Buffer.from(t).toString("base64")])) {
      if (form) out = out.split(form).join("[token]");
    }
    return out.length > 300 ? `${out.slice(0, 300)}...` : out;
  }
}

/** The body as text, refused when it is over `max` bytes. */
async function readCapped(r: Response, max: number): Promise<string> {
  if (!r.body) return "";
  const reader = r.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new Error("response too large");
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

export function mediaFieldFor(mime: string): MediaField {
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  return "document";
}
