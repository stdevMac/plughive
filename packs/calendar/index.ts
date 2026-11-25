// packs/calendar/index.ts
//
// Cal.com scheduling: event types, free slots, and creating and cancelling
// bookings. Each v2 endpoint pins its own cal-api-version header.
//   https://cal.com/docs/api-reference/v2/event-types/get-all-event-types
//   https://cal.com/docs/api-reference/v2/slots/get-available-time-slots-for-an-event-type
//   https://cal.com/docs/api-reference/v2/bookings/create-a-booking
//   https://cal.com/docs/api-reference/v2/bookings/cancel-a-booking
import { type PackContext, definePack, defineTool, z } from "plughive/pack";
import { arr, isPathSegment, noControl, num, obj, requestJson, scrub, str } from "./http.js";

const CAL = "https://api.cal.com/v2";
const VERSION = {
  eventTypes: "2026-06-12",
  slots: "2024-09-04",
  bookings: "2026-02-25",
} as const;

const timeZone = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "an IANA time zone such as Europe/London");
const uid = z
  .string()
  .min(1)
  .max(200)
  .refine(isPathSegment, "a booking uid has no spaces, slashes or control characters");
const dateOrTime = z.union([z.iso.date(), z.iso.datetime({ offset: true })]);

async function cal(
  ctx: PackContext,
  version: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const key = await ctx.secrets.get("CALCOM_API_KEY");
  const out = obj(
    await requestJson(
      ctx.fetch,
      "Cal.com",
      `${CAL}${path}`,
      {
        method,
        headers: {
          Authorization: `Bearer ${key}`,
          "cal-api-version": version,
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      },
      [key],
    ),
  );
  if (out.status === "error") {
    const msg = str(obj(out.error).message) ?? "request failed";
    throw new Error(`Cal.com: ${scrub(msg, [key])}`);
  }
  return out;
}

function booking(b: unknown) {
  const o = obj(b);
  return {
    uid: str(o.uid),
    id: num(o.id),
    title: str(o.title),
    status: str(o.status),
    start: str(o.start),
    end: str(o.end),
    event_type_id: num(o.eventTypeId),
    meeting_url: str(o.meetingUrl) ?? str(o.location),
    attendees: arr(o.attendees).map((a) => {
      const x = obj(a);
      return { name: str(x.name), email: str(x.email), time_zone: str(x.timeZone) };
    }),
  };
}

const eventTypes = defineTool({
  name: "calcom_list_event_types",
  description:
    "List the Cal.com event types of the account (or of `username`): id, title, slug, length in minutes and whether each is hidden. Use the id with calcom_get_availability and calcom_create_booking.",
  secrets: ["CALCOM_API_KEY"],
  annotations: { title: "List Cal.com event types", readOnlyHint: true, openWorldHint: true },
  input: z.object({
    username: z.string().min(1).max(100).refine(noControl, "no control characters").optional(),
  }),
  async run(input, ctx) {
    const q = input.username ? `?username=${encodeURIComponent(input.username)}` : "";
    const out = await cal(ctx, VERSION.eventTypes, "GET", `/event-types${q}`);
    return {
      event_types: arr(out.data).map((e) => {
        const o = obj(e);
        return {
          id: num(o.id),
          title: str(o.title),
          slug: str(o.slug),
          length_minutes: num(o.lengthInMinutes) ?? num(o.length),
          hidden: typeof o.hidden === "boolean" ? o.hidden : null,
          description: str(o.description),
        };
      }),
    };
  },
});

const availability = defineTool({
  name: "calcom_get_availability",
  description:
    "Free slots of a Cal.com event type between `start` and `end` (dates or ISO times), grouped by day in `time_zone`. Book one with calcom_create_booking.",
  secrets: ["CALCOM_API_KEY"],
  annotations: { title: "Cal.com free slots", readOnlyHint: true, openWorldHint: true },
  input: z.object({
    event_type_id: z.number().int().positive(),
    start: dateOrTime,
    end: dateOrTime,
    time_zone: timeZone.optional(),
  }),
  async run(input, ctx) {
    if (Date.parse(input.start) > Date.parse(input.end)) {
      throw new Error("`start` must not be after `end`.");
    }
    const q = new URLSearchParams({
      eventTypeId: String(input.event_type_id),
      start: input.start,
      end: input.end,
    });
    if (input.time_zone) q.set("timeZone", input.time_zone);
    const out = await cal(ctx, VERSION.slots, "GET", `/slots?${q}`);
    const days = obj(out.data);
    return {
      time_zone: input.time_zone ?? "UTC",
      days: Object.keys(days)
        .sort()
        .map((date) => ({
          date,
          slots: arr(days[date])
            .map((s) => str(obj(s).start))
            .filter((s): s is string => s !== null),
        })),
    };
  },
});

const createBooking = defineTool({
  name: "calcom_create_booking",
  description:
    "Book a Cal.com event type at `start` (an ISO time, ideally one returned by calcom_get_availability) for an attendee. Cal.com emails the attendee and the host. Returns the booking uid (needed to cancel) and meeting link.",
  secrets: ["CALCOM_API_KEY"],
  tags: ["sends"],
  annotations: {
    title: "Create Cal.com booking",
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
  },
  input: z.object({
    event_type_id: z.number().int().positive(),
    start: z.iso.datetime({ offset: true }),
    attendee_name: z.string().min(1).max(200).refine(noControl, "no control characters"),
    attendee_email: z.email().max(320),
    attendee_time_zone: timeZone,
    length_minutes: z.number().int().min(1).max(1440).optional(),
    notes: z.string().max(5000).optional(),
  }),
  async run(input, ctx) {
    const out = await cal(ctx, VERSION.bookings, "POST", "/bookings", {
      start: new Date(input.start).toISOString(),
      eventTypeId: input.event_type_id,
      attendee: {
        name: input.attendee_name,
        email: input.attendee_email,
        timeZone: input.attendee_time_zone,
      },
      ...(input.length_minutes !== undefined ? { lengthInMinutes: input.length_minutes } : {}),
      ...(input.notes ? { bookingFieldsResponses: { notes: input.notes } } : {}),
    });
    const data = Array.isArray(out.data) ? out.data[0] : out.data;
    return booking(data);
  },
});

const cancelBooking = defineTool({
  name: "calcom_cancel_booking",
  description:
    "Cancel a Cal.com booking by its uid. Cal.com emails the attendees about the cancellation.",
  secrets: ["CALCOM_API_KEY"],
  tags: ["sends"],
  annotations: {
    title: "Cancel Cal.com booking",
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  input: z.object({
    uid,
    reason: z.string().max(1000).optional(),
  }),
  async run(input, ctx) {
    const out = await cal(
      ctx,
      VERSION.bookings,
      "POST",
      `/bookings/${encodeURIComponent(input.uid)}/cancel`,
      { cancellationReason: input.reason ?? "Cancelled" },
    );
    return booking(out.data);
  },
});

export default definePack({
  tools: [eventTypes, availability, createBooking, cancelBooking],
});
