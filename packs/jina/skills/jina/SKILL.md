---
name: jina
description: Jina AI with your own key (provider "jina"). Read a web page as clean Markdown, text or HTML with fetch_web; rerank documents against a query with rerank_text (a cross-encoder reranker); embed text with embed_text. Use when the user wants the content of a URL, the most relevant documents for a query, or vectors for search.
---

# Jina AI

Pass `provider: "jina"` to force Jina on any of these tools.

## fetch_web (Jina Reader)

- `url` (required): an http or https URL.
- `format` (optional): markdown (default), text or html.
- `max_chars` (optional, default 100000): longer content is cut and `truncated` is true.

Returns `url`, `title` when known, `content` and `format`.

## rerank_text (Jina Reranker)

A cross-encoder: it reads the query and each document together, so it ranks
more accurately than comparing embeddings (what the free local reranker does).

- `query`, `documents` (required).
- `top_n` (optional): how many to return; default all.
- `model` (optional): jina-reranker-v2-base-multilingual (default), jina-reranker-m0, jina-colbert-v2.

Returns `results` best first, each `{index, score}` with `index` into `documents`, and `tokens_used`.

## embed_text (Jina Embeddings)

- `texts` (required).
- `input_type` (optional): `query` or `document` picks the retrieval adapter.
- `dimensions` (optional): up to 1024 (default 1024).
- `model` (optional): jina-embeddings-v3.

Returns `embeddings`, `dimensions` and `tokens_used`.

## Setup

Set `JINA_API_KEY` (https://jina.ai/api-dashboard).
