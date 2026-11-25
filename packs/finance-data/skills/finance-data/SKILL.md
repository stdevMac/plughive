---
name: finance-data
description: Read-only market data. Previous close and OHLCV price bars from Massive, formerly Polygon.io (polygon_previous_close, polygon_aggregates), and quotes and daily prices from Alpha Vantage (alphavantage_quote, alphavantage_daily). Use when the user asks for a stock, crypto or forex price or price history. It cannot trade.
---

# Market data

## Tools

- `polygon_previous_close`: last trading day's bar for a ticker (AAPL, X:BTCUSD for crypto, C:EURUSD for forex, I:SPX for indices).
- `polygon_aggregates`: bars between `from` and `to` (YYYY-MM-DD) of `multiplier` x `timespan` (minute to year). `limit` caps the bars (default 120).
- `alphavantage_quote`: latest price, change and volume for a symbol (IBM, TSCO.LON). `found: false` when the symbol is unknown.
- `alphavantage_daily`: daily bars, newest first, up to 100 days.

## Setup

`POLYGON_API_KEY` for the Massive tools (a Polygon.io key works), `ALPHAVANTAGE_API_KEY` for Alpha Vantage. If a call fails with `MISSING_SECRET`, tell the user which secret to set.

## Tips

- These tools only read data. They never place orders and this is not investment advice; present numbers without recommending trades.
- Free plans are delayed (end of day or 15 minutes) and rate limited; Alpha Vantage reports its limit as an error message naming the limit.
- Times in `polygon_*` bars are UTC ISO timestamps of the bar start.
