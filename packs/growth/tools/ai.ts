// packs/growth/tools/ai.ts
//
// LLM-backed tools: ICP crafting, lead scoring, company research. All model
// calls go through ctx.llm; page content through the optional scrape tool.
import { defineTool, z } from "plughive/pack";
import { ICP_INSTRUCTION, RESEARCH_INSTRUCTION, SCORE_INSTRUCTION } from "../prompts.js";
import { resolveProvider } from "../providers/index.js";
import type { GrowthCtx, GrowthServices } from "../services.js";
import {
  chat,
  parseJsonLoose,
  readArtifactText,
  saveJson,
  scrapePage,
  siteUrl,
  summarize,
  untrustedBlock,
} from "../util.js";
import { providerHooks } from "./provider.js";

// ---------------------------------------------------------------- craft_icp

const CraftIcpInput = z.object({
  product_description: z.string().min(10),
  hints: z.string().optional(),
  model: z.string().optional(),
});

const IcpSchema = z.object({
  titles: z.array(z.string()).min(1),
  seniorities: z
    .array(
      z.enum([
        "owner",
        "founder",
        "c_suite",
        "partner",
        "vp",
        "head",
        "director",
        "manager",
        "senior",
        "entry",
      ]),
    )
    .min(1),
  employee_ranges: z.array(z.string()).min(1),
  locations: z.array(z.string()).default([]),
  keywords: z.string().default(""),
  rationale: z.string().min(1),
});

export async function runCraftIcp(input: z.infer<typeof CraftIcpInput>, ctx: GrowthCtx) {
  const user = `Product description:\n${input.product_description}${input.hints ? `\n\nAdditional hints:\n${input.hints}` : ""}`;
  const resp = await chat(ctx, "customer-research", ICP_INSTRUCTION, user, input.model);
  const icp = IcpSchema.parse(parseJsonLoose(resp.text, "craft_icp"));
  const artifact = await saveJson(
    ctx,
    "craft_icp",
    { icp, model: resp.model, source: "craft_icp" },
    {
      model: resp.model,
      prompt: input.product_description.slice(0, 500),
      meta: { hints: input.hints ?? null },
      costUsd: resp.costUsd,
    },
  );
  ctx.logger.info("icp crafted", { artifact: artifact.id });
  return { icp, artifact: summarize(artifact) };
}

export const craftIcp = defineTool<typeof CraftIcpInput, GrowthServices>({
  name: "craft_icp",
  description:
    "Convert a product description into a structured ICP (titles, seniorities, employee_ranges, locations, " +
    "keywords) ready to feed find_people. Saves the ICP as a JSON artifact. Uses an LLM.",
  input: CraftIcpInput,
  run: (input, ctx) => runCraftIcp(input, ctx as GrowthCtx),
});

// --------------------------------------------------------------- score_lead

const ScoreLeadInput = z.object({
  person_id: z.string().min(1),
  icp_artifact_id: z.string().min(1),
  model: z.string().optional(),
});

const ScoreSchema = z.object({
  score: z.number().int().min(0).max(100),
  reasoning: z.string().min(1),
});

export async function runScoreLead(input: z.infer<typeof ScoreLeadInput>, ctx: GrowthCtx) {
  const person = ctx.leads.getPerson(input.person_id);
  if (!person) throw new Error(`person ${input.person_id} not found`);
  const company = person.company_id ? ctx.leads.getCompany(person.company_id) : null;

  const icpJson = await readArtifactText(ctx, input.icp_artifact_id);
  if (icpJson === null) throw new Error(`icp artifact ${input.icp_artifact_id} not found`);

  const personJson = JSON.stringify(
    {
      email: person.email,
      email_status: person.email_status,
      title: person.title,
      seniority: person.seniority,
      linkedin_url: person.linkedin_url,
      company: company
        ? {
            name: company.name,
            domain: company.domain,
            industry: company.industry,
            employee_count: company.employee_count,
            location: company.location,
          }
        : null,
    },
    null,
    2,
  );
  const user = `ICP:\n\`\`\`json\n${icpJson}\n\`\`\`\n\nPerson:\n\`\`\`json\n${personJson}\n\`\`\``;
  const resp = await chat(ctx, "marketing-psychology", SCORE_INSTRUCTION, user, input.model);
  const out = ScoreSchema.parse(parseJsonLoose(resp.text, "score_lead"));
  ctx.leads.setFitScore(person.id, out.score, out.reasoning);
  ctx.logger.info("lead scored", { person_id: person.id, score: out.score });
  return { person_id: person.id, score: out.score, reasoning: out.reasoning };
}

export const scoreLead = defineTool<typeof ScoreLeadInput, GrowthServices>({
  name: "score_lead",
  description:
    "Score a person 0-100 against an ICP (from craft_icp). Persists fit_score and fit_reasoning on the " +
    "person row. Uses an LLM.",
  input: ScoreLeadInput,
  run: (input, ctx) => runScoreLead(input, ctx as GrowthCtx),
});

// ---------------------------------------------------------- research_prospect

const ResearchInput = z
  .object({
    domain: z.string().optional(),
    company_id: z.string().optional(),
    provider: z.string().optional(),
    fresh: z.boolean().default(false),
    /** When true and a scrape tool is available, read the company homepage to ground the brief. */
    scrape_site: z.boolean().default(true),
    model: z.string().optional(),
  })
  .refine((i) => !!i.domain || !!i.company_id, { message: "Provide domain or company_id" });

export async function runResearchProspect(input: z.infer<typeof ResearchInput>, ctx: GrowthCtx) {
  let company = input.company_id ? ctx.leads.getCompany(input.company_id) : null;
  if (!company && input.domain) {
    const { provider } = await resolveProvider(ctx, input.provider, providerHooks);
    const found = await provider.enrichCompany(input.domain);
    if (!found) throw new Error(`no company found for domain "${input.domain}"`);
    company = ctx.leads.getCompany(ctx.leads.upsertCompany(found).id);
  }
  if (!company) throw new Error("Company not found and no domain provided");

  if (!input.fresh && company.research_artifact_id) {
    const rec = await ctx.library.get(company.research_artifact_id);
    if (rec) {
      return {
        company_id: company.id,
        brief_markdown: await readArtifactText(ctx, rec.id),
        artifact: { id: rec.id, mime: rec.mime, url: rec.url },
        cached: true,
      };
    }
  }

  let siteSection = "";
  if (input.scrape_site && company.domain) {
    const page = await scrapePage(ctx, siteUrl(company.domain), 6000);
    if (page) {
      // Scraped text is untrusted: it goes into the prompt inside a per-call
      // boundary it cannot forge, marked as data rather than instructions.
      siteSection = `\n\n${untrustedBlock(page.markdown, "SCRAPED HOMEPAGE")}`;
    }
  }
  const sender = ctx.sender.get();
  const pitchSection = sender ? `\n\nSender pitch:\n${sender.pitch}` : "";
  const user = `Company JSON:\n\`\`\`json\n${company.raw_json}\n\`\`\`${siteSection}${pitchSection}`;
  const resp = await chat(ctx, "competitor-profiling", RESEARCH_INSTRUCTION, user, input.model);
  const md = resp.text.trim();
  if (!md) throw new Error("research_prospect: LLM returned empty content");

  const artifact = await ctx.library.save({
    kind: "document",
    mime: "text/markdown",
    bytes: new TextEncoder().encode(md),
    tool: "research_prospect",
    model: resp.model,
    prompt: company.domain ?? company.name ?? company.id,
    meta: { company_id: company.id, provider: company.provider, provider_id: company.provider_id },
    costUsd: resp.costUsd,
  });
  ctx.leads.setResearchArtifact(company.id, artifact.id);
  ctx.logger.info("research drafted", { company_id: company.id, artifact: artifact.id });
  return {
    company_id: company.id,
    brief_markdown: md,
    artifact: summarize(artifact),
    cached: false,
  };
}

export const researchProspect = defineTool<typeof ResearchInput, GrowthServices>({
  name: "research_prospect",
  description:
    "Generate a markdown research brief for a company (auto-enriches through the lead provider if the " +
    "company is not stored). Reads the homepage through a scrape tool when one is available. Saves the " +
    "brief as an artifact and caches it on the company. Uses an LLM.",
  annotations: { openWorldHint: true },
  // Enriching an unknown company is a billed lead-provider call.
  tags: ["paid"],
  input: ResearchInput,
  run: (input, ctx) => runResearchProspect(input, ctx as GrowthCtx),
});

export const aiTools = [craftIcp, scoreLead, researchProspect];
