// packs/growth/types.ts
//
// Provider-neutral lead model. Providers (Apollo today) normalize their
// responses into these shapes; the local store and every tool work on them.

export const CONTACT_STATUSES = [
  "new",
  "drafted",
  "sent",
  "replied",
  "won",
  "lost",
  "skipped",
] as const;

export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export interface LeadCompany {
  provider: string;
  /** The provider's own id; the dedup key together with `provider`. */
  id: string;
  domain: string | null;
  name: string | null;
  industry: string | null;
  employeeCount: number | null;
  annualRevenue: number | null;
  location: string | null;
  technologies: string[] | null;
  raw: unknown;
}

export interface LeadPerson {
  provider: string;
  id: string;
  email: string | null;
  emailStatus: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  seniority: string | null;
  departments: string[] | null;
  linkedinUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  organization: LeadCompany | null;
  organizationId: string | null;
  raw: unknown;
}

/** People search. Providers apply the filters they support and ignore the rest. */
export interface PeopleQuery {
  titles?: string[];
  include_similar_titles?: boolean;
  locations?: string[];
  seniorities?: string[];
  contact_email_status?: string[];
  keywords?: string;
  organization_locations?: string[];
  organization_domains?: string[];
  organization_ids?: string[];
  employee_ranges?: string[];
  revenue_min?: number;
  revenue_max?: number;
  using_technologies_all?: string[];
  using_technologies_any?: string[];
  not_using_technologies?: string[];
  organization_job_titles?: string[];
  organization_job_locations?: string[];
  num_jobs_min?: number;
  num_jobs_max?: number;
  job_posted_after?: string;
  job_posted_before?: string;
  page: number;
  per_page: number;
}

export interface CompanyQuery {
  locations?: string[];
  employee_ranges?: string[];
  keywords?: string;
  page: number;
  per_page: number;
}

export interface PersonLookup {
  email?: string;
  linkedin_url?: string;
  first_name?: string;
  last_name?: string;
  domain?: string;
  reveal_personal_emails?: boolean;
  reveal_phone_number?: boolean;
}

export interface Page {
  page: number;
  perPage: number;
  totalEntries: number;
}

export interface ProviderHealth {
  ok: boolean;
  endpoints: Array<{
    endpoint: string;
    rate_limit_minute: number | null;
    rate_limit_hour: number | null;
    rate_limit_day: number | null;
    consumed_minute: number | null;
    consumed_hour: number | null;
    consumed_day: number | null;
    remaining_minute: number | null;
    remaining_hour: number | null;
    remaining_day: number | null;
  }>;
  raw: unknown;
}
