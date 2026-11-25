---
name: telegram
description: Send a message, image, video or file to a Telegram chat with the send_telegram tool. Use when the user wants a notification, a delivery of a generated artifact, or a status update on Telegram.
---

# Telegram

Use `send_telegram` to deliver text or a stored artifact to a Telegram chat.

## Inputs

- `text` (required): the message, or the caption when an artifact is attached.
- `chat_id` (optional): the target chat. Leave it out to use the configured default chat.
- `artifact_id` (optional): an artifact from the library (see `list_artifacts`). Images go out as photos, videos as videos, anything else as a document.
- `parse_mode` (optional): `Markdown` or `HTML` for the message text, or for the caption when an artifact is attached.

## Setup

The pack needs `TELEGRAM_BOT_TOKEN`. Create a bot with @BotFather to get one. The default chat is the pack setting `defaultChatId` and is optional. If a call fails with `MISSING_SECRET`, tell the user which secret to set and link the `helpUrl` from the error.

The pack can read every artifact in the library, so it only sends to chats the user chose: the default chat (`defaultChatId`) and the chats listed in `allowedChatIds`. With neither set it sends nowhere. If a call fails because a chat is not allowed, tell the user to add it to `allowedChatIds` in the dashboard; do not try another chat. Message text is limited to 4096 characters, and to 1024 when it is the caption of an attached artifact.

## Tips

- Generate or import the artifact first, then pass its id.
- Keep captions short. Telegram limits captions to 1024 characters.

## Safety

- Never put the bot token, or any other key, in `text`. The daemon masks known secret values in tool results and errors, but that masking is a seatbelt against accidents, not a security boundary: it does not apply to what is sent to Telegram.
- The message leaves this machine. Send only what the user asked to send, to the chat they named.
