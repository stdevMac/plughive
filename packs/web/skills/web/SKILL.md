---
name: web
description: Read, search, map and crawl websites with Firecrawl, and take screenshots of pages with a local headless browser. Use when the user needs page content, web search results, a site's URL list, a multi-page crawl or a picture of a page.
---

# Web

## Which tool

- `firecrawl_scrape`: one page to markdown (also html, links, json). Saves the markdown as an artifact.
- `firecrawl_search`: web, news or image search. Use first when you do not know the URL.
- `firecrawl_map`: list the URLs of a domain, optionally filtered by a `search` keyword. Use before a crawl to pick the right section.
- `firecrawl_crawl`: multi-page crawl, submit and poll, one combined markdown artifact. Slow and credit-heavy: set `limit` low (10 to 50) and use `include_paths` to stay on topic.
- `screenshot_url`: PNG, JPEG or WebP of a page from a local Chromium. No API key.

## Setup

- Firecrawl tools need `FIRECRAWL_API_KEY` (firecrawl.dev, API keys). If a call fails with `MISSING_SECRET`, tell the user which secret to set.
- `screenshot_url` needs Chromium once: `npx playwright install chromium`. The tool says so if it is missing.

## screenshot_url safety

The browser only visits public http(s) pages. Loopback, private-network, link-local and cloud-metadata addresses are blocked, and so is every redirect or sub-request the page makes to such an address, and any scheme other than http and https.

To screenshot a local dev server, the user must turn on the pack setting `allowLocalUrls`. Link-local and metadata ranges stay blocked even then. The result's `blocked_requests` counts sub-requests that were refused.

## Tips

- Scrape a page you already know; search when you do not; map before crawling.
- `wait_for` (a CSS selector) and `delay_ms` help with pages that render late.
