---
name: issue_triage
description: Triage one bug report or feature request with wf_issue_triage (type, severity, labels, missing info, next steps, draft reply). Read-only; never posts to GitHub.
---

# Issue triage (`wf_issue_triage`)

## When to use
A user pastes an issue, or links a public issue page, and wants it classified and a reply drafted. The workflow only reads: it never comments on, labels or closes anything. Posting the reply is up to the user.

## Inputs
- `body`: the issue text, or `issue_url`: a public page read with `firecrawl_scrape` (needs `FIRECRAWL_API_KEY`). With both, the page wins and `body` is the fallback when the page cannot be read.
- `title` (optional), `labels`: the project's label set (suggestions are picked from it), `project_context`: a few lines on components and what counts as critical.

## Steps and cost
1. `fetch` (only with `issue_url`): one Firecrawl call (paid). A failure is skipped.
2. `triage`: one `chat` call through the media pack, JSON reply.
3. `report`: a Markdown summary built locally.

Most paid calls: 2. Output: `triage` (the JSON), `markdown`, `source`.

## Dry run
Call `wf_issue_triage` with your input plus `"dry_run": true`. It lists the steps, which ones run for this input, what is missing (no chat provider, Firecrawl key) and `paid_calls_max`. Nothing runs.

## Recovering by hand
Nothing is retried. If `triage` fails, call `chat` yourself with the issue text and ask for the same JSON; the error lists which steps completed. If `fetch` was skipped, paste the issue text as `body` and run again.
