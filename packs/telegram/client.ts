// packs/telegram/client.ts
//
// Minimal Telegram Bot API client. The fetch and token are injected, so the
// client never reaches the network on its own and never reads the environment.
import type { PackFetch } from "plughive/pack";

export interface TelegramMessage {
  message_id: number;
  chat?: { id?: number | string };
}

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
    if (!r.ok) throw new Error(`telegram ${method} -> ${r.status}`);
    let j: { ok: boolean; description?: string; result?: TelegramMessage };
    try {
      j = (await r.json()) as typeof j;
    } catch {
      throw new Error(`telegram ${method} -> unreadable response`);
    }
    if (!j.ok || !j.result) {
      const why = String(j.description ?? "unknown")
        .split(this.token)
        .join("[token]");
      throw new Error(`telegram ${method} -> ${why}`);
    }
    return j.result;
  }
}

export function mediaFieldFor(mime: string): MediaField {
  if (mime.startsWith("image/")) return "photo";
  if (mime.startsWith("video/")) return "video";
  return "document";
}
