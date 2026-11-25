---
name: calendar
description: Schedule meetings with Cal.com. List event types (calcom_list_event_types), find free slots (calcom_get_availability), book a slot (calcom_create_booking) and cancel a booking (calcom_cancel_booking). Use when the user wants to find a time, book, or cancel a meeting on their Cal.com calendar.
---

# Calendar (Cal.com)

## Tools

- `calcom_list_event_types`: the event types (30 min call, demo, ...) with their ids and lengths.
- `calcom_get_availability`: free slots of an event type between `start` and `end`, grouped by day. Pass `time_zone` (IANA, e.g. America/New_York) so times read naturally.
- `calcom_create_booking`: book `start` (a slot from calcom_get_availability) for an attendee name, email and time zone. Returns the booking `uid` and meeting link.
- `calcom_cancel_booking`: cancel by `uid`, with an optional reason.

## Setup

Needs `CALCOM_API_KEY` (Cal.com Settings, Developer, API keys). If a call fails with `MISSING_SECRET`, tell the user to set it.

## Tips

- Booking and cancelling email the attendee: confirm the time, time zone and attendee with the user before calling them.
- Always check availability first; booking a time that is not free fails.
- Slot times are ISO timestamps; state them in the attendee's time zone.
