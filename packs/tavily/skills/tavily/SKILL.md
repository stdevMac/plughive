---
name: tavily
description: Web search through Tavily with search_web (provider "tavily"). Use when the user wants current web results, sources or links.
---

# Tavily web search

Use the `search_web` tool. The router picks a configured search provider; pass `provider: "tavily"` to force Tavily.

## Inputs

- `query` (required).
- `max_results` (optional, default 10), at most 20.
- `include_domains` / `exclude_domains` (optional).
- `recency` (optional): day, week, month or year.
- `country` (optional): a two-letter code; sent to Tavily as the English country name, which boosts results from that country.
- `model` (optional): the search depth: basic (default), advanced, fast or ultra-fast. advanced costs two credits.

## Output

`results`: each with `title`, `url`, and when available `snippet` and `published_at`.

## Setup

Set `TAVILY_API_KEY` (https://app.tavily.com). Without it the router skips Tavily.
