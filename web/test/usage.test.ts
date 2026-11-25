import { describe, expect, it } from "vitest";
import { daySeries, niceMax, providerTotals, sinceFor } from "../src/lib/usage";

const NOW = Date.parse("2026-03-10T15:30:00Z");

describe("usage helpers", () => {
  it("computes the UTC start of each range", () => {
    expect(sinceFor("today", NOW)).toBe("2026-03-10T00:00:00.000Z");
    expect(sinceFor("7d", NOW)).toBe("2026-03-04T00:00:00.000Z");
    expect(sinceFor("30d", NOW)).toBe("2026-02-09T00:00:00.000Z");
    expect(sinceFor("all", NOW)).toBeUndefined();
  });

  const rows = [
    { day: "2026-03-08", provider: "fal", calls: 3, errors: 1, cost_usd: 0.3 },
    { day: "2026-03-08", provider: "replicate", calls: 1, errors: 0, cost_usd: 0.9 },
    { day: "2026-03-10", provider: "fal", calls: 2, errors: 0, cost_usd: 0.2 },
  ];

  it("fills missing days with zeros", () => {
    const s = daySeries(rows, "7d", { now: NOW });
    expect(s.map((p) => p.day)).toEqual([
      "2026-03-04",
      "2026-03-05",
      "2026-03-06",
      "2026-03-07",
      "2026-03-08",
      "2026-03-09",
      "2026-03-10",
    ]);
    expect(s[4]).toMatchObject({ calls: 4, errors: 1 });
    expect(s[4]?.cost).toBeCloseTo(1.2);
    expect(s[5]).toMatchObject({ calls: 0, cost: 0 });
  });

  it("filters to one provider", () => {
    const s = daySeries(rows, "7d", { now: NOW, provider: "replicate" });
    expect(s.reduce((n, p) => n + p.calls, 0)).toBe(1);
  });

  it("totals per provider, highest spend first", () => {
    const t = providerTotals(rows);
    expect(t.map((x) => x.provider)).toEqual(["replicate", "fal"]);
    expect(t[1]).toMatchObject({ calls: 5, errors: 1 });
  });

  it("rounds axis maxima to 1, 2 or 5 times a power of ten", () => {
    expect(niceMax(0)).toBeGreaterThan(0);
    expect(niceMax(0.37)).toBeCloseTo(0.5);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(13)).toBe(20);
    expect(niceMax(200)).toBe(200);
  });
});
