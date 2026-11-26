// packs/growth/store.ts
//
// Local lead store: a SQLite file in the pack's dataDir. Rows are keyed by
// (provider, provider_id) so a second provider never collides with the first.
// Uses node:sqlite with one prepared statement per call.
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type * as Sqlite from "node:sqlite";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { ContactStatus, LeadCompany, LeadPerson } from "./types.js";

// Loaded through require so bundlers and test transformers that do not know
// the node:sqlite builtin leave it alone.
const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as typeof Sqlite;
type DatabaseSync = DatabaseSyncType;

export interface CompanyRow {
  id: string;
  provider: string;
  provider_id: string;
  domain: string | null;
  name: string | null;
  industry: string | null;
  employee_count: number | null;
  annual_revenue: number | null;
  location: string | null;
  technologies_json: string | null;
  research_artifact_id: string | null;
  raw_json: string;
  first_seen_at: number;
  last_seen_at: number;
}

export interface PersonRow {
  id: string;
  provider: string;
  provider_id: string;
  email: string | null;
  email_status: string | null;
  first_name: string | null;
  last_name: string | null;
  title: string | null;
  seniority: string | null;
  departments_json: string | null;
  linkedin_url: string | null;
  company_id: string | null;
  fit_score: number | null;
  fit_reasoning: string | null;
  fit_scored_at: number | null;
  contact_status: ContactStatus | null;
  last_contacted_at: number | null;
  last_contact_artifact_id: string | null;
  raw_json: string;
  first_seen_at: number;
  last_seen_at: number;
}

export interface LeadFilter {
  title_contains?: string;
  seniority_in?: string[];
  industry_contains?: string;
  location_contains?: string;
  domain_contains?: string;
  email_status_in?: string[];
  employee_min?: number;
  employee_max?: number;
  fit_score_min?: number;
  since?: number;
  has_email?: boolean;
  contact_status_in?: ContactStatus[];
  /** Exclude people whose contact_status is in this list. Prevents re-drafting. */
  exclude_contact_status?: ContactStatus[];
  limit?: number;
  offset?: number;
}

export interface QueryResult {
  people: (PersonRow & { company: CompanyRow | null })[];
  total: number;
}

export interface CompanyFilter {
  domain_contains?: string;
  industry_contains?: string;
  location_contains?: string;
  name_contains?: string;
  employee_min?: number;
  employee_max?: number;
  has_research_brief?: boolean;
  since?: number;
  limit?: number;
  offset?: number;
}

export interface CompanyQueryResult {
  companies: CompanyRow[];
  total: number;
}

const SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS companies (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    domain TEXT,
    name TEXT,
    industry TEXT,
    employee_count INTEGER,
    annual_revenue INTEGER,
    location TEXT,
    technologies_json TEXT,
    research_artifact_id TEXT,
    raw_json TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    UNIQUE(provider, provider_id)
  )`,
  "CREATE INDEX IF NOT EXISTS companies_domain ON companies(domain)",
  `CREATE TABLE IF NOT EXISTS people (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    email TEXT,
    email_status TEXT,
    first_name TEXT,
    last_name TEXT,
    title TEXT,
    seniority TEXT,
    departments_json TEXT,
    linkedin_url TEXT,
    company_id TEXT REFERENCES companies(id),
    fit_score INTEGER,
    fit_reasoning TEXT,
    fit_scored_at INTEGER,
    contact_status TEXT,
    last_contacted_at INTEGER,
    last_contact_artifact_id TEXT,
    raw_json TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    UNIQUE(provider, provider_id)
  )`,
  "CREATE INDEX IF NOT EXISTS people_email ON people(email)",
  "CREATE INDEX IF NOT EXISTS people_company ON people(company_id)",
  "CREATE INDEX IF NOT EXISTS people_seniority ON people(seniority)",
  "CREATE INDEX IF NOT EXISTS people_fit_score ON people(fit_score)",
  "CREATE INDEX IF NOT EXISTS people_contact_status ON people(contact_status)",
];

let lastTs = 0;
let seq = 0;
/** Sortable, process-monotonic id: time in base36 plus a per-ms counter and a random tail. */
function newId(prefix: string): string {
  const now = Date.now();
  if (now === lastTs) seq += 1;
  else {
    lastTs = now;
    seq = 0;
  }
  const rand = Math.floor(Math.random() * 36 ** 4)
    .toString(36)
    .padStart(4, "0");
  return `${prefix}_${now.toString(36).padStart(9, "0")}${seq.toString(36).padStart(3, "0")}${rand}`;
}

type SqlValue = string | number | null;

export class LeadsStore {
  private db: DatabaseSync;

  constructor(opts: { root: string }) {
    mkdirSync(opts.root, { recursive: true });
    const path = join(opts.root, "growth.db");
    this.db = new DatabaseSync(path);
    // Leads are personal data: keep the database owner-only, like the other
    // stores (a fresh file starts group/world-readable until this runs).
    if ((statSync(path).mode & 0o077) !== 0) chmodSync(path, 0o600);
    this.db.prepare("PRAGMA journal_mode = WAL").run();
    this.db.prepare("PRAGMA foreign_keys = ON").run();
    for (const stmt of SCHEMA_SQL) this.db.prepare(stmt).run();
  }

  upsertCompany(c: LeadCompany): { id: string; created: boolean } {
    const now = Date.now();
    const existing = this.getCompanyByProviderId(c.provider, c.id);
    const techJson = c.technologies ? JSON.stringify(c.technologies) : null;
    const rawJson = JSON.stringify(c.raw ?? {});
    if (existing) {
      this.db
        .prepare(
          `UPDATE companies
           SET domain = ?, name = ?, industry = ?, employee_count = ?, annual_revenue = ?,
               location = ?, technologies_json = ?, raw_json = ?, last_seen_at = ?
           WHERE id = ?`,
        )
        .run(
          c.domain,
          c.name,
          c.industry,
          c.employeeCount,
          c.annualRevenue,
          c.location,
          techJson,
          rawJson,
          now,
          existing.id,
        );
      return { id: existing.id, created: false };
    }
    const id = newId("co");
    this.db
      .prepare(
        `INSERT INTO companies(id, provider, provider_id, domain, name, industry, employee_count,
                               annual_revenue, location, technologies_json, research_artifact_id,
                               raw_json, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        c.provider,
        c.id,
        c.domain,
        c.name,
        c.industry,
        c.employeeCount,
        c.annualRevenue,
        c.location,
        techJson,
        rawJson,
        now,
        now,
      );
    return { id, created: true };
  }

  getCompanyByProviderId(provider: string, providerId: string): CompanyRow | null {
    const r = this.db
      .prepare("SELECT * FROM companies WHERE provider = ? AND provider_id = ?")
      .get(provider, providerId);
    return r ? ({ ...r } as unknown as CompanyRow) : null;
  }

  getCompany(id: string): CompanyRow | null {
    const r = this.db.prepare("SELECT * FROM companies WHERE id = ?").get(id);
    return r ? ({ ...r } as unknown as CompanyRow) : null;
  }

  upsertPerson(p: LeadPerson): { id: string; created: boolean } {
    let companyId: string | null = null;
    if (p.organization) {
      companyId = this.upsertCompany(p.organization).id;
    } else if (p.organizationId) {
      companyId = this.getCompanyByProviderId(p.provider, p.organizationId)?.id ?? null;
    }
    const now = Date.now();
    const existing = this.getPersonByProviderId(p.provider, p.id);
    const deptJson = p.departments ? JSON.stringify(p.departments) : null;
    const rawJson = JSON.stringify(p.raw ?? {});
    if (existing) {
      this.db
        .prepare(
          `UPDATE people
           SET email = ?, email_status = ?, first_name = ?, last_name = ?, title = ?, seniority = ?,
               departments_json = ?, linkedin_url = ?, company_id = COALESCE(?, company_id),
               raw_json = ?, last_seen_at = ?
           WHERE id = ?`,
        )
        .run(
          p.email,
          p.emailStatus,
          p.firstName,
          p.lastName,
          p.title,
          p.seniority,
          deptJson,
          p.linkedinUrl,
          companyId,
          rawJson,
          now,
          existing.id,
        );
      return { id: existing.id, created: false };
    }
    const id = newId("pe");
    this.db
      .prepare(
        `INSERT INTO people(id, provider, provider_id, email, email_status, first_name, last_name,
                            title, seniority, departments_json, linkedin_url, company_id,
                            fit_score, fit_reasoning, fit_scored_at, raw_json, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
      )
      .run(
        id,
        p.provider,
        p.id,
        p.email,
        p.emailStatus,
        p.firstName,
        p.lastName,
        p.title,
        p.seniority,
        deptJson,
        p.linkedinUrl,
        companyId,
        rawJson,
        now,
        now,
      );
    return { id, created: true };
  }

  getPersonByProviderId(provider: string, providerId: string): PersonRow | null {
    const r = this.db
      .prepare("SELECT * FROM people WHERE provider = ? AND provider_id = ?")
      .get(provider, providerId);
    return r ? ({ ...r } as unknown as PersonRow) : null;
  }

  getPerson(id: string): PersonRow | null {
    const r = this.db.prepare("SELECT * FROM people WHERE id = ?").get(id);
    return r ? ({ ...r } as unknown as PersonRow) : null;
  }

  setFitScore(personId: string, score: number, reasoning: string): void {
    this.db
      .prepare("UPDATE people SET fit_score = ?, fit_reasoning = ?, fit_scored_at = ? WHERE id = ?")
      .run(Math.round(score), reasoning, Date.now(), personId);
  }

  setResearchArtifact(companyId: string, artifactId: string): void {
    this.db
      .prepare("UPDATE companies SET research_artifact_id = ? WHERE id = ?")
      .run(artifactId, companyId);
  }

  markContacted(personId: string, status: ContactStatus, artifactId?: string): void {
    this.db
      .prepare(
        `UPDATE people
         SET contact_status = ?,
             last_contacted_at = ?,
             last_contact_artifact_id = COALESCE(?, last_contact_artifact_id)
         WHERE id = ?`,
      )
      .run(status, Date.now(), artifactId ?? null, personId);
  }

  /**
   * Record a new draft without undoing progress: a person already marked sent,
   * replied, won, lost or skipped keeps that status.
   */
  markDrafted(personId: string, artifactId: string): void {
    this.db
      .prepare(
        `UPDATE people
         SET contact_status = 'drafted',
             last_contacted_at = ?,
             last_contact_artifact_id = ?
         WHERE id = ? AND (contact_status IS NULL OR contact_status IN ('new', 'drafted'))`,
      )
      .run(Date.now(), artifactId, personId);
  }

  /**
   * The opt-out status (skipped or lost) of this person or of any other lead
   * row with the same email, compared trimmed and case-insensitively. The same
   * person found through two providers is two rows; marking one counts for both.
   */
  suppressedStatus(personId: string): ContactStatus | null {
    const r = this.db
      .prepare(
        `SELECT o.contact_status AS s FROM people p JOIN people o
           ON o.id = p.id
           OR (p.email IS NOT NULL AND TRIM(p.email) != ''
               AND LOWER(TRIM(o.email)) = LOWER(TRIM(p.email)))
         WHERE p.id = ? AND o.contact_status IN ('skipped', 'lost')
         LIMIT 1`,
      )
      .get(personId) as { s: ContactStatus } | undefined;
    return r?.s ?? null;
  }

  query(filter: LeadFilter = {}): QueryResult {
    const clauses: string[] = [];
    const params: SqlValue[] = [];
    const inList = (col: string, vals: readonly string[]) => {
      clauses.push(`${col} IN (${vals.map(() => "?").join(",")})`);
      params.push(...vals);
    };

    if (filter.title_contains) {
      clauses.push("LOWER(p.title) LIKE LOWER(?)");
      params.push(`%${filter.title_contains}%`);
    }
    if (filter.seniority_in?.length) inList("p.seniority", filter.seniority_in);
    if (filter.industry_contains) {
      clauses.push("LOWER(c.industry) LIKE LOWER(?)");
      params.push(`%${filter.industry_contains}%`);
    }
    if (filter.location_contains) {
      clauses.push("LOWER(c.location) LIKE LOWER(?)");
      params.push(`%${filter.location_contains}%`);
    }
    if (filter.domain_contains) {
      clauses.push("LOWER(c.domain) LIKE LOWER(?)");
      params.push(`%${filter.domain_contains}%`);
    }
    if (filter.email_status_in?.length) inList("p.email_status", filter.email_status_in);
    if (filter.employee_min !== undefined) {
      clauses.push("c.employee_count >= ?");
      params.push(filter.employee_min);
    }
    if (filter.employee_max !== undefined) {
      clauses.push("c.employee_count <= ?");
      params.push(filter.employee_max);
    }
    if (filter.fit_score_min !== undefined) {
      clauses.push("p.fit_score >= ?");
      params.push(filter.fit_score_min);
    }
    if (filter.since !== undefined) {
      clauses.push("p.last_seen_at >= ?");
      params.push(filter.since);
    }
    if (filter.has_email === true) clauses.push("p.email IS NOT NULL AND p.email != ''");
    if (filter.has_email === false) clauses.push("(p.email IS NULL OR p.email = '')");
    if (filter.contact_status_in?.length) inList("p.contact_status", filter.contact_status_in);
    if (filter.exclude_contact_status?.length) {
      const placeholders = filter.exclude_contact_status.map(() => "?").join(",");
      clauses.push(`(p.contact_status IS NULL OR p.contact_status NOT IN (${placeholders}))`);
      params.push(...filter.exclude_contact_status);
    }

    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";

    const totalRow = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM people p LEFT JOIN companies c ON c.id = p.company_id${where}`,
      )
      .get(...params) as unknown as { n: number };

    const limit = Math.min(Math.max(1, filter.limit ?? 100), 1000);
    const offset = Math.max(0, filter.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT p.*, c.id AS c_id, c.provider AS c_provider, c.provider_id AS c_provider_id,
                c.domain AS c_domain, c.name AS c_name, c.industry AS c_industry,
                c.employee_count AS c_employee_count, c.annual_revenue AS c_annual_revenue,
                c.location AS c_location, c.technologies_json AS c_technologies_json,
                c.research_artifact_id AS c_research_artifact_id, c.raw_json AS c_raw_json,
                c.first_seen_at AS c_first_seen_at, c.last_seen_at AS c_last_seen_at
         FROM people p LEFT JOIN companies c ON c.id = p.company_id${where}
         ORDER BY p.last_seen_at DESC, p.id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as Array<
      // biome-ignore lint/suspicious/noExplicitAny: joined people + company columns, mapped field by field below
      Record<string, any>
    >;

    const people = rows.map((r) => {
      const company: CompanyRow | null = r.c_id
        ? {
            id: r.c_id,
            provider: r.c_provider,
            provider_id: r.c_provider_id,
            domain: r.c_domain,
            name: r.c_name,
            industry: r.c_industry,
            employee_count: r.c_employee_count,
            annual_revenue: r.c_annual_revenue,
            location: r.c_location,
            technologies_json: r.c_technologies_json,
            research_artifact_id: r.c_research_artifact_id,
            raw_json: r.c_raw_json,
            first_seen_at: r.c_first_seen_at,
            last_seen_at: r.c_last_seen_at,
          }
        : null;
      const person: PersonRow = {
        id: r.id,
        provider: r.provider,
        provider_id: r.provider_id,
        email: r.email,
        email_status: r.email_status,
        first_name: r.first_name,
        last_name: r.last_name,
        title: r.title,
        seniority: r.seniority,
        departments_json: r.departments_json,
        linkedin_url: r.linkedin_url,
        company_id: r.company_id,
        fit_score: r.fit_score,
        fit_reasoning: r.fit_reasoning,
        fit_scored_at: r.fit_scored_at,
        contact_status: (r.contact_status as ContactStatus | null) ?? null,
        last_contacted_at: r.last_contacted_at ?? null,
        last_contact_artifact_id: r.last_contact_artifact_id ?? null,
        raw_json: r.raw_json,
        first_seen_at: r.first_seen_at,
        last_seen_at: r.last_seen_at,
      };
      return { ...person, company };
    });

    return { people, total: totalRow.n };
  }

  queryCompanies(filter: CompanyFilter = {}): CompanyQueryResult {
    const clauses: string[] = [];
    const params: SqlValue[] = [];

    if (filter.domain_contains) {
      clauses.push("LOWER(domain) LIKE LOWER(?)");
      params.push(`%${filter.domain_contains}%`);
    }
    if (filter.industry_contains) {
      clauses.push("LOWER(industry) LIKE LOWER(?)");
      params.push(`%${filter.industry_contains}%`);
    }
    if (filter.location_contains) {
      clauses.push("LOWER(location) LIKE LOWER(?)");
      params.push(`%${filter.location_contains}%`);
    }
    if (filter.name_contains) {
      clauses.push("LOWER(name) LIKE LOWER(?)");
      params.push(`%${filter.name_contains}%`);
    }
    if (filter.employee_min !== undefined) {
      clauses.push("employee_count >= ?");
      params.push(filter.employee_min);
    }
    if (filter.employee_max !== undefined) {
      clauses.push("employee_count <= ?");
      params.push(filter.employee_max);
    }
    if (filter.has_research_brief === true) clauses.push("research_artifact_id IS NOT NULL");
    if (filter.has_research_brief === false) clauses.push("research_artifact_id IS NULL");
    if (filter.since !== undefined) {
      clauses.push("last_seen_at >= ?");
      params.push(filter.since);
    }

    const where = clauses.length ? ` WHERE ${clauses.join(" AND ")}` : "";
    const totalRow = this.db
      .prepare(`SELECT COUNT(*) AS n FROM companies${where}`)
      .get(...params) as unknown as { n: number };

    const limit = Math.min(Math.max(1, filter.limit ?? 100), 1000);
    const offset = Math.max(0, filter.offset ?? 0);
    const rows = this.db
      .prepare(
        `SELECT * FROM companies${where} ORDER BY last_seen_at DESC, id DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as CompanyRow[];

    return { companies: rows.map((r) => ({ ...r })), total: totalRow.n };
  }

  close(): void {
    this.db.close();
  }
}
