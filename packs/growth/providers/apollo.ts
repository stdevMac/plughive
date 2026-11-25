import { type Billing, meteredRequest } from "../paid-http.js";
// packs/growth/providers/apollo.ts
//
// Apollo Data API v1 (https://docs.apollo.io). Auth: x-api-key header, JSON in
// and out. Responses are normalized into the provider-neutral lead model.
import type {
  CompanyQuery,
  LeadCompany,
  LeadPerson,
  Page,
  PeopleQuery,
  PersonLookup,
  ProviderHealth,
} from "../types.js";
import type { LeadProvider, ProviderDescriptor, ProviderFactoryOpts } from "./types.js";

const BASE = "https://api.apollo.io/api/v1";
const PROVIDER_ID = "apollo";

type Json = Record<string, unknown>;

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strList = (v: unknown): string[] | null =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;

function domainOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function toCompany(org: Json): LeadCompany | null {
  const id = str(org.id);
  if (!id) return null;
  return {
    provider: PROVIDER_ID,
    id,
    domain: str(org.primary_domain) ?? domainOf(str(org.website_url)),
    name: str(org.name),
    industry: str(org.industry),
    employeeCount: num(org.estimated_num_employees),
    annualRevenue: num(org.annual_revenue),
    location: str(org.raw_address),
    technologies: strList(org.technologies),
    raw: org,
  };
}

export function toPerson(p: Json): LeadPerson | null {
  const id = str(p.id);
  if (!id) return null;
  const org =
    p.organization && typeof p.organization === "object" ? (p.organization as Json) : null;
  return {
    provider: PROVIDER_ID,
    id,
    email: str(p.email),
    emailStatus: str(p.email_status),
    firstName: str(p.first_name),
    lastName: str(p.last_name),
    title: str(p.title),
    seniority: str(p.seniority),
    departments: strList(p.departments),
    linkedinUrl: str(p.linkedin_url),
    city: str(p.city),
    state: str(p.state),
    country: str(p.country),
    organization: org ? toCompany(org) : null,
    organizationId: str(p.organization_id),
    raw: p,
  };
}

/** Map the neutral people query onto Apollo's mixed_people/api_search payload. */
export function peopleSearchPayload(q: PeopleQuery): Json {
  const req: Json = { page: q.page, per_page: q.per_page };
  if (q.titles) req.person_titles = q.titles;
  if (q.include_similar_titles !== undefined) req.include_similar_titles = q.include_similar_titles;
  if (q.locations) req.person_locations = q.locations;
  if (q.seniorities) req.person_seniorities = q.seniorities;
  if (q.contact_email_status) req.contact_email_status = q.contact_email_status;
  if (q.keywords) req.q_keywords = q.keywords;
  if (q.organization_locations) req.organization_locations = q.organization_locations;
  if (q.organization_domains) req.q_organization_domains_list = q.organization_domains;
  if (q.organization_ids) req.organization_ids = q.organization_ids;
  if (q.employee_ranges) req.organization_num_employees_ranges = q.employee_ranges;
  if (q.revenue_min !== undefined || q.revenue_max !== undefined) {
    const range: Json = {};
    if (q.revenue_min !== undefined) range.min = q.revenue_min;
    if (q.revenue_max !== undefined) range.max = q.revenue_max;
    req.revenue_range = range;
  }
  if (q.using_technologies_all)
    req.currently_using_all_of_technology_uids = q.using_technologies_all;
  if (q.using_technologies_any)
    req.currently_using_any_of_technology_uids = q.using_technologies_any;
  if (q.not_using_technologies)
    req.currently_not_using_any_of_technology_uids = q.not_using_technologies;
  if (q.organization_job_titles) req.q_organization_job_titles = q.organization_job_titles;
  if (q.organization_job_locations) req.organization_job_locations = q.organization_job_locations;
  if (q.num_jobs_min !== undefined || q.num_jobs_max !== undefined) {
    const range: Json = {};
    if (q.num_jobs_min !== undefined) range.min = q.num_jobs_min;
    if (q.num_jobs_max !== undefined) range.max = q.num_jobs_max;
    req.organization_num_jobs_range = range;
  }
  if (q.job_posted_after !== undefined || q.job_posted_before !== undefined) {
    const range: Json = {};
    if (q.job_posted_after !== undefined) range.min = q.job_posted_after;
    if (q.job_posted_before !== undefined) range.max = q.job_posted_before;
    req.organization_job_posted_at_range = range;
  }
  return req;
}

function pageOf(resp: Json, fallback: { page: number; perPage: number; count: number }): Page {
  const pg = (resp.pagination ?? {}) as Json;
  return {
    page: num(pg.page) ?? fallback.page,
    perPage: num(pg.per_page) ?? fallback.perPage,
    totalEntries: num(pg.total_entries) ?? fallback.count,
  };
}

/**
 * Every endpoint this client calls, classified by billing. Apollo charges
 * credits for enrichment (people/match, people/bulk_match,
 * organizations/enrich) and for organization search; people api_search and
 * the usage report are free. Paid endpoints are never retried after the
 * request was sent (see paid-http.ts).
 */
export const APOLLO_BILLING = {
  "/mixed_people/api_search": "free",
  "/mixed_companies/search": "paid",
  "/people/match": "paid",
  "/people/bulk_match": "paid",
  "/organizations/enrich": "paid",
  "/usage_stats/api_usage_stats": "free",
} as const satisfies Record<string, Billing>;
type ApolloPath = keyof typeof APOLLO_BILLING;

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;

export class ApolloProvider implements LeadProvider {
  readonly id = PROVIDER_ID;
  readonly maxBulk = 10;

  constructor(private readonly opts: ProviderFactoryOpts) {}

  async findPeople(q: PeopleQuery) {
    // /mixed_people/search is deprecated in favor of /mixed_people/api_search.
    const resp = await this.post("/mixed_people/api_search", peopleSearchPayload(q));
    const raw = Array.isArray(resp.people) ? (resp.people as Json[]) : [];
    const people = raw.map(toPerson).filter((p): p is LeadPerson => p !== null);
    return {
      people,
      page: pageOf(resp, { page: q.page, perPage: q.per_page, count: raw.length }),
    };
  }

  async findCompanies(q: CompanyQuery) {
    const resp = await this.post("/mixed_companies/search", {
      organization_locations: q.locations,
      organization_num_employees_ranges: q.employee_ranges,
      q_keywords: q.keywords,
      page: q.page,
      per_page: q.per_page,
    });
    // Apollo splits hits into `accounts` (the caller's own CRM, usually empty for
    // API-only users) and `organizations` (the global DB). We want both, deduped.
    const accounts = Array.isArray(resp.accounts) ? (resp.accounts as Json[]) : [];
    const orgs = Array.isArray(resp.organizations) ? (resp.organizations as Json[]) : [];
    const seen = new Set<string>();
    const companies: LeadCompany[] = [];
    for (const raw of [...accounts, ...orgs]) {
      const c = toCompany(raw);
      if (!c || seen.has(c.id)) continue;
      seen.add(c.id);
      companies.push(c);
    }
    return {
      companies,
      page: pageOf(resp, { page: q.page, perPage: q.per_page, count: companies.length }),
    };
  }

  async enrichPerson(lookup: PersonLookup) {
    const resp = await this.post("/people/match", lookup);
    return resp.person && typeof resp.person === "object" ? toPerson(resp.person as Json) : null;
  }

  async enrichPeople(lookups: PersonLookup[]) {
    if (lookups.length > this.maxBulk) {
      throw new Error(`apollo bulk enrichment accepts at most ${this.maxBulk} inputs`);
    }
    const resp = await this.post("/people/bulk_match", { details: lookups });
    const matches = Array.isArray(resp.matches) ? (resp.matches as unknown[]) : [];
    const people: LeadPerson[] = [];
    for (const m of matches) {
      const p = m && typeof m === "object" ? toPerson(m as Json) : null;
      if (p) people.push(p);
    }
    return { matched: matches.length, people };
  }

  async enrichCompany(domain: string) {
    const resp = await this.post("/organizations/enrich", { domain });
    const org = resp.organization;
    return org && typeof org === "object" ? toCompany(org as Json) : null;
  }

  async health(): Promise<ProviderHealth> {
    const resp = await this.post("/usage_stats/api_usage_stats", {});
    // A flat object: each key is a stringified JSON array like '["api/v1/people/match","match"]'
    // and each value has day/hour/minute blocks with limit/consumed/left_over.
    const endpoints: ProviderHealth["endpoints"] = [];
    for (const [rawKey, value] of Object.entries(resp)) {
      if (!value || typeof value !== "object") continue;
      const v = value as { day?: Json; hour?: Json; minute?: Json };
      if (!v.day || !v.hour || !v.minute) continue;
      let endpoint = rawKey;
      try {
        const parsed: unknown = JSON.parse(rawKey);
        if (Array.isArray(parsed) && parsed.length > 0) {
          endpoint = parsed.length >= 2 ? `${parsed[0]} (${parsed[1]})` : String(parsed[0]);
        }
      } catch {
        // keep the raw key
      }
      endpoints.push({
        endpoint,
        rate_limit_minute: num(v.minute.limit),
        rate_limit_hour: num(v.hour.limit),
        rate_limit_day: num(v.day.limit),
        consumed_minute: num(v.minute.consumed),
        consumed_hour: num(v.hour.consumed),
        consumed_day: num(v.day.consumed),
        remaining_minute: num(v.minute.left_over),
        remaining_hour: num(v.hour.left_over),
        remaining_day: num(v.day.left_over),
      });
    }
    // Lowest remaining daily quota first, so a nearly exhausted endpoint surfaces.
    endpoints.sort(
      (a, b) =>
        (a.remaining_day ?? Number.POSITIVE_INFINITY) -
        (b.remaining_day ?? Number.POSITIVE_INFINITY),
    );
    return { ok: true, endpoints, raw: resp };
  }

  private async post(path: ApolloPath, body: unknown): Promise<Json> {
    const res = await meteredRequest({
      fetch: this.opts.fetch,
      url: BASE + path,
      method: "POST",
      headers: {
        "x-api-key": this.opts.apiKey,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(body),
      billing: APOLLO_BILLING[path],
      label: "Apollo",
      endpoint: path,
      ...(this.opts.signal ? { signal: this.opts.signal } : {}),
      timeoutMs: REQUEST_TIMEOUT_MS,
      maxBytes: MAX_RESPONSE_BYTES,
      ...(this.opts.retryBaseMs !== undefined ? { retryBaseMs: this.opts.retryBaseMs } : {}),
    });
    try {
      const parsed: unknown = JSON.parse(res.text);
      return parsed && typeof parsed === "object" ? (parsed as Json) : {};
    } catch {
      throw new Error(`Apollo ${path} returned a response that is not JSON`);
    }
  }
}

export const apolloDescriptor: ProviderDescriptor = {
  id: PROVIDER_ID,
  label: "Apollo",
  secret: "APOLLO_API_KEY",
  capabilities: [
    "find_people",
    "find_companies",
    "enrich_person",
    "enrich_people",
    "enrich_company",
  ],
  create: (opts) => new ApolloProvider(opts),
};
