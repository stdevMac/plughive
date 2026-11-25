---
name: seo
description: Research search rankings, keyword demand, backlinks and on-page health with the DataForSEO tools. Use when the user wants to see who ranks for a query, size keywords, find topics for a domain, audit backlinks or check a page's on-page SEO.
---

# SEO (DataForSEO)

Five read-only tools. Every call is billed by DataForSEO, so pick the narrowest tool and the smallest `limit` or `depth` that answers the question.

## Which tool

- `seo_serp`: who ranks for one keyword right now. Use `depth` 10 to 20 for a quick look; cost grows with depth.
- `seo_keyword_volume`: search volume, CPC and competition for a list of keywords you already have. Batch them in one call (up to 1000) instead of one call per keyword.
- `seo_keywords_for_site`: discover keywords a domain relates to. Good for competitor research. Keep `limit` small first.
- `seo_backlinks`: backlink summary for a domain or URL. Add `include_list=true` only when you need the actual links; the default list mode is one link per referring domain.
- `seo_onpage`: instant audit of one URL (title, meta, H1, word count, on-page score, failed checks). JavaScript rendering is on by default and costs more; set `enable_javascript=false` for static pages.

## Cost notes

- SERP, volume and keywords-for-site are per-task charges; the backlinks list and JavaScript-rendered on-page audits cost more than the summary or the static audit.
- Do not loop these tools over many keywords or URLs without telling the user the expected number of calls.

## Setup

The pack needs `DATAFORSEO_LOGIN` and `DATAFORSEO_PASSWORD`. These are the API credentials from app.dataforseo.com under API Access, not the account login. If a call fails with `MISSING_SECRET`, tell the user which secret to set.

## Tips

- Location and language default to United States and English. Use `location_name` and `language_name` on `seo_serp`, and `location_code` and `language_code` on the keyword tools, for other markets.
- Errors from DataForSEO are returned as `DataForSEO <code>: <message>`; a code of 40000 or above is an API error even when HTTP says 200.
