import { afterEach, describe, expect, it } from "vitest";
import { type Env, apolloPerson, makeEnv, tool } from "./helpers.js";

let env: Env;
afterEach(() => env?.cleanup());

const bodyOf = (env: Env, i = 0) => JSON.parse(String((env.fetch.mock.calls[i] as any)[1].body));
const headersOf = (env: Env, i = 0) => (env.fetch.mock.calls[i] as any)[1].headers;

describe("find_people", () => {
  it("maps filters to Apollo params, upserts people and companies, and sends the key", async () => {
    env = makeEnv({
      handler: () => ({
        json: {
          people: [apolloPerson("p1"), apolloPerson("p2")],
          pagination: { page: 1, per_page: 25, total_entries: 2 },
        },
      }),
    });
    const out = await env.call("find_people", {
      titles: ["CTO"],
      include_similar_titles: false,
      locations: ["Berlin"],
      seniorities: ["c_suite"],
      contact_email_status: ["verified"],
      keywords: "saas",
      organization_locations: ["Germany"],
      organization_domains: ["acme.test"],
      organization_ids: ["org1"],
      employee_ranges: ["11,50"],
      revenue_min: 10,
      revenue_max: 20,
      using_technologies_all: ["a"],
      using_technologies_any: ["b"],
      not_using_technologies: ["c"],
      organization_job_titles: ["Engineer"],
      organization_job_locations: ["Remote"],
      num_jobs_min: 1,
      num_jobs_max: 9,
      job_posted_after: "2025-01-01",
      job_posted_before: "2025-02-01",
    });
    expect(out).toMatchObject({ provider: "apollo", count: 2, upserted: 2, total_entries: 2 });
    expect(out.people[0]).toMatchObject({
      provider_id: "p1",
      company: "Acme",
      company_domain: "acme.test",
      title: "CTO",
    });
    const [url] = env.fetch.mock.calls[0] as any;
    expect(url).toBe("https://api.apollo.io/api/v1/mixed_people/api_search");
    expect(headersOf(env)["x-api-key"]).toBe("test-key");
    expect(bodyOf(env)).toEqual({
      page: 1,
      per_page: 25,
      person_titles: ["CTO"],
      include_similar_titles: false,
      person_locations: ["Berlin"],
      person_seniorities: ["c_suite"],
      contact_email_status: ["verified"],
      q_keywords: "saas",
      organization_locations: ["Germany"],
      q_organization_domains_list: ["acme.test"],
      organization_ids: ["org1"],
      organization_num_employees_ranges: ["11,50"],
      revenue_range: { min: 10, max: 20 },
      currently_using_all_of_technology_uids: ["a"],
      currently_using_any_of_technology_uids: ["b"],
      currently_not_using_any_of_technology_uids: ["c"],
      q_organization_job_titles: ["Engineer"],
      organization_job_locations: ["Remote"],
      organization_num_jobs_range: { min: 1, max: 9 },
      organization_job_posted_at_range: { min: "2025-01-01", max: "2025-02-01" },
    });
    expect(env.ctx.leads.query({}).total).toBe(2);
    expect(env.ctx.leads.queryCompanies({}).total).toBe(1);
    const again = await env.call("find_people", {});
    expect(again.upserted).toBe(0);
  });

  it("omits range objects when no bound is given", async () => {
    env = makeEnv({ handler: () => ({ json: { people: [] } }) });
    await env.call("find_people", { titles: ["CEO"] });
    const b = bodyOf(env);
    expect(b.revenue_range).toBeUndefined();
    expect(b.organization_num_jobs_range).toBeUndefined();
    expect(b.organization_job_posted_at_range).toBeUndefined();
  });

  it("fails with a missing-secret error when no key is set", async () => {
    env = makeEnv({ key: false });
    await expect(env.call("find_people", {})).rejects.toMatchObject({ code: "MISSING_SECRET" });
    expect(env.fetch).not.toHaveBeenCalled();
  });

  it("rejects an unknown provider", async () => {
    env = makeEnv();
    await expect(env.call("find_people", { provider: "nope" })).rejects.toThrow(/unknown provider/);
  });

  it("free people search: retries 429 and 5xx with backoff, gives up after three", async () => {
    let n = 0;
    env = makeEnv({
      handler: () => (++n < 3 ? { status: 429, json: { e: 1 } } : { json: { people: [] } }),
    });
    const out = await env.call("find_people", {});
    expect(out.count).toBe(0);
    expect(env.fetch).toHaveBeenCalledTimes(3);
    env.cleanup();
    env = makeEnv({ handler: () => ({ status: 500, json: { e: 1 } }) });
    await expect(env.call("find_people", {})).rejects.toThrow(
      /Apollo \/mixed_people\/api_search returned 500/,
    );
    expect(env.fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry a 401", async () => {
    env = makeEnv({ handler: () => ({ status: 401, json: { error: "bad key" } }) });
    await expect(env.call("find_people", {})).rejects.toThrow(/returned 401: bad key/);
    expect(env.fetch).toHaveBeenCalledTimes(1);
  });

  it("passes the call's signal and a timeout to every request", async () => {
    env = makeEnv({ handler: () => ({ json: { people: [] } }) });
    const ac = new AbortController();
    (env.ctx as any).signal = ac.signal;
    await env.call("find_people", {});
    const init = (env.fetch.mock.calls[0] as any)[1];
    expect(init.signal).toBe(ac.signal);
    expect(init.timeoutMs).toBe(30_000);
  });

  it("never echoes the raw upstream body in an error", async () => {
    env = makeEnv({
      handler: () => ({ status: 400, json: { person: { email: "secret@pii.test" }, e: 1 } }),
    });
    const err = await env.call("enrich_person", { email: "x@y.test" }).catch((e) => e);
    expect(String(err.message)).not.toContain("secret@pii.test");
  });
});

describe("credit-consuming Apollo calls are not retried after send", () => {
  it("a paid 5xx fails after one attempt, with a may-have-charged note", async () => {
    env = makeEnv({ handler: () => ({ status: 502, json: { error: "bad gateway" } }) });
    const err = await env.call("enrich_person", { email: "a@b.test" }).catch((e) => e);
    expect(env.fetch).toHaveBeenCalledTimes(1);
    expect(err.message).toMatch(/\/people\/match returned 502/);
    expect(err.message).toMatch(/may already have been processed and charged/);
  });

  it("a paid timeout after send is not retried", async () => {
    const t = Object.assign(new Error("The operation timed out"), { name: "TimeoutError" });
    env = makeEnv({ handler: () => ({ throws: t }) });
    const err = await env.call("enrich_company", { domain: "acme.test" }).catch((e) => e);
    expect(env.fetch).toHaveBeenCalledTimes(1);
    expect(err.message).toMatch(/failed after the request was sent/);
  });

  it("a paid call is retried once on a connection refused before dispatch", async () => {
    let n = 0;
    const refused = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
    });
    env = makeEnv({
      handler: () =>
        ++n === 1
          ? { throws: refused }
          : { json: { organization: { id: "o1", name: "Acme", primary_domain: "acme.test" } } },
    });
    await env.call("enrich_company", { domain: "acme.test" });
    expect(env.fetch).toHaveBeenCalledTimes(2);
  });

  it("a paid 429 is retried once when Retry-After is short, and not without it", async () => {
    let n = 0;
    env = makeEnv({
      handler: () =>
        ++n === 1
          ? { status: 429, headers: { "retry-after": "0" }, json: {} }
          : { json: { organization: { id: "o1", name: "Acme" } } },
    });
    await env.call("enrich_company", { domain: "acme.test" });
    expect(env.fetch).toHaveBeenCalledTimes(2);
    env.cleanup();
    env = makeEnv({ handler: () => ({ status: 429, json: {} }) });
    await expect(env.call("enrich_company", { domain: "acme.test" })).rejects.toThrow(
      /rate limited \(429\)/,
    );
    expect(env.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("find_companies", () => {
  it("merges accounts and organizations, deduped", async () => {
    env = makeEnv({
      handler: () => ({
        json: {
          accounts: [{ id: "c1", name: "One", primary_domain: "one.test" }],
          organizations: [
            { id: "c1", name: "One" },
            { id: "c2", name: "Two", website_url: "https://www.two.test/x" },
          ],
          pagination: { page: 1, per_page: 25, total_entries: 2 },
        },
      }),
    });
    const out = await env.call("find_companies", { locations: ["US"], keywords: "k" });
    expect(out.count).toBe(2);
    expect(out.companies.map((c: any) => c.domain)).toEqual(["one.test", "two.test"]);
    expect(bodyOf(env)).toMatchObject({ organization_locations: ["US"], q_keywords: "k" });
  });
});

describe("enrich tools", () => {
  it("enrich_person upserts the match, null when none", async () => {
    env = makeEnv({ handler: () => ({ json: { person: apolloPerson("p9") } }) });
    const out = await env.call("enrich_person", {
      email: "a@acme.test",
      reveal_phone_number: true,
    });
    expect(out).toMatchObject({ provider: "apollo", upserted: true });
    expect(out.person.provider_id).toBe("p9");
    expect(bodyOf(env)).toMatchObject({ email: "a@acme.test", reveal_phone_number: true });
    env.cleanup();
    env = makeEnv({ handler: () => ({ json: {} }) });
    expect((await env.call("enrich_person", { email: "a@acme.test" })).person).toBeNull();
  });

  it("enrich_person requires an identifying lookup", () => {
    expect(() => tool("enrich_person").input.parse({ first_name: "A" })).toThrow();
  });

  it("enrich_people sends details and counts matches; rejects over ten", async () => {
    env = makeEnv({
      handler: () => ({ json: { matches: [apolloPerson("a"), null, apolloPerson("b")] } }),
    });
    const out = await env.call("enrich_people", {
      inputs: [{ email: "a@acme.test" }, { email: "b@acme.test" }],
    });
    expect(out).toMatchObject({ matched: 3, upserted: 2 });
    expect(bodyOf(env).details).toHaveLength(2);
    const many = Array.from({ length: 11 }, (_, i) => ({ email: `x${i}@a.test` }));
    expect(() => tool("enrich_people").input.parse({ inputs: many })).toThrow();
  });

  it("enrich_company upserts by domain", async () => {
    env = makeEnv({
      handler: () => ({
        json: {
          organization: { id: "o1", name: "Acme", primary_domain: "acme.test", industry: "x" },
        },
      }),
    });
    const out = await env.call("enrich_company", { domain: "acme.test" });
    expect(out.company).toMatchObject({ provider_id: "o1", domain: "acme.test" });
    expect(bodyOf(env)).toEqual({ domain: "acme.test" });
  });
});

describe("leads_provider_status", () => {
  it("reports endpoints sorted by remaining daily quota", async () => {
    const block = (limit: number, left: number) => ({
      limit,
      consumed: limit - left,
      left_over: left,
    });
    env = makeEnv({
      handler: () => ({
        json: {
          '["api/v1/people/match","match"]': {
            day: block(100, 90),
            hour: block(10, 9),
            minute: block(5, 5),
          },
          '["api/v1/mixed_people/api_search","search"]': {
            day: block(100, 10),
            hour: block(10, 9),
            minute: block(5, 5),
          },
          junk: "x",
        },
      }),
    });
    const out = await env.call("leads_provider_status", {});
    expect(out.ok).toBe(true);
    expect(out.provider).toBe("apollo");
    expect(out.endpoint_count).toBe(2);
    expect(out.endpoints[0].endpoint).toBe("api/v1/mixed_people/api_search (search)");
    expect(out.endpoints[0].remaining_day).toBe(10);
    expect(out.providers[0]).toMatchObject({ id: "apollo", configured: true });
  });

  it("returns ok:false with a note when no key is set", async () => {
    env = makeEnv({ key: false });
    const out = await env.call("leads_provider_status", {});
    expect(out).toMatchObject({ ok: false, provider: null });
    expect(out.providers[0].configured).toBe(false);
    expect(out.note).toMatch(/API key/);
    expect(env.fetch).not.toHaveBeenCalled();
  });
});

describe("deprecated apollo_* aliases", () => {
  it("pin the provider and delegate to the generic tools", async () => {
    env = makeEnv({
      handler: (path) =>
        path === "/mixed_people/api_search"
          ? { json: { people: [apolloPerson("p1")] } }
          : path === "/organizations/enrich"
            ? { json: { organization: { id: "o1", name: "Acme", primary_domain: "acme.test" } } }
            : { json: {} },
    });
    const people = await env.call("apollo_search_people", { titles: ["CTO"] });
    expect(people).toMatchObject({ provider: "apollo", count: 1 });
    const co = await env.call("apollo_enrich_company", { domain: "acme.test" });
    expect(co.company.provider_id).toBe("o1");
    for (const name of [
      "apollo_health_check",
      "apollo_search_people",
      "apollo_search_companies",
      "apollo_enrich_person",
      "apollo_bulk_enrich_people",
      "apollo_enrich_company",
    ]) {
      const t = tool(name);
      expect(t.tags).toContain("deprecated");
      expect(t.description).toMatch(/^Deprecated alias/);
    }
  });
});
