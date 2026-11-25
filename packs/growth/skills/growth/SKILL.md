---
name: growth
description: Find leads, score them against an ideal customer profile, research companies and draft cold email with the growth pack. Use when the user wants prospecting, lead lists, outbound sequences or a full client-finding pipeline.
---

# Growth pack

Lead search and enrichment through a lead provider (Apollo today), a local lead store, LLM scoring and research, and cold-email drafting. Nothing is sent: drafts are saved as artifacts for the user to review and send.

## Setup

- Add `APOLLO_API_KEY` in the secrets settings to use provider tools. Local and LLM tools work without it.
- Optional: save a sender with `set_sender_profile` (name, email, pitch, optional `cta_url`). Without a `cta_url` drafts carry no link.
- Optional tools used when present: `firecrawl_scrape` (homepage text for research and personalization) and `dub_shorten_url` (link shortening). Without them the pack continues with lead data and raw URLs.

## Pipeline order

1. `leads_provider_status`: confirm a key works and quota remains.
2. `craft_icp`: turn the product description into titles, seniorities, size and keywords.
3. `find_people` / `find_companies`: search; every result is stored locally. Pass `provider` to choose one, otherwise the first configured is used.
4. `query_leads` / `query_companies`: inspect what is stored (free, local).
5. `score_lead`: 0-100 fit against the ICP.
6. `research_prospect`: markdown brief per company, cached.
7. `draft_cold_email` or `personalize_outreach`: three-touch sequence; marks the person `drafted`.
8. `list_drafts`, then `mark_contacted` as outreach progresses.

`pipeline_run` runs steps 2-7 in one call. The search stage is skipped when no provider key is set.

## Cost notes

- Provider calls (`find_*`, `enrich_*`) can consume provider credits; `enrich_person`, `enrich_people` and `enrich_company` are the usual cost. Search is cheaper but rate limited.
- `craft_icp`, `score_lead`, `research_prospect`, `draft_cold_email`, `personalize_outreach` each use the LLM. `pipeline_run` makes many such calls: run `leads_provider_status` first and keep `search_pages`, `max_research` and `max_drafts` small for a first run.
- Query tools are local and free.

## Deprecated names

`apollo_search_people`, `apollo_search_companies`, `apollo_enrich_person`, `apollo_bulk_enrich_people`, `apollo_enrich_company` and `apollo_health_check` still work as aliases of the generic tools above. Results use `provider_id` where they once used `apollo_id`.
