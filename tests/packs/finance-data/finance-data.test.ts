import { describe, expect, it } from "vitest";
import financePack from "../../../packs/finance-data/index.js";
import {
  expectHostDenied,
  expectMissingSecret,
  expectNoSecrets,
  harness,
} from "../action-support.js";
import { failure, routerFetch } from "../provider-support.js";
import { jsonResponse, toolNames, toolOf } from "../support.js";

const SECRETS = { POLYGON_API_KEY: "poly_secret_key_123", ALPHAVANTAGE_API_KEY: "AVSECRETKEY456" };
const VALUES = Object.values(SECRETS);

describe("finance-data pack", () => {
  it("exposes only read-only tools", () => {
    const names = toolNames(financePack);
    expect(names).toEqual([
      "polygon_previous_close",
      "polygon_aggregates",
      "alphavantage_quote",
      "alphavantage_daily",
    ]);
    for (const n of names) {
      expect(toolOf(financePack, n).annotations?.readOnlyHint, n).toBe(true);
      expect(toolOf(financePack, n).annotations?.destructiveHint, n).toBeUndefined();
    }
  });

  it("reads the previous close with bearer auth", async () => {
    const fetch = routerFetch([
      {
        match: /^GET https:\/\/api\.massive\.com\/v2\/aggs\/ticker\/AAPL\/prev\?adjusted=true$/,
        reply: () =>
          jsonResponse({
            ticker: "AAPL",
            status: "OK",
            results: [{ o: 1, h: 2, l: 0.5, c: 1.5, v: 100, vw: 1.2, t: 1767225600000, n: 9 }],
          }),
      },
    ]);
    const h = harness(financePack, "finance-data", "polygon_previous_close", {
      secrets: SECRETS,
      fetch,
    });
    const out = await h.call({ ticker: "aapl" });
    expect(out).toEqual({
      ticker: "AAPL",
      bar: {
        time: "2026-01-01T00:00:00.000Z",
        open: 1,
        high: 2,
        low: 0.5,
        close: 1.5,
        volume: 100,
        vwap: 1.2,
        trades: 9,
      },
    });
    expect(fetch.calls[0]!.headers.authorization).toBe("Bearer poly_secret_key_123");
    expect(fetch.calls[0]!.url).not.toContain(SECRETS.POLYGON_API_KEY);
  });

  it("reads aggregates for a range and rejects a reversed range", async () => {
    const fetch = routerFetch([
      {
        match:
          /\/v2\/aggs\/ticker\/X%3ABTCUSD\/range\/1\/day\/2026-01-01\/2026-01-31\?adjusted=true&sort=asc&limit=120$/,
        reply: () =>
          jsonResponse({ ticker: "X:BTCUSD", resultsCount: 1, results: [{ c: 5, t: 0 }] }),
      },
    ]);
    const h = harness(financePack, "finance-data", "polygon_aggregates", {
      secrets: SECRETS,
      fetch,
    });
    const out = (await h.call({ ticker: "X:BTCUSD", from: "2026-01-01", to: "2026-01-31" })) as {
      count: number;
      bars: { close: number }[];
    };
    expect(out.count).toBe(1);
    expect(out.bars[0]?.close).toBe(5);
    const err = await failure(h.call({ ticker: "AAPL", from: "2026-02-01", to: "2026-01-01" }));
    expect(err.message).toMatch(/from/);
  });

  it("rejects tickers that would change the path", () => {
    const tool = toolOf(financePack, "polygon_previous_close");
    expect(tool.input.safeParse({ ticker: "../v3/x" }).success).toBe(false);
    expect(tool.input.safeParse({ ticker: "AAPL?x=1" }).success).toBe(false);
  });

  it("scrubs the key from a Massive error", async () => {
    const fetch = routerFetch([
      {
        match: /prev/,
        reply: () =>
          jsonResponse({ status: "ERROR", error: "Unknown API Key poly_secret_key_123" }, 401),
      },
    ]);
    const h = harness(financePack, "finance-data", "polygon_previous_close", {
      secrets: SECRETS,
      fetch,
    });
    const err = await failure(h.call({ ticker: "AAPL" }));
    expect(err.message).toBe("Massive 401: Unknown API Key [redacted]");
    expectNoSecrets(err, VALUES);
  });

  it("reads an Alpha Vantage quote", async () => {
    const fetch = routerFetch([
      {
        match:
          /^GET https:\/\/www\.alphavantage\.co\/query\?function=GLOBAL_QUOTE&symbol=IBM&apikey=AVSECRETKEY456$/,
        reply: () =>
          jsonResponse({
            "Global Quote": {
              "01. symbol": "IBM",
              "02. open": "100.0",
              "05. price": "101.5",
              "07. latest trading day": "2026-11-20",
              "08. previous close": "99.0",
              "09. change": "2.5",
              "10. change percent": "2.5253%",
            },
          }),
      },
    ]);
    const h = harness(financePack, "finance-data", "alphavantage_quote", {
      secrets: SECRETS,
      fetch,
    });
    const out = await h.call({ symbol: "IBM" });
    expect(out).toMatchObject({
      symbol: "IBM",
      found: true,
      price: 101.5,
      previous_close: 99,
      change_percent: "2.5253%",
    });
    expectNoSecrets(out, VALUES);
  });

  it("turns an Alpha Vantage HTTP 200 rate-limit note into an error without the key", async () => {
    const fetch = routerFetch([
      {
        match: /alphavantage/,
        reply: () =>
          jsonResponse({
            Information: "Thank you for using Alpha Vantage! apikey=AVSECRETKEY456 limit is 25/day",
          }),
      },
    ]);
    const h = harness(financePack, "finance-data", "alphavantage_daily", {
      secrets: SECRETS,
      fetch,
    });
    const err = await failure(h.call({ symbol: "IBM" }));
    expect(err.message).toMatch(/^Alpha Vantage: Thank you/);
    expectNoSecrets(err, VALUES);
  });

  it("returns daily bars newest first, capped at `days`", async () => {
    const fetch = routerFetch([
      {
        match: /TIME_SERIES_DAILY/,
        reply: () =>
          jsonResponse({
            "Meta Data": { "2. Symbol": "IBM" },
            "Time Series (Daily)": {
              "2026-11-18": { "4. close": "1" },
              "2026-11-20": { "4. close": "3" },
              "2026-11-19": { "4. close": "2" },
            },
          }),
      },
    ]);
    const h = harness(financePack, "finance-data", "alphavantage_daily", {
      secrets: SECRETS,
      fetch,
    });
    const out = (await h.call({ symbol: "IBM", days: 2 })) as {
      days: { date: string; close: number }[];
    };
    expect(out.days.map((d) => [d.date, d.close])).toEqual([
      ["2026-11-20", 3],
      ["2026-11-19", 2],
    ]);
  });

  it("can reach only the declared hosts", async () => {
    const h = harness(financePack, "finance-data", "alphavantage_quote", {
      secrets: SECRETS,
      fetch: routerFetch([]),
    });
    await expectHostDenied(h.ctx);
    await expectHostDenied(h.ctx, "https://api.polygon.io/v2/x");
  });

  it("loads via the loader and reports MISSING_SECRET", async () => {
    await expectMissingSecret([
      {
        tool: "polygon_previous_close",
        args: { ticker: "AAPL" },
        pack: "finance-data",
        secret: "POLYGON_API_KEY",
      },
      {
        tool: "alphavantage_quote",
        args: { symbol: "IBM" },
        pack: "finance-data",
        secret: "ALPHAVANTAGE_API_KEY",
      },
    ]);
  });
});
