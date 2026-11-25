// packs/growth/tools/local.ts
//
// Local queries over the pack's lead store. No API calls, no credits.
import { defineTool, z } from "plughive/pack";
import type { GrowthServices } from "../services.js";
import { CONTACT_STATUSES } from "../types.js";

const ContactStatus = z.enum(CONTACT_STATUSES);

const QueryLeadsInput = z.object({
  title_contains: z.string().optional(),
  seniority_in: z.array(z.string()).optional(),
  industry_contains: z.string().optional(),
  location_contains: z.string().optional(),
  domain_contains: z.string().optional(),
  email_status_in: z.array(z.string()).optional(),
  employee_min: z.number().int().nonnegative().optional(),
  employee_max: z.number().int().nonnegative().optional(),
  fit_score_min: z.number().int().min(0).max(100).optional(),
  since: z.number().int().nonnegative().optional(),
  has_email: z.boolean().optional(),
  contact_status_in: z.array(ContactStatus).optional(),
  exclude_contact_status: z.array(ContactStatus).optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().nonnegative().default(0),
});

export const queryLeads = defineTool<typeof QueryLeadsInput, GrowthServices>({
  name: "query_leads",
  description:
    "Local query against the lead store (no API call). Filter by title_contains, seniority_in, " +
    "industry_contains, employee range, has_email, fit_score_min, etc. Returns people joined to companies.",
  annotations: { readOnlyHint: true },
  input: QueryLeadsInput,
  async run(input, ctx) {
    const r = ctx.leads.query(input);
    return {
      total: r.total,
      count: r.people.length,
      people: r.people.map((p) => ({
        id: p.id,
        provider: p.provider,
        provider_id: p.provider_id,
        email: p.email,
        email_status: p.email_status,
        first_name: p.first_name,
        last_name: p.last_name,
        title: p.title,
        seniority: p.seniority,
        linkedin_url: p.linkedin_url,
        fit_score: p.fit_score,
        fit_reasoning: p.fit_reasoning,
        contact_status: p.contact_status,
        last_contacted_at: p.last_contacted_at,
        company: p.company
          ? {
              id: p.company.id,
              domain: p.company.domain,
              name: p.company.name,
              industry: p.company.industry,
              employee_count: p.company.employee_count,
            }
          : null,
      })),
    };
  },
});

const QueryCompaniesInput = z.object({
  domain_contains: z.string().optional(),
  industry_contains: z.string().optional(),
  location_contains: z.string().optional(),
  name_contains: z.string().optional(),
  employee_min: z.number().int().nonnegative().optional(),
  employee_max: z.number().int().nonnegative().optional(),
  has_research_brief: z.boolean().optional(),
  since: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(1000).default(100),
  offset: z.number().int().nonnegative().default(0),
});

export const queryCompanies = defineTool<typeof QueryCompaniesInput, GrowthServices>({
  name: "query_companies",
  description:
    "Local filter against the lead store's companies (no API call). Filter by domain/industry/" +
    "location/name/employee range/has_research_brief/since. Companion to query_leads: see which " +
    "companies you have enriched and which have research briefs cached.",
  annotations: { readOnlyHint: true },
  input: QueryCompaniesInput,
  async run(input, ctx) {
    const r = ctx.leads.queryCompanies(input);
    return {
      total: r.total,
      count: r.companies.length,
      companies: r.companies.map((c) => ({
        id: c.id,
        provider: c.provider,
        provider_id: c.provider_id,
        domain: c.domain,
        name: c.name,
        industry: c.industry,
        employee_count: c.employee_count,
        annual_revenue: c.annual_revenue,
        location: c.location,
        technologies: c.technologies_json ? (JSON.parse(c.technologies_json) as string[]) : null,
        research_artifact_id: c.research_artifact_id,
        first_seen_at: c.first_seen_at,
        last_seen_at: c.last_seen_at,
      })),
    };
  },
});

export const localTools = [queryLeads, queryCompanies];
