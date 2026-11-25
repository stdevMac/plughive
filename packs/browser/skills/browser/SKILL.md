---
name: browser
description: Drive cloud browsers on Browserbase and Steel (browserbase_create_session, browserbase_fetch, steel_create_session, steel_navigate, steel_screenshot, and the close/release tools). Use when the user needs a real remote browser, a screenshot of a live page saved to the library, or a page fetched through a cloud browser.
---

# Cloud browsers

## Tools

- `browserbase_fetch`: fetch one page as markdown, raw HTML or JSON. No session needed; prefer it for reading a page.
- `browserbase_create_session` / `browserbase_get_session` / `browserbase_close_session`: start, check and end a Browserbase session. The `live_view_url` lets the user watch it. Browserbase has no REST call to click or navigate inside a session (that needs CDP), so use Steel for navigation and screenshots.
- `steel_create_session`: start a Steel session; returns `viewer_url`.
- `steel_navigate`: open a URL in the session.
- `steel_screenshot`: PNG of the current page (or of `url` after opening it), saved to the library.
- `steel_release_session`: end a Steel session.

## Cost

Sessions bill per minute until closed or timed out. Always close or release a session you started when the work is done.

## Setup

`BROWSERBASE_API_KEY` and `STEEL_API_KEY`, one per provider. If a call fails with `MISSING_SECRET`, tell the user which secret to set. Connection URLs carry credentials and are never returned.
