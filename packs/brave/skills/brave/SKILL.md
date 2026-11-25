---
name: brave
description: Web search through Brave Search with search_web (provider "brave"). Use when the user wants current web results, sources or links.
---

# Brave Search web search

Use the `search_web` tool. The router picks a configured search provider; pass `provider: "brave"` to force Brave Search.

## Inputs

- `query` (required).
- `max_results` (optional, default 10), at most 20.
- `include_domains` / `exclude_domains` (optional). Brave takes one include domain; with more, the router moves to another provider.
- `recency` (optional): day, week, month or year.
- `country` (optional): a two-letter code.
- `model` (optional): not supported; leave it out.

## Output

`results`: each with `title`, `url`, and when available `snippet` and `published_at`.

## Setup

Set `BRAVE_API_KEY` (https://api-dashboard.search.brave.com/app/keys). Without it the router skips Brave Search.
