// packs/web/index.ts
import { type PackContext, definePack, defineTool, z } from "plughive/pack";
import { providers } from "./capabilities.js";
import { FirecrawlClient } from "./firecrawl.js";
import { makeScreenshotTool } from "./screenshot.js";

const SECRETS = ["FIRECRAWL_API_KEY"] as const;
// These tools call the billed Firecrawl API directly (not through the capability
// router), so the policy gate needs the "paid" tag to see them.
const PAID = ["web", "paid"] as const;

async function client(ctx: PackContext): Promise<FirecrawlClient> {
  return new FirecrawlClient(ctx.fetch, await ctx.secrets.get("FIRECRAWL_API_KEY"), {
    signal: ctx.signal,
    ...(crawlHooks.retryBaseMs !== undefined ? { retryBaseMs: crawlHooks.retryBaseMs } : {}),
  });
}

/** Test hooks: delay between failed crawl polls, and the client's retry backoff (ms). */
export const crawlHooks: { pollRetryMs?: number; retryBaseMs?: number } = {};

/** Consecutive failed status polls tolerated before giving up on watching a crawl. */
const MAX_POLL_FAILURES = 5;

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Error for a crawl that was submitted (and billed) but could not be watched to the end. */
function crawlError(jobId: string, what: string): Error {
  return new Error(
    `firecrawl_crawl ${what}. The crawl job ${jobId} was already submitted and is billed by Firecrawl; do not run a new crawl. Call firecrawl_crawl again with job_id "${jobId}" to resume watching it.`,
  );
}

const shortText = z.string().max(500);

interface ArtifactSummary {
  id: string;
  mime: string;
  url: string;
}

function summarise(ref: ArtifactSummary): ArtifactSummary {
  return { id: ref.id, mime: ref.mime, url: ref.url };
}

const firecrawlScrape = defineTool({
  name: "firecrawl_scrape",
  description:
    "Scrape one URL via Firecrawl v2. Defaults to markdown format. Saves the markdown body as a library artifact " +
    "for replay. Use for company-page personalization, blog content extraction, or pricing-page diffs.",
  capability: "web_scrape",
  secrets: SECRETS,
  tags: PAID,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    url: z.url({ protocol: /^https?$/ }).max(2048),
    formats: z
      .array(z.enum(["markdown", "html", "rawHtml", "links", "screenshot", "json"]))
      .optional(),
    only_main_content: z.boolean().optional(),
    wait_for_ms: z.number().int().nonnegative().max(60_000).optional(),
    timeout_ms: z.number().int().min(1000).max(300_000).optional(),
    include_tags: z.array(shortText).max(100).optional(),
    exclude_tags: z.array(shortText).max(100).optional(),
  }),
  async run(input, ctx) {
    const doc = await (await client(ctx)).scrape({
      url: input.url,
      formats: input.formats ?? ["markdown"],
      onlyMainContent: input.only_main_content,
      waitFor: input.wait_for_ms,
      timeout: input.timeout_ms,
      includeTags: input.include_tags,
      excludeTags: input.exclude_tags,
    });

    let artifact: ArtifactSummary | null = null;
    if (doc.markdown) {
      const ref = await ctx.library.save({
        kind: "document",
        mime: "text/markdown",
        bytes: Buffer.from(doc.markdown, "utf8"),
        tool: "firecrawl_scrape",
        model: null,
        prompt: input.url,
        meta: {
          url: input.url,
          title: doc.metadata?.title ?? null,
          status_code: doc.metadata?.statusCode ?? null,
        },
      });
      artifact = summarise(ref);
    }

    ctx.logger.info("firecrawl scraped", { url: input.url, artifact: artifact?.id ?? null });
    return {
      url: input.url,
      title: doc.metadata?.title ?? null,
      markdown: doc.markdown ?? null,
      links: Array.isArray(doc.links) ? doc.links : null,
      status_code: doc.metadata?.statusCode ?? null,
      artifact,
    };
  },
});

const firecrawlSearch = defineTool({
  name: "firecrawl_search",
  description:
    "Web search via Firecrawl v2. Returns grouped {web, news, images}. Use for prospect research, " +
    "competitor surveillance, finding press mentions, or sourcing content.",
  capability: "web_search",
  secrets: SECRETS,
  tags: PAID,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    query: z.string().min(1).max(1000),
    limit: z.number().int().min(1).max(100).default(10),
    sources: z.array(z.enum(["web", "news", "images"])).optional(),
    location: z.string().max(200).optional(),
    tbs: z.string().max(200).optional(),
  }),
  async run(input, ctx) {
    const r = await (await client(ctx)).search({
      query: input.query,
      limit: input.limit,
      sources: input.sources,
      location: input.location,
      tbs: input.tbs,
    });
    return {
      query: input.query,
      web: (r.web ?? []).map((x) => ({
        url: x.url ?? null,
        title: x.title ?? null,
        description: x.description ?? null,
      })),
      news: (r.news ?? []).map((x) => ({
        url: x.url ?? null,
        title: x.title ?? null,
        description: x.description ?? null,
      })),
      images: (r.images ?? []).map((x) => ({ url: x.url ?? null, title: x.title ?? null })),
    };
  },
});

const firecrawlMap = defineTool({
  name: "firecrawl_map",
  description:
    "Discover URLs on a domain via Firecrawl v2. Optional 'search' filter narrows by keyword. " +
    "Useful for finding case-study/pricing/blog index pages on prospect domains.",
  capability: "web_map",
  secrets: SECRETS,
  tags: PAID,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z.object({
    url: z.url({ protocol: /^https?$/ }).max(2048),
    search: z.string().max(500).optional(),
    limit: z.number().int().min(1).max(5000).default(500),
  }),
  async run(input, ctx) {
    const r = await (await client(ctx)).map({
      url: input.url,
      search: input.search,
      limit: input.limit,
    });
    return { url: input.url, links: r.links, count: r.links.length };
  },
});

interface PageSummary {
  url: string;
  title: string | null;
  status_code: number | null;
  bytes: number;
}

const firecrawlCrawl = defineTool({
  name: "firecrawl_crawl",
  description:
    "Async multi-page crawl via Firecrawl v2 (submit + poll). Concatenates all page markdowns into one " +
    "artifact. Use for deep company research where one scrape isn't enough. Defaults: limit 50, 5min timeout. " +
    "If a call ends before the crawl finishes, its error names the job id: pass it as job_id to resume " +
    "watching that crawl instead of starting (and paying for) a new one.",
  capability: "web_crawl",
  secrets: SECRETS,
  longRunning: true,
  tags: PAID,
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: z
    .object({
      url: z
        .url({ protocol: /^https?$/ })
        .max(2048)
        .optional(),
      job_id: z
        .string()
        .regex(/^[A-Za-z0-9_-]{1,128}$/, "job_id is a Firecrawl crawl id")
        .optional(),
      limit: z.number().int().min(1).max(500).default(50),
      max_depth: z.number().int().min(0).max(10).optional(),
      include_paths: z.array(shortText).max(100).optional(),
      exclude_paths: z.array(shortText).max(100).optional(),
      poll_interval_ms: z.number().int().min(500).max(30_000).default(2000),
      poll_timeout_ms: z.number().int().min(10_000).max(900_000).default(300_000),
      only_main_content: z.boolean().default(true),
    })
    .refine((i) => (i.url === undefined) !== (i.job_id === undefined), {
      message: "Provide either url (start a crawl) or job_id (resume watching one), not both",
    }),
  async run(input, ctx) {
    const api = await client(ctx);
    let jobId: string;
    if (input.job_id) {
      jobId = input.job_id;
      ctx.logger.info("crawl resumed", { job_id: jobId });
    } else {
      const submitted = await api.submitCrawl({
        url: input.url as string,
        limit: input.limit,
        maxDepth: input.max_depth,
        includePaths: input.include_paths,
        excludePaths: input.exclude_paths,
        scrapeOptions: { formats: ["markdown"], onlyMainContent: input.only_main_content },
      });
      if (!submitted.id) throw new Error("Firecrawl submitCrawl returned no job id");
      jobId = submitted.id;
      ctx.logger.info("crawl submitted", { url: input.url, job_id: jobId });
    }

    const deadline = Date.now() + input.poll_timeout_ms;
    let last: Awaited<ReturnType<FirecrawlClient["crawlStatus"]>> | null = null;
    let failures = 0;
    while (Date.now() < deadline) {
      ctx.signal?.throwIfAborted();
      try {
        last = await api.crawlStatus(jobId);
        failures = 0;
      } catch (e) {
        if (ctx.signal?.aborted) throw ctx.signal.reason;
        failures++;
        const msg = e instanceof Error ? e.message : String(e);
        if (failures >= MAX_POLL_FAILURES) {
          throw crawlError(jobId, `could not read the crawl status (${msg})`);
        }
        ctx.logger.warn("crawl status poll failed", { job_id: jobId, failures, error: msg });
        await abortableSleep(
          (crawlHooks.pollRetryMs ?? input.poll_interval_ms) * 2 ** (failures - 1),
          ctx.signal,
        );
        continue;
      }
      if (last.status === "completed" || last.status === "failed") break;
      await abortableSleep(input.poll_interval_ms, ctx.signal);
    }

    if (!last) throw crawlError(jobId, "got no status before poll_timeout_ms");
    if (last.status === "failed") {
      throw new Error(`firecrawl_crawl job ${jobId} failed: ${String(last.error ?? "unknown")}`);
    }
    if (last.status !== "completed") {
      throw crawlError(jobId, `timed out (last status: ${String(last.status)})`);
    }

    const pages = last.data ?? [];
    const summaries: PageSummary[] = [];
    const sections: string[] = [];
    for (const p of pages) {
      const md = p.markdown ?? "";
      const meta = p.metadata ?? {};
      const url = meta.sourceURL ?? (meta.url as string | undefined) ?? input.url ?? "";
      const title = meta.title ?? null;
      summaries.push({
        url,
        title,
        status_code: meta.statusCode ?? null,
        bytes: Buffer.byteLength(md, "utf8"),
      });
      if (md.trim()) sections.push(`# ${title ?? url}\n\nSource: ${url}\n\n${md}`);
    }

    let artifact: ArtifactSummary | null = null;
    if (sections.length > 0) {
      const ref = await ctx.library.save({
        kind: "document",
        mime: "text/markdown",
        bytes: Buffer.from(sections.join("\n\n---\n\n"), "utf8"),
        tool: "firecrawl_crawl",
        model: null,
        prompt: input.url ?? jobId,
        meta: { url: input.url ?? null, job_id: jobId, pages: pages.length },
      });
      artifact = summarise(ref);
    }

    ctx.logger.info("crawl completed", {
      job_id: jobId,
      pages: pages.length,
      artifact: artifact?.id ?? null,
    });
    return {
      job_id: jobId,
      status: last.status,
      pages: pages.length,
      total_chars: summaries.reduce((acc, p) => acc + p.bytes, 0),
      pages_summary: summaries,
      artifact,
    };
  },
});

export default definePack({
  providers,
  tools: [firecrawlScrape, firecrawlSearch, firecrawlMap, firecrawlCrawl, makeScreenshotTool()],
});
