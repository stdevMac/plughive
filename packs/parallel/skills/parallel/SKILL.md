---
name: parallel
description: Web search through Parallel with search_web (provider "parallel"). Use when the user wants current web results, sources or links, especially when an agent needs long, relevant excerpts.
---

# Parallel web search

Use the `search_web` tool. The router picks a configured search provider; pass `provider: "parallel"` to force Parallel.

## Inputs

- `query` (required).
- `max_results` (optional, default 10).
- `include_domains` / `exclude_domains` (optional).
- `recency` (optional): day, week, month or year.
- `country` (optional): a two-letter code.
- `model` (optional): the search mode: turbo, fast, basic or advanced (Parallel's default).

## Output

`results`: each with `title`, `url`, and when available `snippet` and `published_at`.

## Setup

Set `PARALLEL_API_KEY` (https://platform.parallel.ai). Without it the router skips Parallel.
