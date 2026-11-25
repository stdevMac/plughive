// packs/seo/index.ts
import { type PackContext, definePack, defineTool, z } from "plughive/pack";
import { DataForSEOClient } from "./client.js";

const SECRETS = ["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"] as const;
// Every tool below calls the billed DataForSEO API directly (not through the
// capability router), so the policy gate needs the "paid" tag to see them.
const PAID = ["seo", "paid"] as const;

// DataForSEO responses are loosely typed JSON; every field read below is
// null-coalesced, so a missing field never throws.
// biome-ignore lint/suspicious/noExplicitAny: external JSON of unknown shape
type Row = Record<string, any>;

async function client(ctx: PackContext): Promise<DataForSEOClient> {
  const [login, password] = await Promise.all([
    ctx.secrets.get("DATAFORSEO_LOGIN"),
    ctx.secrets.get("DATAFORSEO_PASSWORD"),
  ]);
  return new DataForSEOClient(ctx.fetch, login, password, { signal: ctx.signal });
}

// Bounded free-text inputs: every value is forwarded to a billed API.
const keywordText = z.string().trim().min(1).max(700);
const placeName = z.string().trim().min(1).max(200);
const langCode = z.string().trim().min(2).max(10);
const target = z.string().trim().min(3).max(2048);
const locationCode = z.number().int().positive().max(100_000_000);

/** `tasks[0]`, or an empty row when the response has none. */
function firstTask(resp: Record<string, unknown>): Row {
  const tasks = resp.tasks;
  return (Array.isArray(tasks) ? tasks[0] : undefined) ?? {};
}

const num = (v: unknown): number | null => (typeof v === "number" ? v : null);

// ---------------------------------------------------------------------------

const seoSerp = defineTool({
  name: "seo_serp",
  description:
    "Live Google SERP via DataForSEO. Returns ranked organic results for a keyword + " +
    "location/language. Use to see who ranks for a term, where you sit, who competes for the keyword.",
  capability: "seo_serp",
  secrets: SECRETS,
  tags: PAID,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    keyword: keywordText,
    location_name: placeName.default("United States"),
    language_name: placeName.default("English"),
    device: z.enum(["desktop", "mobile"]).optional(),
    depth: z.number().int().min(1).max(100).default(20),
  }),
  async run(input, ctx) {
    const resp = await (await client(ctx)).serpGoogleOrganicLive({
      keyword: input.keyword,
      location_name: input.location_name,
      language_name: input.language_name,
      ...(input.device ? { device: input.device } : {}),
      depth: input.depth,
    });
    const result: Row | undefined = firstTask(resp).result?.[0];
    const rawItems: Row[] = Array.isArray(result?.items) ? result.items : [];
    const items = rawItems.map((i) => ({
      rank: num(i.rank_absolute),
      url: i.url ?? null,
      title: i.title ?? null,
      description: i.description ?? null,
      domain: i.domain ?? null,
      type: i.type ?? null,
    }));
    return {
      keyword: input.keyword,
      total_count: result?.total_count ?? items.length,
      items_count: items.length,
      items,
      raw_summary: { se_results_count: result?.se_results_count ?? null },
    };
  },
});

const seoKeywordVolume = defineTool({
  name: "seo_keyword_volume",
  description:
    "Search volume + CPC + competition for a list of keywords (DataForSEO Google Ads). " +
    "Use to size keyword opportunities or validate target queries before content/SEO work.",
  capability: "seo_keywords",
  secrets: SECRETS,
  tags: PAID,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    keywords: z.array(keywordText.max(80)).min(1).max(1000),
    location_code: locationCode.default(2840), // United States
    language_code: langCode.default("en"),
  }),
  async run(input, ctx) {
    const resp = await (await client(ctx)).keywordsSearchVolumeLive({
      keywords: input.keywords,
      location_code: input.location_code,
      language_code: input.language_code,
    });
    const rows: Row[] = firstTask(resp).result ?? [];
    const keywords = rows.map((r) => ({
      keyword: r.keyword as string,
      search_volume: r.search_volume ?? null,
      competition: num(r.competition),
      competition_level: r.competition_level ?? null,
      cpc: num(r.cpc),
      low_top_of_page_bid: r.low_top_of_page_bid ?? null,
      high_top_of_page_bid: r.high_top_of_page_bid ?? null,
    }));
    return { count: keywords.length, keywords };
  },
});

const seoKeywordsForSite = defineTool({
  name: "seo_keywords_for_site",
  description:
    "Keywords related to a domain (DataForSEO Google Ads keywords-for-site). Returns up to `limit` " +
    "keywords with volume/CPC/competition. Use to discover what topics your or a competitor's site relates to.",
  capability: "seo_keywords",
  secrets: SECRETS,
  tags: PAID,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    target,
    location_code: locationCode.default(2840),
    language_code: langCode.default("en"),
    limit: z.number().int().min(1).max(1000).default(100),
  }),
  async run(input, ctx) {
    const resp = await (await client(ctx)).keywordsForSiteLive({
      target: input.target,
      location_code: input.location_code,
      language_code: input.language_code,
      limit: input.limit,
    });
    const rows: Row[] = firstTask(resp).result ?? [];
    const keywords = rows.map((r) => ({
      keyword: r.keyword as string,
      search_volume: r.search_volume ?? null,
      competition: num(r.competition),
      cpc: num(r.cpc),
    }));
    return { target: input.target, count: keywords.length, keywords };
  },
});

const seoBacklinks = defineTool({
  name: "seo_backlinks",
  description:
    "Backlink summary (domain rank, total links, referring domains, spam score) for a target. " +
    "Set include_list=true to also fetch the top backlinks list (defaults to one per referring domain).",
  capability: "seo_backlinks",
  secrets: SECRETS,
  tags: PAID,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    target,
    include_list: z.boolean().default(false),
    list_limit: z.number().int().min(1).max(1000).default(50),
    list_mode: z.enum(["as_is", "one_per_domain", "one_per_anchor"]).default("one_per_domain"),
  }),
  async run(input, ctx) {
    const api = await client(ctx);
    const summary: Row =
      firstTask(await api.backlinksSummaryLive({ target: input.target })).result?.[0] ?? {};

    const out: {
      target: string;
      domain_rank: number | null;
      total_backlinks: number | null;
      referring_domains: number | null;
      backlinks_spam_score: number | null;
      spam_referring_domains: number | null;
      list?: Array<{
        url_from: string | null;
        url_to: string | null;
        domain_from: string | null;
        rank: number | null;
        anchor: string | null;
        is_dofollow: boolean | null;
        first_seen: string | null;
      }>;
    } = {
      target: input.target,
      domain_rank: summary.rank ?? summary.domain_rank ?? null,
      total_backlinks: summary.backlinks ?? null,
      referring_domains: summary.referring_domains ?? null,
      backlinks_spam_score: summary.backlinks_spam_score ?? null,
      spam_referring_domains: summary.referring_domains_nofollow ?? null,
    };

    if (input.include_list) {
      const list = await api.backlinksListLive({
        target: input.target,
        mode: input.list_mode,
        limit: input.list_limit,
      });
      const items: Row[] = firstTask(list).result?.[0]?.items ?? [];
      out.list = items.map((i) => ({
        url_from: i.url_from ?? null,
        url_to: i.url_to ?? null,
        domain_from: i.domain_from ?? null,
        rank: num(i.rank),
        anchor: i.anchor ?? null,
        is_dofollow: typeof i.dofollow === "boolean" ? i.dofollow : null,
        first_seen: i.first_seen ?? null,
      }));
    }
    return out;
  },
});

const seoOnPage = defineTool({
  name: "seo_onpage",
  description:
    "Instant on-page SEO audit via DataForSEO. Title/meta/H1/word count, on-page score, " +
    "redirects, broken links, render-blocking scripts, full check list. JS-rendered by default.",
  capability: "seo_onpage",
  secrets: SECRETS,
  tags: PAID,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    url: z.url({ protocol: /^https?$/ }).max(2048),
    enable_javascript: z.boolean().default(true),
  }),
  async run(input, ctx) {
    const resp = await (await client(ctx)).onPageInstant({
      url: input.url,
      enable_javascript: input.enable_javascript,
    });
    const result: Row = firstTask(resp).result?.[0]?.items?.[0] ?? {};
    const meta: Row = result.meta ?? {};
    const checks: Row = result.checks ?? {};
    const failed = Object.keys(checks).filter((k) => checks[k] === false);
    return {
      url: input.url,
      status_code: result.status_code ?? null,
      fetch_time: result.fetch_time ?? null,
      page_metrics: {
        title: meta.title ?? null,
        meta_description: meta.description ?? null,
        h1_count: Array.isArray(meta.h1) ? meta.h1.length : null,
        word_count: meta.content?.plain_text_word_count ?? null,
        onpage_score: num(result.onpage_score),
        seo_friendly_url:
          typeof checks.seo_friendly_url === "boolean" ? checks.seo_friendly_url : null,
        duplicate_meta_tags: num(checks.duplicate_meta_tags),
        broken_links: num(checks.broken_links),
        render_blocking_scripts: num(checks.render_blocking_scripts),
        redirects_count: num(result.redirects_count),
      },
      checks_failed: failed,
      raw: result,
    };
  },
});

export default definePack({
  tools: [seoSerp, seoKeywordVolume, seoKeywordsForSite, seoBacklinks, seoOnPage],
});
