// packs/growth/tools/pipeline.ts
//
// Single-shot orchestrator: craft_icp, find_people (loop), score_lead,
// research_prospect per unique company, draft_cold_email for the top scored.
// Search and research are skipped when no lead provider has a key set.
import { defineTool, z } from "plughive/pack";
import { listProviders, resolveProvider } from "../providers/index.js";
import type { GrowthCtx, GrowthServices } from "../services.js";
import { runCraftIcp, runResearchProspect, runScoreLead } from "./ai.js";
import { SenderInput, runDraftColdEmail } from "./outreach.js";
import { providerHooks } from "./provider.js";

const PipelineInput = z.object({
  product_description: z.string().min(10),
  /** Inline sender. If omitted, the saved sender profile is used. */
  sender: SenderInput.optional(),
  hints: z.string().optional(),
  provider: z.string().optional(),
  /** How many search pages (per_page=25) to pull from the provider. */
  search_pages: z.number().int().min(1).max(20).default(2),
  /** Minimum fit score for a draft to be generated. */
  draft_min_score: z.number().int().min(0).max(100).default(75),
  /** Cap drafts at this many even if more match. */
  max_drafts: z.number().int().min(1).max(50).default(10),
  /** Cap research briefs (one per unique company among top-scored). */
  max_research: z.number().int().min(1).max(50).default(10),
  /** Call-to-action URL. Falls back to the sender profile's cta_url; with neither, drafts carry no link. */
  cta_url: z.url({ protocol: /^https?$/ }).optional(),
  model: z.string().optional(),
});

interface StageResult {
  ran: boolean;
  skipped_reason?: string;
  detail?: unknown;
}

const NO_PROVIDER = "no lead provider has an API key set";

export async function runPipeline(input: z.infer<typeof PipelineInput>, ctx: GrowthCtx) {
  if (!input.sender && !ctx.sender.get()) {
    throw new Error(
      "pipeline_run: no sender provided and no saved profile (call set_sender_profile first or pass sender inline)",
    );
  }
  const stages: Record<"icp" | "search" | "research" | "score" | "drafts", StageResult> = {
    icp: { ran: false },
    search: { ran: false },
    research: { ran: false },
    score: { ran: false },
    drafts: { ran: false },
  };
  const summary = {
    people_found: 0,
    people_scored: 0,
    drafts_created: 0,
    top_drafts: [] as Array<{
      person_id: string;
      name: string;
      company: string | null;
      fit_score: number | null;
      artifact_id: string;
      subject: string;
    }>,
  };

  const configured = (await listProviders(ctx)).some(
    (p) => p.configured && (!input.provider || p.id === input.provider),
  );
  if (!configured) stages.search.skipped_reason = NO_PROVIDER;

  // 1. ICP
  const icpRes = await runCraftIcp(
    { product_description: input.product_description, hints: input.hints, model: input.model },
    ctx,
  );
  stages.icp = { ran: true };
  const icp = icpRes.icp;

  // 2. Search
  if (configured) {
    const { provider } = await resolveProvider(ctx, input.provider, providerHooks);
    let upserted = 0;
    let total = 0;
    for (let page = 1; page <= input.search_pages; page++) {
      const res = await provider.findPeople({
        titles: icp.titles,
        seniorities: icp.seniorities,
        employee_ranges: icp.employee_ranges,
        organization_locations: icp.locations.length > 0 ? icp.locations : undefined,
        keywords: icp.keywords || undefined,
        page,
        per_page: 25,
      });
      if (res.people.length === 0) break;
      for (const p of res.people) {
        const r = ctx.leads.upsertPerson(p);
        if (r.created) upserted++;
        total++;
      }
    }
    stages.search = { ran: true, detail: { upserted, total } };
    summary.people_found = total;
  }

  // 3. Score everyone seen in the last few minutes who has no score yet
  const recent = ctx.leads.query({ since: Date.now() - 5 * 60 * 1000, limit: 200 }).people;
  let scored = 0;
  for (const p of recent) {
    if (p.fit_score !== null) continue;
    try {
      await runScoreLead(
        { person_id: p.id, icp_artifact_id: icpRes.artifact.id, model: input.model },
        ctx,
      );
      scored++;
    } catch (e) {
      ctx.logger.warn("score failed", { person_id: p.id, err: (e as Error).message });
    }
  }
  stages.score = { ran: true, detail: { scored } };
  summary.people_scored = scored;

  // 4. Research unique companies among the top scored, skipping anyone already worked
  const topScored = ctx.leads.query({
    fit_score_min: input.draft_min_score,
    has_email: true,
    exclude_contact_status: ["drafted", "sent", "replied", "won", "lost", "skipped"],
    limit: input.max_drafts * 2,
  }).people;

  const seen = new Set<string>();
  let researched = 0;
  for (const p of topScored) {
    if (researched >= input.max_research) break;
    if (!p.company || seen.has(p.company.id)) continue;
    seen.add(p.company.id);
    try {
      await runResearchProspect(
        { company_id: p.company.id, fresh: false, scrape_site: true, model: input.model },
        ctx,
      );
      researched++;
    } catch (e) {
      ctx.logger.warn("research failed", { company_id: p.company.id, err: (e as Error).message });
    }
  }
  stages.research = { ran: true, detail: { researched } };

  // 5. Drafts
  for (const p of topScored.slice(0, input.max_drafts)) {
    const company = p.company ? ctx.leads.getCompany(p.company.id) : null;
    try {
      const d = await runDraftColdEmail(
        {
          person_id: p.id,
          sender: input.sender,
          research_artifact_id: company?.research_artifact_id ?? undefined,
          cta_url: input.cta_url,
          model: input.model,
        },
        ctx,
      );
      summary.top_drafts.push({
        person_id: p.id,
        name: [p.first_name, p.last_name].filter(Boolean).join(" ") || (p.email ?? "(unknown)"),
        company: p.company?.name ?? null,
        fit_score: p.fit_score,
        artifact_id: d.artifact.id,
        subject: d.subject,
      });
    } catch (e) {
      ctx.logger.warn("draft failed", { person_id: p.id, err: (e as Error).message });
    }
  }
  stages.drafts = { ran: true, detail: { created: summary.top_drafts.length } };
  summary.drafts_created = summary.top_drafts.length;

  ctx.logger.info("pipeline_run complete", {
    found: summary.people_found,
    scored,
    drafts: summary.drafts_created,
  });
  return { icp_artifact_id: icpRes.artifact.id as string | null, stages, summary };
}

export const pipelineRun = defineTool<typeof PipelineInput, GrowthServices>({
  name: "pipeline_run",
  description:
    "End-to-end client-finding pipeline: craft_icp, find_people, score_lead, research_prospect (unique " +
    "companies), draft_cold_email (top scored). Search is skipped when no lead provider key is set. " +
    "Needs a sender (inline or saved profile). Uses an LLM many times and may consume provider credits; " +
    "check leads_provider_status first.",
  // Runs the billed lead-provider search (and LLM calls), so the gate needs "paid".
  tags: ["paid"],
  annotations: { openWorldHint: true },
  input: PipelineInput,
  run: (input, ctx) => runPipeline(input, ctx as GrowthCtx),
});
