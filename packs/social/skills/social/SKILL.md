---
name: social
description: Publish or schedule social media posts through Ayrshare (ayrshare_post), delete them (ayrshare_delete_post) and list what was posted (ayrshare_history). Use when the user wants to post to X/Twitter, LinkedIn, Instagram, Facebook, TikTok, Threads, Bluesky, YouTube, Pinterest, Reddit, Telegram or Google Business.
---

# Social posting

## Tools

- `ayrshare_post`: publish `post` to `platforms` (the accounts must be linked in Ayrshare). `media_urls` takes public image or video URLs (make a public link for a library artifact with the share pack first). `schedule_date` (ISO 8601 with offset) schedules instead of posting now. Returns the Ayrshare `id` and each network's post URL, plus per-network `errors`.
- `ayrshare_delete_post`: delete a post by its Ayrshare `id`, from every network it went to.
- `ayrshare_history`: recent posts, newest first. `last_days` (default 30) and `limit` narrow it.

## Setup

Needs `AYRSHARE_API_KEY`. `AYRSHARE_PROFILE_KEY` is only for Business plans that post as a sub-profile. If a call fails with `MISSING_SECRET`, tell the user which secret to set.

## Tips

- Posting and deleting are public: show the user the exact text, networks and time and get a clear yes before calling them.
- Instagram and TikTok need media; X limits text to 280 characters unless the account is Premium.
- A post can succeed on some networks and fail on others: report each network's result.
