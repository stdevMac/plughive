// The cron parser and next-run calculation.
import { describe, expect, it } from "vitest";
import { CronError, nextRun, parseCron } from "../../../src/core/triggers/cron.js";

const utc = (s: string) => new Date(`${s}Z`);
const next = (expr: string, after: string) =>
  nextRun(parseCron(expr), utc(after), "UTC")?.toISOString();

describe("parseCron", () => {
  it("parses lists, ranges, steps, names and macros", () => {
    const s = parseCron("*/15 9-17 1,15 jan-mar mon-fri");
    expect([...s.minute]).toEqual([0, 15, 30, 45]);
    expect([...s.hour]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...s.dom]).toEqual([1, 15]);
    expect([...s.month]).toEqual([1, 2, 3]);
    expect([...s.dow]).toEqual([1, 2, 3, 4, 5]);
    expect(parseCron("5/20 * * * *").minute).toEqual(new Set([5, 25, 45]));
    expect(parseCron("0 0 * * 7").dow).toEqual(new Set([0]));
    expect(parseCron("@daily").source).toBe("@daily");
    expect([...parseCron("@hourly").minute]).toEqual([0]);
    expect(parseCron("* * * * *").domAny).toBe(true);
  });

  it.each([
    "",
    "* * * *",
    "* * * * * *",
    "60 * * * *",
    "* 24 * * *",
    "* * 0 * *",
    "* * * 13 *",
    "* * * * 8",
    "*/0 * * * *",
    "5-1 * * * *",
    "a * * * *",
    "1,,2 * * * *",
    "@sometimes",
  ])("rejects %j", (expr) => {
    expect(() => parseCron(expr)).toThrow(CronError);
  });
});

describe("nextRun", () => {
  it("is strictly after the given time, on a whole minute", () => {
    expect(next("* * * * *", "2026-03-10T10:00:00.000")).toBe("2026-03-10T10:01:00.000Z");
    expect(next("* * * * *", "2026-03-10T10:00:30.500")).toBe("2026-03-10T10:01:00.000Z");
    expect(next("*/15 * * * *", "2026-03-10T10:15:00.000")).toBe("2026-03-10T10:30:00.000Z");
  });

  it("rolls over hours, days, months and years", () => {
    expect(next("0 9 * * *", "2026-03-10T09:00:00")).toBe("2026-03-11T09:00:00.000Z");
    expect(next("30 23 31 * *", "2026-04-01T00:00:00")).toBe("2026-05-31T23:30:00.000Z");
    expect(next("0 0 1 1 *", "2026-06-01T00:00:00")).toBe("2027-01-01T00:00:00.000Z");
    expect(next("0 0 29 2 *", "2026-03-01T00:00:00")).toBe("2028-02-29T00:00:00.000Z");
  });

  it("matches weekdays, and day-of-month OR day-of-week when both are set", () => {
    // 2026-03-10 is a Tuesday.
    expect(next("0 8 * * mon", "2026-03-10T00:00:00")).toBe("2026-03-16T08:00:00.000Z");
    expect(next("0 8 * * 1-5", "2026-03-13T09:00:00")).toBe("2026-03-16T08:00:00.000Z");
    // The 20th or any Sunday: the Sunday (15th) comes first.
    expect(next("0 0 20 * sun", "2026-03-10T00:00:00")).toBe("2026-03-15T00:00:00.000Z");
  });

  it("returns null for a schedule that never fires", () => {
    expect(next("0 0 31 2 *", "2026-01-01T00:00:00")).toBeUndefined();
    expect(nextRun(parseCron("0 0 30 2 *"), new Date(), "UTC")).toBeNull();
  });

  it("works in the local zone", () => {
    const after = new Date(2026, 2, 10, 10, 0, 0);
    const at = nextRun(parseCron("30 14 * * *"), after, "local");
    expect(at?.getHours()).toBe(14);
    expect(at?.getMinutes()).toBe(30);
    expect(at?.getDate()).toBe(10);
  });
});
