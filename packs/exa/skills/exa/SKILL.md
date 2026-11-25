---
name: exa
description: Web search through Exa with search_web (provider "exa"). Use when the user wants current web results, sources or links, especially research or semantic queries.
---

# Exa web search

Use the `search_web` tool. The router picks a configured search provider; pass `provider: "exa"` to force Exa.

## Inputs

- `query` (required).
- `max_results` (optional, default 10).
- `include_domains` / `exclude_domains` (optional).
- `recency` (optional): day, week, month or year.
- `country` (optional): a two-letter code.
- `model` (optional): the Exa search type: auto (default), lite, deep-lite or deep. Deep types are slower and cost more.

## Output

`results`: each with `title`, `url`, and when available `snippet` and `published_at`.

## Setup

Set `EXA_API_KEY` (https://dashboard.exa.ai/api-keys). Without it the router skips Exa.
