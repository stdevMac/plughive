---
name: dub
description: Shorten a URL into a Dub.co short link with dub_shorten_url. Use when the user wants a short or trackable link for a campaign, post or email.
---

# Dub short links

Use `dub_shorten_url` to create a short link.

## Inputs

- `url` (required): the destination, an absolute URL.
- `key` (optional): a custom slug. It must be free on the chosen domain.
- `tags` (optional): tag names to group links in the Dub dashboard.
- `domain` (optional): a custom Dub domain. Leave out to use the workspace default.

## Output

`short_url` (the link to share), `id` (the Dub link id) and `key` (the slug).

## Setup

The pack needs `DUB_API_KEY`, created in the Dub dashboard under Settings, Tokens. If a call fails with `MISSING_SECRET`, tell the user which secret to set.

## Tips

- A taken custom `key` returns a Dub 409 error; retry without `key` or with another slug.
- Each call creates a new link, so do not call it twice for the same destination.
