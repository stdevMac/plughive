import { describe, expect, it } from "vitest";
import calendarPack from "../../../packs/calendar/index.js";
import {
  expectHostDenied,
  expectMissingSecret,
  expectNoSecrets,
  harness,
} from "../action-support.js";
import { failure, routerFetch } from "../provider-support.js";
import { jsonResponse, toolNames, toolOf } from "../support.js";

const SECRETS = { CALCOM_API_KEY: "cal_live_secret_123" };
const VALUES = Object.values(SECRETS);

describe("calendar pack", () => {
  it("marks booking and cancelling destructive", () => {
    expect(toolNames(calendarPack)).toEqual([
      "calcom_list_event_types",
      "calcom_get_availability",
      "calcom_create_booking",
      "calcom_cancel_booking",
    ]);
    expect(toolOf(calendarPack, "calcom_create_booking").annotations?.destructiveHint).toBe(true);
    expect(toolOf(calendarPack, "calcom_cancel_booking").annotations?.destructiveHint).toBe(true);
    expect(toolOf(calendarPack, "calcom_get_availability").annotations?.readOnlyHint).toBe(true);
  });

  it("lists event types with the endpoint's api version", async () => {
    const fetch = routerFetch([
      {
        match: /^GET https:\/\/api\.cal\.com\/v2\/event-types$/,
        reply: () =>
          jsonResponse({
            status: "success",
            data: [{ id: 7, title: "30 min", slug: "30min", lengthInMinutes: 30, hidden: false }],
          }),
      },
    ]);
    const h = harness(calendarPack, "calendar", "calcom_list_event_types", {
      secrets: SECRETS,
      fetch,
    });
    const out = await h.call({});
    expect(out).toEqual({
      event_types: [
        {
          id: 7,
          title: "30 min",
          slug: "30min",
          length_minutes: 30,
          hidden: false,
          description: null,
        },
      ],
    });
    expect(fetch.calls[0]!.headers.authorization).toBe("Bearer cal_live_secret_123");
    expect(fetch.calls[0]!.headers["cal-api-version"]).toBe("2026-06-12");
  });

  it("returns free slots grouped by day", async () => {
    const fetch = routerFetch([
      {
        match:
          /\/v2\/slots\?eventTypeId=7&start=2026-12-01&end=2026-12-02&timeZone=Europe%2FLondon$/,
        reply: () =>
          jsonResponse({
            status: "success",
            data: {
              "2026-12-02": [{ start: "2026-12-02T09:00:00.000+00:00" }],
              "2026-12-01": [
                { start: "2026-12-01T09:00:00.000+00:00" },
                { start: "2026-12-01T10:00:00.000+00:00" },
              ],
            },
          }),
      },
    ]);
    const h = harness(calendarPack, "calendar", "calcom_get_availability", {
      secrets: SECRETS,
      fetch,
    });
    const out = await h.call({
      event_type_id: 7,
      start: "2026-12-01",
      end: "2026-12-02",
      time_zone: "Europe/London",
    });
    expect(out).toEqual({
      time_zone: "Europe/London",
      days: [
        {
          date: "2026-12-01",
          slots: ["2026-12-01T09:00:00.000+00:00", "2026-12-01T10:00:00.000+00:00"],
        },
        { date: "2026-12-02", slots: ["2026-12-02T09:00:00.000+00:00"] },
      ],
    });
    expect(fetch.calls[0]!.headers["cal-api-version"]).toBe("2024-09-04");
    const err = await failure(h.call({ event_type_id: 7, start: "2026-12-03", end: "2026-12-01" }));
    expect(err.message).toMatch(/start/);
  });

  it("creates a booking with an attendee", async () => {
    const fetch = routerFetch([
      {
        method: "POST",
        match: /\/v2\/bookings$/,
        reply: () =>
          jsonResponse({
            status: "success",
            data: {
              uid: "bk_1",
              id: 99,
              title: "30 min",
              status: "accepted",
              start: "2026-12-01T09:00:00.000Z",
              end: "2026-12-01T09:30:00.000Z",
              eventTypeId: 7,
              meetingUrl: "https://cal.video/x",
              attendees: [{ name: "Ada", email: "ada@example.com", timeZone: "Europe/London" }],
            },
          }),
      },
    ]);
    const h = harness(calendarPack, "calendar", "calcom_create_booking", {
      secrets: SECRETS,
      fetch,
    });
    const out = await h.call({
      event_type_id: 7,
      start: "2026-12-01T09:00:00Z",
      attendee_name: "Ada",
      attendee_email: "ada@example.com",
      attendee_time_zone: "Europe/London",
    });
    expect(out).toMatchObject({
      uid: "bk_1",
      status: "accepted",
      meeting_url: "https://cal.video/x",
    });
    expect(fetch.calls[0]!.headers["cal-api-version"]).toBe("2026-02-25");
    expect(JSON.parse(fetch.calls[0]!.body!)).toEqual({
      start: "2026-12-01T09:00:00.000Z",
      eventTypeId: 7,
      attendee: { name: "Ada", email: "ada@example.com", timeZone: "Europe/London" },
    });
    expectNoSecrets(out, VALUES);
  });

  it("cancels a booking by uid", async () => {
    const fetch = routerFetch([
      {
        method: "POST",
        match: /\/v2\/bookings\/bk_1\/cancel$/,
        reply: () =>
          jsonResponse({ status: "success", data: { uid: "bk_1", status: "cancelled" } }),
      },
    ]);
    const h = harness(calendarPack, "calendar", "calcom_cancel_booking", {
      secrets: SECRETS,
      fetch,
    });
    expect(await h.call({ uid: "bk_1", reason: "Conflict" })).toMatchObject({
      uid: "bk_1",
      status: "cancelled",
    });
    expect(JSON.parse(fetch.calls[0]!.body!)).toEqual({ cancellationReason: "Conflict" });
  });

  it("rejects bad uids and time zones", () => {
    expect(
      toolOf(calendarPack, "calcom_cancel_booking").input.safeParse({ uid: "../x" }).success,
    ).toBe(false);
    const create = toolOf(calendarPack, "calcom_create_booking").input;
    expect(
      create.safeParse({
        event_type_id: 7,
        start: "2026-12-01T09:00:00Z",
        attendee_name: "A",
        attendee_email: "a@example.com",
        attendee_time_zone: "Mars/Olympus",
      }).success,
    ).toBe(false);
  });

  it("scrubs the key from errors", async () => {
    const fetch = routerFetch([
      {
        match: /event-types/,
        reply: () =>
          jsonResponse(
            {
              status: "error",
              error: { code: "UNAUTHORIZED", message: "bad cal_live_secret_123" },
            },
            401,
          ),
      },
    ]);
    const h = harness(calendarPack, "calendar", "calcom_list_event_types", {
      secrets: SECRETS,
      fetch,
    });
    const err = await failure(h.call({}));
    expect(err.message).toMatch(/^Cal\.com 401/);
    expectNoSecrets(err, VALUES);
  });

  it("can reach only the declared hosts", async () => {
    const h = harness(calendarPack, "calendar", "calcom_list_event_types", {
      secrets: SECRETS,
      fetch: routerFetch([]),
    });
    await expectHostDenied(h.ctx);
    await expectHostDenied(h.ctx, "https://api.cal.eu/v2/x");
  });

  it("loads via the loader and reports MISSING_SECRET", async () => {
    await expectMissingSecret([
      { tool: "calcom_list_event_types", args: {}, pack: "calendar", secret: "CALCOM_API_KEY" },
    ]);
  });
});
