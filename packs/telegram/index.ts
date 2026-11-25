// packs/telegram/index.ts
//
// The exemplar pack: one tool, one secret, one host, read access to the library.
//
// What the kernel does for it (see the trust-model header in plughive/pack):
//   - ctx.secrets.get only returns names pack.json declares; a missing value
//     throws MissingSecretError, which the registry turns into MISSING_SECRET.
//   - ctx.fetch only reaches permissions.network hosts.
//   - ctx.library returns ids, urls and bytes, never library paths; materialize
//     gives a read-only copy inside the pack's own data dir.
//
// Redaction is a seatbelt, not a boundary: the registry masks known secret
// values in results, errors and logs to catch accidents, but short values and
// transformed values pass, and nothing masks what a pack sends upstream. Do not
// put secrets in results, errors, log lines or outgoing message bodies. The bot
// token is part of the Telegram URL, so client.ts never includes the URL in an
// error message.
import { openAsBlob } from "node:fs";
import { definePack, defineTool, z } from "plughive/pack";
import { TelegramClient, mediaFieldFor } from "./client.js";

const WHERE = "in the dashboard (Packs > Telegram > Settings)";

/** A numeric chat id (negative for groups) or a public @username. */
const CHAT_ID = /^(?:-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{3,31})$/;
/** Telegram's limits: message text 4096 characters, media captions 1024. */
const MAX_TEXT = 4096;
const MAX_CAPTION = 1024;

const sendTelegram = defineTool({
  name: "send_telegram",
  description:
    "Send a Telegram message to the default chat or a chat in the pack's allowedChatIds setting. Optional artifact_id attaches a stored image/video/file (text is then the caption, at most 1024 characters).",
  capability: "notify_telegram",
  secrets: ["TELEGRAM_BOT_TOKEN"],
  // Sends a message as the user's bot: it reaches another person, so it is
  // tagged "sends" (ask-before-sending) and, because it cannot be unsent,
  // destructive (ask-before-destructive). The bot API itself is free.
  tags: ["sends"],
  annotations: {
    title: "Send Telegram message",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    text: z.string().min(1).max(MAX_TEXT),
    chat_id: z
      .string()
      .regex(CHAT_ID, "chat_id must be a numeric chat id or an @username")
      .optional(),
    artifact_id: z.string().min(1).max(128).optional(),
    parse_mode: z.enum(["Markdown", "HTML"]).optional(),
  }),
  async run(input, ctx) {
    const fallback = ctx.settings.defaultChatId;
    const chatId =
      input.chat_id ?? (typeof fallback === "string" && fallback !== "" ? fallback : null);
    if (!chatId) {
      throw new Error(
        `chat_id required (the pack setting defaultChatId is not set; set it ${WHERE})`,
      );
    }
    const allowed = allowedChats(ctx.settings.allowedChatIds, fallback);
    if (!allowed.has(chatId)) {
      throw new Error(
        allowed.size === 0
          ? `no chat is allowed yet: set defaultChatId or add chat ids to allowedChatIds ${WHERE}; agents cannot change those settings`
          : `chat ${chatId} is not in this pack's allowedChatIds setting and is not the default chat; add it to allowedChatIds ${WHERE} to send to it`,
      );
    }
    if (input.artifact_id && input.text.length > MAX_CAPTION) {
      throw new Error(
        `text is the caption when artifact_id is set and is limited to ${MAX_CAPTION} characters`,
      );
    }

    const client = new TelegramClient(ctx.fetch, await ctx.secrets.get("TELEGRAM_BOT_TOKEN"));
    let sent: Awaited<ReturnType<TelegramClient["sendMessage"]>>;
    if (input.artifact_id) {
      const art = await ctx.library.get(input.artifact_id);
      if (!art) throw new Error(`artifact ${input.artifact_id} not found`);
      // A read-only copy in the pack's data dir, streamed from disk rather than
      // held in memory; removed as soon as the upload finishes.
      const copy = await ctx.library.materialize(art.id);
      try {
        const blob = await openAsBlob(copy.path, { type: art.mime });
        sent = await client.sendMedia(
          mediaFieldFor(art.mime),
          chatId,
          { blob, filename: filenameFor(art.id, art.mime) },
          input.text,
          input.parse_mode,
        );
      } finally {
        await copy.cleanup();
      }
    } else {
      sent = await client.sendMessage(chatId, input.text, input.parse_mode);
    }
    ctx.logger.info("telegram sent", { chat_id: chatId });
    return { message_id: sent.message_id, chat_id: String(sent.chat?.id ?? chatId) };
  },
});

/**
 * The chats this pack may send to: the configured default chat plus the
 * allowedChatIds list. The pack reads the whole library, so this set is what
 * keeps artifacts out of chats the user does not own; with neither setting,
 * no chat is allowed (an agent-supplied chat_id alone is never enough).
 */
function allowedChats(setting: unknown, fallback: unknown): Set<string> {
  const ids: string[] = [];
  if (typeof fallback === "string" && fallback.trim() !== "") ids.push(fallback.trim());
  if (setting === undefined || setting === null) return new Set(ids);
  // A list of chat ids; one comma-separated string (the older form) reads the same.
  const raw: unknown[] | null = Array.isArray(setting)
    ? setting
    : typeof setting === "string"
      ? setting.split(",")
      : null;
  // A value that is neither is not "no list": refuse rather than send anywhere.
  if (!raw || raw.some((id) => typeof id !== "string")) {
    throw new Error("this pack's allowedChatIds setting is not a list of chat ids; fix it to send");
  }
  ids.push(...(raw as string[]).map((s) => s.trim()).filter(Boolean));
  return new Set(ids);
}

/** Packs never see library paths: name the upload from the artifact id and mime. */
function filenameFor(id: string, mime: string): string {
  const sub = (mime.split("/")[1] ?? "").split(/[;+]/)[0] ?? "";
  const ext = { jpeg: "jpg", plain: "txt", quicktime: "mov" }[sub] ?? sub;
  return /^[a-z0-9]{1,8}$/.test(ext) ? `${id}.${ext}` : id;
}

export default definePack({ tools: [sendTelegram] });
