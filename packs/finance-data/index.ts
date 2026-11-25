// packs/finance-data/index.ts
//
// Read-only market data: quotes and price history from Massive (formerly
// Polygon.io) and Alpha Vantage. Nothing here places orders or touches an
// account; there is no trading.
//   Massive aggregates: https://massive.com/docs/rest/stocks/aggregates/custom-bars
//   Massive previous close: https://massive.com/docs/rest/stocks/aggregates/previous-day-bar
//   Alpha Vantage: https://www.alphavantage.co/documentation/
import { type PackContext, definePack, defineTool, z } from "plughive/pack";
import { arr, num, obj, requestJson, scrub, str } from "./http.js";

const MASSIVE = "https://api.massive.com";
const ALPHA = "https://www.alphavantage.co/query";

/** Stock, index (I:SPX), crypto (X:BTCUSD) or forex (C:EURUSD) tickers. */
const ticker = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.:-]{0,31}$/, "a ticker such as AAPL, X:BTCUSD or C:EURUSD");
/** Alpha Vantage symbols (AAPL, BRK.B, TSCO.LON, SHOP.TRT). */
const symbol = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9.^-]{0,19}$/, "a symbol such as IBM or TSCO.LON");
const day = z.iso.date();

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: true } as const;

function bar(b: unknown) {
  const o = obj(b);
  const t = num(o.t);
  return {
    time: t === null ? null : new Date(t).toISOString(),
    open: num(o.o),
    high: num(o.h),
    low: num(o.l),
    close: num(o.c),
    volume: num(o.v),
    vwap: num(o.vw),
    trades: num(o.n),
  };
}

const previousClose = defineTool({
  name: "polygon_previous_close",
  description:
    "Previous trading day's open, high, low, close and volume for a ticker from Massive (formerly Polygon.io). Read-only.",
  secrets: ["POLYGON_API_KEY"],
  annotations: { title: "Previous close (Massive/Polygon)", ...READ },
  input: z.object({ ticker, adjusted: z.boolean().default(true) }),
  async run(input, ctx) {
    const key = await ctx.secrets.get("POLYGON_API_KEY");
    const out = await requestJson<Record<string, unknown>>(
      ctx.fetch,
      "Massive",
      `${MASSIVE}/v2/aggs/ticker/${encodeURIComponent(input.ticker.toUpperCase())}/prev?adjusted=${input.adjusted}`,
      { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
      [key],
    );
    const first = arr(out.results)[0];
    return {
      ticker: str(out.ticker) ?? input.ticker.toUpperCase(),
      bar: first ? bar(first) : null,
    };
  },
});

const aggregates = defineTool({
  name: "polygon_aggregates",
  description:
    "Price bars (OHLCV) for a ticker over a date range from Massive (formerly Polygon.io), e.g. 1 day bars from 2026-01-01 to 2026-03-31. Read-only.",
  secrets: ["POLYGON_API_KEY"],
  annotations: { title: "Price bars (Massive/Polygon)", ...READ },
  input: z.object({
    ticker,
    from: day,
    to: day,
    multiplier: z.number().int().min(1).max(1000).default(1),
    timespan: z.enum(["minute", "hour", "day", "week", "month", "quarter", "year"]).default("day"),
    adjusted: z.boolean().default(true),
    sort: z.enum(["asc", "desc"]).default("asc"),
    limit: z.number().int().min(1).max(5000).default(120),
  }),
  async run(input, ctx) {
    if (input.from > input.to)
      throw new Error("The start date (from) must not be after the end date (to).");
    const key = await ctx.secrets.get("POLYGON_API_KEY");
    const q = new URLSearchParams({
      adjusted: String(input.adjusted),
      sort: input.sort,
      limit: String(input.limit),
    });
    const t = encodeURIComponent(input.ticker.toUpperCase());
    const out = await requestJson<Record<string, unknown>>(
      ctx.fetch,
      "Massive",
      `${MASSIVE}/v2/aggs/ticker/${t}/range/${input.multiplier}/${input.timespan}/${input.from}/${input.to}?${q}`,
      { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" } },
      [key],
    );
    return {
      ticker: str(out.ticker) ?? input.ticker.toUpperCase(),
      adjusted: typeof out.adjusted === "boolean" ? out.adjusted : input.adjusted,
      count: num(out.resultsCount) ?? arr(out.results).length,
      bars: arr(out.results).map(bar),
    };
  },
});

/** Alpha Vantage answers errors and rate limits with HTTP 200 and one of these keys. */
async function alpha(
  ctx: PackContext,
  params: Record<string, string>,
): Promise<Record<string, unknown>> {
  const key = await ctx.secrets.get("ALPHAVANTAGE_API_KEY");
  const q = new URLSearchParams({ ...params, apikey: key });
  const out = await requestJson<Record<string, unknown>>(
    ctx.fetch,
    "Alpha Vantage",
    `${ALPHA}?${q}`,
    { headers: { Accept: "application/json" } },
    [key],
  );
  for (const k of ["Error Message", "Note", "Information"]) {
    const m = str(out[k]);
    if (m) throw new Error(`Alpha Vantage: ${scrub(m, [key])}`);
  }
  return out;
}

/** "1.2345" as a number. */
function decimal(v: unknown): number | null {
  const s = str(v);
  if (s === null) return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

const quote = defineTool({
  name: "alphavantage_quote",
  description:
    "Latest price, change, volume and previous close for a symbol from Alpha Vantage (GLOBAL_QUOTE). Read-only.",
  secrets: ["ALPHAVANTAGE_API_KEY"],
  annotations: { title: "Quote (Alpha Vantage)", ...READ },
  input: z.object({ symbol }),
  async run(input, ctx) {
    const out = await alpha(ctx, { function: "GLOBAL_QUOTE", symbol: input.symbol });
    const g = obj(out["Global Quote"]);
    if (Object.keys(g).length === 0) return { symbol: input.symbol, found: false };
    return {
      symbol: str(g["01. symbol"]) ?? input.symbol,
      found: true,
      price: decimal(g["05. price"]),
      open: decimal(g["02. open"]),
      high: decimal(g["03. high"]),
      low: decimal(g["04. low"]),
      volume: decimal(g["06. volume"]),
      latest_trading_day: str(g["07. latest trading day"]),
      previous_close: decimal(g["08. previous close"]),
      change: decimal(g["09. change"]),
      change_percent: str(g["10. change percent"]),
    };
  },
});

const daily = defineTool({
  name: "alphavantage_daily",
  description:
    "Daily open, high, low, close and volume for a symbol from Alpha Vantage (TIME_SERIES_DAILY), newest first, up to `days` days (max 100). Read-only.",
  secrets: ["ALPHAVANTAGE_API_KEY"],
  annotations: { title: "Daily prices (Alpha Vantage)", ...READ },
  input: z.object({ symbol, days: z.number().int().min(1).max(100).default(30) }),
  async run(input, ctx) {
    const out = await alpha(ctx, {
      function: "TIME_SERIES_DAILY",
      symbol: input.symbol,
      outputsize: "compact",
    });
    const series = obj(out["Time Series (Daily)"]);
    const days = Object.keys(series)
      .sort()
      .reverse()
      .slice(0, input.days)
      .map((date) => {
        const d = obj(series[date]);
        return {
          date,
          open: decimal(d["1. open"]),
          high: decimal(d["2. high"]),
          low: decimal(d["3. low"]),
          close: decimal(d["4. close"]),
          volume: decimal(d["5. volume"]),
        };
      });
    return { symbol: str(obj(out["Meta Data"])["2. Symbol"]) ?? input.symbol, days };
  },
});

export default definePack({ tools: [previousClose, aggregates, quote, daily] });
