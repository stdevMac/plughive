// packs/growth/tools/provider.ts
//
// Provider-backed tools: find and enrich people and companies. Every result is
// upserted into the local lead store. The provider is chosen per call, else the
// first configured one.
import { defineTool, z } from "plughive/pack";
import { listProviders, resolveProvider } from "../providers/index.js";
import type { GrowthServices } from "../services.js";
import type { LeadPerson } from "../types.js";

/** Test hook: lets tests shrink the provider's retry delay. */
export const providerHooks: { retryBaseMs?: number } = {};

const providerField = z
  .string()
  .optional()
  .describe("Lead provider id (default: the first configured one). Currently: apollo.");

const personLookup = z
  .object({
    email: z.string().email().optional(),
    linkedin_url: z.string().url().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    domain: z.string().optional(),
  })
  .refine((i) => !!i.email || !!i.linkedin_url || (!!i.first_name && !!i.last_name && !!i.domain), {
    message: "Provide email, OR linkedin_url, OR first_name + last_name + domain",
  });

const FindPeopleInput = z.object({
  provider: providerField,
  // Person filters
  titles: z.array(z.string()).optional(),
  include_similar_titles: z.boolean().optional(),
  locations: z.array(z.string()).optional(),
  seniorities: z.array(z.string()).optional(),
  contact_email_status: z
    .array(z.enum(["verified", "unverified", "likely to engage", "unavailable"]))
    .optional(),
  keywords: z.string().optional(),
  // Organization filters
  organization_locations: z.array(z.string()).optional(),
  /** Bare domains, no www or @. Max 1,000. */
  organization_domains: z.array(z.string()).max(1000).optional(),
  /** Provider company ids, exact match. */
  organization_ids: z.array(z.string()).optional(),
  employee_ranges: z.array(z.string()).optional(),
  revenue_min: z.number().optional(),
  revenue_max: z.number().optional(),
  // Tech stack filters
  using_technologies_all: z.array(z.string()).optional(),
  using_technologies_any: z.array(z.string()).optional(),
  not_using_technologies: z.array(z.string()).optional(),
  // Active job postings (intent signal)
  organization_job_titles: z.array(z.string()).optional(),
  organization_job_locations: z.array(z.string()).optional(),
  num_jobs_min: z.number().int().nonnegative().optional(),
  num_jobs_max: z.number().int().nonnegative().optional(),
  job_posted_after: z.string().optional(),
  job_posted_before: z.string().optional(),
  // Pagination
  page: z.number().int().min(1).default(1),
  per_page: z.number().int().min(1).max(100).default(25),
});

const FindCompaniesInput = z.object({
  provider: providerField,
  locations: z.array(z.string()).optional(),
  employee_ranges: z.array(z.string()).optional(),
  keywords: z.string().optional(),
  page: z.number().int().min(1).default(1),
  per_page: z.number().int().min(1).max(100).default(25),
});

function personSummary(id: string, p: LeadPerson) {
  return {
    id,
    provider_id: p.id,
    email: p.email,
    email_status: p.emailStatus,
    first_name: p.firstName,
    last_name: p.lastName,
    title: p.title,
    seniority: p.seniority,
    linkedin_url: p.linkedinUrl,
    city: p.city,
    state: p.state,
    country: p.country,
    company: p.organization?.name ?? null,
    company_domain: p.organization?.domain ?? null,
  };
}

export const findPeople = defineTool<typeof FindPeopleInput, GrowthServices>({
  name: "find_people",
  description:
    "Search people with a lead provider (default: the first configured; currently Apollo). Full filter " +
    "surface: titles + include_similar_titles, seniorities, locations, contact_email_status, keywords; " +
    "organization_domains (max 1000), organization_ids, organization_locations, employee_ranges, " +
    "revenue_min/max; tech-stack filters; active-job-posting signals. Upserts every result into the " +
    "local lead store. Pagination is explicit.",
  capability: "find_people",
  // Calls the billed lead-provider API directly, so the gate needs "paid".
  tags: ["paid"],
  annotations: { openWorldHint: true },
  input: FindPeopleInput,
  async run(input, ctx) {
    const { provider: name, ...query } = input;
    const { provider, descriptor } = await resolveProvider(ctx, name, providerHooks);
    const { people, page } = await provider.findPeople(query);
    let upserted = 0;
    const out = [];
    for (const p of people) {
      const r = ctx.leads.upsertPerson(p);
      if (r.created) upserted++;
      out.push(personSummary(r.id, p));
    }
    ctx.logger.info("people search", { provider: descriptor.id, count: people.length, upserted });
    return {
      provider: descriptor.id,
      count: people.length,
      upserted,
      page: page.page,
      per_page: page.perPage,
      total_entries: page.totalEntries,
      people: out,
    };
  },
});

export const findCompanies = defineTool<typeof FindCompaniesInput, GrowthServices>({
  name: "find_companies",
  description:
    "Search companies with a lead provider. Filter by locations, employee_ranges, keywords. " +
    "Upserts results into the local lead store.",
  capability: "find_companies",
  // Calls the billed lead-provider API directly, so the gate needs "paid".
  tags: ["paid"],
  annotations: { openWorldHint: true },
  input: FindCompaniesInput,
  async run(input, ctx) {
    const { provider: name, ...query } = input;
    const { provider, descriptor } = await resolveProvider(ctx, name, providerHooks);
    const { companies, page } = await provider.findCompanies(query);
    let upserted = 0;
    const out = [];
    for (const c of companies) {
      const r = ctx.leads.upsertCompany(c);
      if (r.created) upserted++;
      out.push({ id: r.id, provider_id: c.id, domain: c.domain, name: c.name });
    }
    return {
      provider: descriptor.id,
      count: companies.length,
      upserted,
      page: page.page,
      per_page: page.perPage,
      total_entries: page.totalEntries,
      companies: out,
    };
  },
});

const EnrichPersonInput = z
  .object({
    provider: providerField,
    email: z.string().email().optional(),
    linkedin_url: z.string().url().optional(),
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    domain: z.string().optional(),
    reveal_personal_emails: z.boolean().optional(),
    reveal_phone_number: z.boolean().optional(),
  })
  .refine((i) => !!i.email || !!i.linkedin_url || (!!i.first_name && !!i.last_name && !!i.domain), {
    message: "Provide email, OR linkedin_url, OR first_name + last_name + domain",
  });

export const enrichPerson = defineTool<typeof EnrichPersonInput, GrowthServices>({
  name: "enrich_person",
  description:
    "Enrich one person with a lead provider. Provide email OR linkedin_url OR (first_name + last_name + " +
    "domain). Upserts into the local lead store. May consume provider credits.",
  capability: "enrich_person",
  // Calls the billed lead-provider API directly, so the gate needs "paid".
  tags: ["paid"],
  annotations: { openWorldHint: true },
  input: EnrichPersonInput,
  async run(input, ctx) {
    const { provider: name, ...lookup } = input;
    const { provider, descriptor } = await resolveProvider(ctx, name, providerHooks);
    const p = await provider.enrichPerson(lookup);
    if (!p) return { provider: descriptor.id, upserted: false, person: null };
    const r = ctx.leads.upsertPerson(p);
    return {
      provider: descriptor.id,
      upserted: r.created,
      person: {
        id: r.id,
        provider_id: p.id,
        email: p.email,
        title: p.title,
        company: p.organization?.name ?? null,
      },
    };
  },
});

const EnrichPeopleInput = z.object({
  provider: providerField,
  inputs: z.array(personLookup).min(1).max(10),
});

export const enrichPeople = defineTool<typeof EnrichPeopleInput, GrowthServices>({
  name: "enrich_people",
  description:
    "Bulk person enrichment with a lead provider. Up to 10 inputs per call. Upserts all matches. " +
    "May consume provider credits.",
  capability: "enrich_people",
  // Calls the billed lead-provider API directly, so the gate needs "paid".
  tags: ["paid"],
  annotations: { openWorldHint: true },
  input: EnrichPeopleInput,
  async run(input, ctx) {
    const { provider, descriptor } = await resolveProvider(ctx, input.provider, providerHooks);
    if (input.inputs.length > provider.maxBulk) {
      throw new Error(
        `${descriptor.id} bulk enrichment accepts at most ${provider.maxBulk} inputs`,
      );
    }
    const res = await provider.enrichPeople(input.inputs);
    let upserted = 0;
    const out = [];
    for (const p of res.people) {
      const r = ctx.leads.upsertPerson(p);
      if (r.created) upserted++;
      out.push({ id: r.id, provider_id: p.id, email: p.email });
    }
    return { provider: descriptor.id, matched: res.matched, upserted, people: out };
  },
});

const EnrichCompanyInput = z.object({
  provider: providerField,
  domain: z.string().min(3),
});

export const enrichCompany = defineTool<typeof EnrichCompanyInput, GrowthServices>({
  name: "enrich_company",
  description:
    "Enrich a company by domain with a lead provider. Upserts into the local lead store.",
  capability: "enrich_company",
  // Calls the billed lead-provider API directly, so the gate needs "paid".
  tags: ["paid"],
  annotations: { openWorldHint: true },
  input: EnrichCompanyInput,
  async run(input, ctx) {
    const { provider, descriptor } = await resolveProvider(ctx, input.provider, providerHooks);
    const c = await provider.enrichCompany(input.domain);
    if (!c) return { provider: descriptor.id, upserted: false, company: null };
    const r = ctx.leads.upsertCompany(c);
    return {
      provider: descriptor.id,
      upserted: r.created,
      company: {
        id: r.id,
        provider_id: c.id,
        domain: c.domain,
        name: c.name,
        industry: c.industry,
      },
    };
  },
});

const StatusInput = z.object({ provider: providerField });

export const leadsProviderStatus = defineTool<typeof StatusInput, GrowthServices>({
  name: "leads_provider_status",
  description:
    "Which lead providers exist and which have an API key set. For the selected provider (default: " +
    "the first configured) also checks the key and returns per-endpoint rate limits and remaining " +
    "quota. Run before pipeline_run so a stale key or exhausted plan does not fail mid-run.",
  capability: "leads_provider_status",
  annotations: { readOnlyHint: true, openWorldHint: true },
  input: StatusInput,
  async run(input, ctx) {
    const providers = await listProviders(ctx);
    const chosen = input.provider
      ? providers.find((p) => p.id === input.provider)
      : providers.find((p) => p.configured);
    if (input.provider && !chosen) {
      throw new Error(
        `unknown provider "${input.provider}" (available: ${providers.map((p) => p.id).join(", ")})`,
      );
    }
    if (!chosen?.configured) {
      return {
        ok: false,
        provider: chosen?.id ?? null,
        providers,
        note: "No lead provider has an API key set. Add one in the secrets settings.",
        endpoint_count: 0,
        endpoints: [],
        raw: null,
      };
    }
    const { provider } = await resolveProvider(ctx, chosen.id, providerHooks);
    const h = await provider.health();
    return {
      ok: h.ok,
      provider: chosen.id,
      providers,
      endpoint_count: h.endpoints.length,
      endpoints: h.endpoints,
      raw: h.raw,
    };
  },
});

export const providerTools = [
  findPeople,
  findCompanies,
  enrichPerson,
  enrichPeople,
  enrichCompany,
  leadsProviderStatus,
];
