---
name: memory
description: Give the agent long-term memory with remember, recall, forget, list_memories and list_memory_collections. Use when the user asks to remember something for later, when facts, preferences or decisions should outlive the conversation, or before answering a question that earlier sessions may have covered.
---

# Memory

Text is stored locally (SQLite in the pack's data folder) together with an embedding from the user's `text.embed` provider, so later searches match by meaning, not by exact words.

## Tools

- `remember`: store `text` (or up to 256 `items`). Optional `collection` (default `default`), `id` (remembering the same id again replaces that memory), `tags` and `metadata` (JSON, up to 16 KB).
- `recall`: `query` plus optional `collection`, `k` (default 5, max 100), `min_score` and `tags` (a memory must carry every tag). Results come best first with a cosine `score`; 1 is identical, around 0.3 to 0.5 is typically loosely related, depending on the model.
- `list_memories`: page through a collection, newest first. Pass `next_cursor` back as `cursor`.
- `list_memory_collections`: collections with counts, the provider, model and dimensions each one is pinned to, and the search `mode`.
- `forget`: `ids` (or `id`) deletes those memories. A whole collection is deleted only with `confirm` set to its name; without it the call deletes nothing and reports how many memories would go. Ask the user before deleting a collection.

## Embedding models

A collection is pinned to the provider, model and dimensions of its first `remember` call (`provider`, `model` and `dimensions` only apply then). Later calls embed with the same provider and model, without falling back to another provider; if it is not available the call fails instead of mixing incomparable vectors. To switch models, use a new collection.

## Search mode

`mode` is `sqlite-vec` when the sqlite-vec extension loaded (indexed search), or `js` when it did not (brute-force search over every memory in the collection: correct, slower on very large collections). `list_memory_collections` shows `fallback_reason` in `js` mode.

## Setup

Needs one `text.embed` provider. If calls fail with "no text.embed provider", run `list_media_providers` and tell the user which provider keys or local backends can enable embeddings.
