// packs/growth/index.ts
//
// Growth pack: lead search and enrichment, local lead store, ICP crafting,
// scoring, research and cold-email drafting.
import { type AnyToolDefinition, definePack } from "plughive/pack";
import { SenderStore } from "./sender.js";
import type { GrowthServices } from "./services.js";
import { LeadsStore } from "./store.js";
import { aiTools } from "./tools/ai.js";
import { localTools } from "./tools/local.js";
import { outreachTools } from "./tools/outreach.js";
import { pipelineRun } from "./tools/pipeline.js";
import {
  enrichCompany,
  enrichPeople,
  enrichPerson,
  findCompanies,
  findPeople,
  leadsProviderStatus,
  providerTools,
} from "./tools/provider.js";

// Deprecated aliases for the old Apollo tool names: same input, provider pinned to apollo.
// Results use provider_id where the old tools returned apollo_id.
const DEPRECATED: Array<[string, AnyToolDefinition<GrowthServices>]> = [
  ["apollo_health_check", leadsProviderStatus],
  ["apollo_search_people", findPeople],
  ["apollo_search_companies", findCompanies],
  ["apollo_enrich_person", enrichPerson],
  ["apollo_bulk_enrich_people", enrichPeople],
  ["apollo_enrich_company", enrichCompany],
];

const aliases = DEPRECATED.map(([name, t]): AnyToolDefinition<GrowthServices> => {
  const { capability: _capability, ...rest } = t;
  return {
    ...rest,
    name,
    description: `Deprecated alias of ${t.name} (provider fixed to apollo). ${t.description}`,
    tags: ["deprecated", ...(t.tags ?? [])],
    run: (input, ctx) => t.run({ ...input, provider: "apollo" }, ctx),
  };
});

let leads: LeadsStore | null = null;

export default definePack<GrowthServices>({
  setup(ctx) {
    leads = new LeadsStore({ root: ctx.pack.dataDir });
    return { leads, sender: new SenderStore({ root: ctx.pack.dataDir }) };
  },
  tools: [...providerTools, ...localTools, ...aiTools, ...outreachTools, pipelineRun, ...aliases],
  dispose() {
    leads?.close();
    leads = null;
  },
});
