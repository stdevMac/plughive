import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PackLoader } from "../../../src/core/packs/loader.js";
import { createSecretStore } from "../../../src/core/secrets/index.js";
import { ToolRegistry } from "../../../src/core/tools/registry.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };

describe("growth pack through PackLoader", () => {
  let dir: string | null = null;
  let loader: PackLoader | null = null;
  afterEach(async () => {
    await loader?.close();
    loader = null;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  async function load() {
    dir = mkdtempSync(join(tmpdir(), "plughive-growth-"));
    const registry = new ToolRegistry();
    const store = createSecretStore({ home: dir, env: {}, backend: "memory" });
    loader = new PackLoader({
      home: dir,
      registry,
      host: { store, logger: silent },
      userDir: join(dir, "packs"),
    });
    await loader.loadAll();
    return registry;
  }

  it("registers the growth tools and the deprecated aliases", async () => {
    const registry = await load();
    const names = new Set(registry.list().map((t: { name: string }) => t.name));
    for (const n of [
      "find_people",
      "find_companies",
      "enrich_person",
      "enrich_people",
      "enrich_company",
      "leads_provider_status",
      "query_leads",
      "query_companies",
      "craft_icp",
      "research_prospect",
      "score_lead",
      "draft_cold_email",
      "personalize_outreach",
      "list_drafts",
      "mark_contacted",
      "set_sender_profile",
      "get_sender_profile",
      "pipeline_run",
      "apollo_search_people",
      "apollo_health_check",
    ]) {
      expect(names.has(n), n).toBe(true);
    }
  });

  it("returns MISSING_SECRET for provider tools when the Apollo key is unset", async () => {
    const registry = await load();
    const res = await registry.call("find_people", {});
    expect(res).toMatchObject({
      ok: false,
      error: {
        code: "MISSING_SECRET",
        pack: "growth",
        secret: "APOLLO_API_KEY",
        label: "Apollo API key",
        helpUrl: "https://docs.apollo.io/docs/create-api-key",
      },
    });
  });

  it("serves local tools without any key, using the pack data dir", async () => {
    const registry = await load();
    const empty = await registry.call("query_leads", {});
    expect(empty).toMatchObject({ ok: true, result: { total: 0, count: 0 } });
    const set = await registry.call("set_sender_profile", {
      name: "Sam",
      email: "sam@sender.test",
      pitch: "We build reliable widgets.",
    });
    expect(set).toMatchObject({ ok: true, result: { saved: true } });
    expect(await registry.call("get_sender_profile", {})).toMatchObject({
      ok: true,
      result: { exists: true },
    });
  });
});
