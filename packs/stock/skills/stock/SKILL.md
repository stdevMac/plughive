---
name: stock
description: Find free stock photos and videos (Pexels, Unsplash) and sound effects (Freesound) and save them to the artifact library with their attribution (pexels_search, unsplash_search, freesound_search, stock_download). Use when the user needs a real photo, b-roll clip or sound effect rather than a generated one.
---

# Stock media

## Tools

- `pexels_search`: photos or videos (`type`), optional `orientation`.
- `unsplash_search`: photos, optional `orientation`.
- `freesound_search`: sounds; `max_duration_s` filters long recordings out.
- `stock_download`: save one result (`provider`, `id`, and `type` for Pexels) into the library. `max_width` picks the size (default 1920). Freesound gives the high-quality MP3 preview; original files need OAuth and are not offered.

## Setup

`PEXELS_API_KEY`, `UNSPLASH_ACCESS_KEY` and `FREESOUND_API_KEY`, one per provider; any one is enough. If a call fails with `MISSING_SECRET`, tell the user which secret to set.

## Attribution

Every result and download returns `attribution` (author, links, license, a ready `text`), also stored in the artifact's meta. Show it to the user and keep it with the work:

- Pexels and Unsplash do not require credit but ask for it; Unsplash credit should use the returned utm links.
- Freesound licenses vary per sound: CC BY needs credit, CC BY-NC forbids commercial use. Tell the user the license before they use a sound commercially.
