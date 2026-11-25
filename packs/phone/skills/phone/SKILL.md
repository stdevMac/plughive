---
name: phone
description: Send text messages with Twilio (twilio_send_sms, twilio_list_messages) and place outbound AI phone calls with a Vapi assistant (vapi_create_call, vapi_get_call). Use when the user wants to text or call a phone number.
---

# Phone

## Tools

- `twilio_send_sms`: send one SMS to `to` (E.164, such as +14155550100). The sender is `from`, `messaging_service_sid`, or the pack's default. Long text is split into segments and each segment is billed.
- `twilio_list_messages`: recent messages, optionally filtered by `to`, `from` or `date_sent` (YYYY-MM-DD). Use it to check delivery: `status` moves from queued to sent, delivered, undelivered or failed, with `error_code` on failure.
- `vapi_create_call`: start an outbound call with a Vapi assistant to `customer_number`. The assistant and caller number come from the inputs or the pack defaults.
- `vapi_get_call`: poll a call. Once `status` is `ended`, `ended_reason`, `cost_usd`, `transcript` and `summary` are filled in.

## Setup

Twilio needs `TWILIO_ACCOUNT_SID` (AC...) and `TWILIO_AUTH_TOKEN`; Vapi needs `VAPI_API_KEY` (the private key). If a call fails with `MISSING_SECRET`, tell the user which secret to set.

## Tips

- Texts and calls reach real people and cost money: confirm the number and the message with the user before sending.
- Never resend because a status is still queued; poll instead.
- Calls are not instant: poll `vapi_get_call` every 15 to 30 seconds, not in a tight loop.
