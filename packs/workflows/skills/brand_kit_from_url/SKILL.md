---
name: brand_kit_from_url
description: Draft a brand kit (name, tagline, voice, colors, fonts, logo direction) from a website with wf_brand_kit_from_url, saved as JSON and a Markdown brand sheet. Dry run first.
---

# Brand kit from a URL (`wf_brand_kit_from_url`)

## When to use
The user wants a starting brand kit for a site they own or are pitching: colors, fonts, voice and logo direction in one document.

## Inputs
- `url` (required), `notes` (constraints such as colors to keep).
- `make_images` (off by default): a logo concept and a mood image, using the screenshot as a reference.

## Steps and cost
1. `read` (side by side): `shot`, a local headless-browser screenshot (free, needs `npx playwright install chromium`), and `page`, the page text via Firecrawl (one paid call, needs `FIRECRAWL_API_KEY`). Either may fail; the kit is drafted from what is there.
2. `kit`: one `chat` call, JSON reply.
3. `images` (make_images only): two image calls.
4. `save_json`, `save_md`: the kit saved to the library (`brand-kit.json`, `brand-kit.md`).

Paid calls: 2 by default (Firecrawl + chat), 4 with images.

## Dry run
Call it with `"dry_run": true`: it shows which of the screenshot and page steps can run and `paid_calls_max`.

## Recovering by hand
Nothing is retried. Without page text the kit is a guess from the URL alone; say so to the user, or paste the page text into `chat` yourself. If saving failed, the kit JSON is still in the error detail of the completed `kit` step.
