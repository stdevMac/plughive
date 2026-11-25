import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SenderStore } from "../../../packs/growth/sender.js";
import { LeadsStore } from "../../../packs/growth/store.js";
import type { LeadCompany, LeadPerson } from "../../../packs/growth/types.js";
import { expectMode } from "../../support/platform.js";
import { type Env, makeEnv } from "./helpers.js";

let env: Env;
afterEach(() => env?.cleanup());

describe("SenderStore", () => {
  it("keeps sender.json owner-only, including a file an older version wrote 0644 (L8)", () => {
    const dir = mkdtempSync(join(tmpdir(), "growth-sender-"));
    try {
      const path = join(dir, "sender.json");
      const store = new SenderStore({ root: dir });
      store.set({ name: "A", email: "a@example.test", pitch: "p" });
      expectMode(path, 0o600);
      writeFileSync(path, "{}");
      chmodSync(path, 0o644);
      store.set({ name: "B", email: "b@example.test", pitch: "p" });
      expectMode(path, 0o600);
      expect(store.get()?.name).toBe("B");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("LeadsStore file permissions", () => {
  it("keeps growth.db owner-only (0600), fresh or pre-existing 0644", () => {
    const dir = mkdtempSync(join(tmpdir(), "growth-db-"));
    try {
      // A fresh database is created owner-only.
      const fresh = new LeadsStore({ root: dir });
      expectMode(join(dir, "growth.db"), 0o600);
      fresh.close();
      // A file left loose (hand edit, older version) is tightened on open.
      chmodSync(join(dir, "growth.db"), 0o644);
      const reopened = new LeadsStore({ root: dir });
      expectMode(join(dir, "growth.db"), 0o600);
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

const company = (id: string, over: Partial<LeadCompany> = {}): LeadCompany => ({
  provider: "apollo",
  id,
  domain: `${id}.test`,
  name: `Name ${id}`,
  industry: "software",
  employeeCount: 20,
  annualRevenue: null,
  location: "Berlin, Germany",
  technologies: ["react"],
  raw: { id },
  ...over,
});

const person = (
  id: string,
  org: LeadCompany | null,
  over: Partial<LeadPerson> = {},
): LeadPerson => ({
  provider: "apollo",
  id,
  email: `${id}@x.test`,
  emailStatus: "verified",
  firstName: "F",
  lastName: id,
  title: "CTO",
  seniority: "c_suite",
  departments: null,
  linkedinUrl: null,
  city: null,
  state: null,
  country: null,
  organization: org,
  organizationId: org?.id ?? null,
  raw: {},
  ...over,
});

describe("LeadsStore", () => {
  it("dedups on (provider, provider_id) and does not collide across providers", () => {
    env = makeEnv();
    const s = env.ctx.leads;
    const a = s.upsertCompany(company("c1"));
    const b = s.upsertCompany(company("c1", { name: "Renamed" }));
    expect(a.created).toBe(true);
    expect(b).toEqual({ id: a.id, created: false });
    expect(s.getCompany(a.id)!.name).toBe("Renamed");
    const other = s.upsertCompany(company("c1", { provider: "other" }));
    expect(other.id).not.toBe(a.id);
    expect(a.id).toMatch(/^co_/);
    expect(s.getCompanyByProviderId("apollo", "c1")!.id).toBe(a.id);
  });

  it("keeps fit score, contact status and research when a person is re-upserted", () => {
    env = makeEnv();
    const s = env.ctx.leads;
    const org = company("c1");
    const p = s.upsertPerson(person("p1", org));
    expect(p.id).toMatch(/^pe_/);
    s.setFitScore(p.id, 70, "ok");
    s.markContacted(p.id, "sent", "art1");
    s.upsertPerson(person("p1", org, { title: "CEO" }));
    const row = s.getPerson(p.id)!;
    expect(row).toMatchObject({
      title: "CEO",
      fit_score: 70,
      contact_status: "sent",
      last_contact_artifact_id: "art1",
    });
    expect(s.getPersonByProviderId("apollo", "p1")!.id).toBe(p.id);
  });

  it("filters people", () => {
    env = makeEnv();
    const s = env.ctx.leads;
    const big = company("big", { employeeCount: 500, industry: "finance" });
    const small = company("small");
    const p1 = s.upsertPerson(person("p1", big, { title: "VP Sales", seniority: "vp" }));
    s.upsertPerson(person("p2", small, { email: null }));
    s.setFitScore(p1.id, 85, "r");
    expect(s.query({}).total).toBe(2);
    expect(s.query({ title_contains: "sales" }).people).toHaveLength(1);
    expect(s.query({ seniority_in: ["vp"] }).people).toHaveLength(1);
    expect(s.query({ industry_contains: "fin" }).people).toHaveLength(1);
    expect(s.query({ employee_min: 100 }).people).toHaveLength(1);
    expect(s.query({ employee_max: 100 }).people[0]!.company!.domain).toBe("small.test");
    expect(s.query({ fit_score_min: 80 }).people).toHaveLength(1);
    expect(s.query({ has_email: true }).people).toHaveLength(1);
    expect(s.query({ has_email: false }).people).toHaveLength(1);
    s.markContacted(p1.id, "drafted");
    expect(s.query({ exclude_contact_status: ["drafted"] }).people).toHaveLength(1);
    expect(s.query({ contact_status_in: ["drafted"] }).people).toHaveLength(1);
    expect(s.query({ limit: 1, offset: 1 }).people).toHaveLength(1);
    expect(s.query({ since: Date.now() + 100000 }).total).toBe(0);
  });

  it("filters companies including research brief presence", () => {
    env = makeEnv();
    const s = env.ctx.leads;
    const a = s.upsertCompany(company("a"));
    s.upsertCompany(company("b", { industry: "retail", employeeCount: 900 }));
    s.setResearchArtifact(a.id, "art1");
    expect(s.queryCompanies({ has_research_brief: true }).companies).toHaveLength(1);
    expect(s.queryCompanies({ has_research_brief: false }).companies).toHaveLength(1);
    expect(s.queryCompanies({ industry_contains: "ret" }).companies[0]!.provider_id).toBe("b");
    expect(s.queryCompanies({ name_contains: "Name a" }).total).toBe(1);
    expect(s.queryCompanies({ employee_min: 500 }).total).toBe(1);
    expect(s.queryCompanies({ location_contains: "berlin" }).total).toBe(2);
  });
});

describe("query_leads and query_companies tools", () => {
  it("return provider fields and parsed technologies", async () => {
    env = makeEnv();
    env.ctx.leads.upsertPerson(person("p1", company("c1")));
    const leads = await env.call("query_leads", { title_contains: "cto" });
    expect(leads).toMatchObject({ total: 1, count: 1 });
    expect(leads.people[0]).toMatchObject({
      provider: "apollo",
      provider_id: "p1",
      company: { domain: "c1.test" },
    });
    const cos = await env.call("query_companies", { domain_contains: "c1" });
    expect(cos.companies[0]).toMatchObject({
      provider: "apollo",
      provider_id: "c1",
      technologies: ["react"],
    });
  });
});
