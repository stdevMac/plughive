// packs/growth/providers/types.ts
import type { PackFetch } from "plughive/pack";
import type {
  CompanyQuery,
  LeadCompany,
  LeadPerson,
  Page,
  PeopleQuery,
  PersonLookup,
  ProviderHealth,
} from "../types.js";

/**
 * A data provider for finding and enriching people and companies. Adding one
 * means implementing this interface and listing it in providers/index.ts; the
 * tool names and inputs stay the same.
 */
export interface LeadProvider {
  readonly id: string;
  /** Largest batch accepted by enrichPeople. */
  readonly maxBulk: number;
  findPeople(q: PeopleQuery): Promise<{ people: LeadPerson[]; page: Page }>;
  findCompanies(q: CompanyQuery): Promise<{ companies: LeadCompany[]; page: Page }>;
  enrichPerson(lookup: PersonLookup): Promise<LeadPerson | null>;
  enrichPeople(lookups: PersonLookup[]): Promise<{ matched: number; people: LeadPerson[] }>;
  enrichCompany(domain: string): Promise<LeadCompany | null>;
  health(): Promise<ProviderHealth>;
}

export interface ProviderFactoryOpts {
  fetch: PackFetch;
  apiKey: string;
  /** The tool call's signal: cancels requests and retry waits. */
  signal?: AbortSignal;
  /** Test hook: first retry delay in ms (default 500). */
  retryBaseMs?: number;
}

export interface ProviderDescriptor {
  id: string;
  label: string;
  /** Manifest secret that holds this provider's API key. */
  secret: string;
  /** Capability names this provider implements (find_people, enrich_person, ...). */
  capabilities: readonly string[];
  create(opts: ProviderFactoryOpts): LeadProvider;
}
