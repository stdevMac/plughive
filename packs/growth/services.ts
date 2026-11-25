// packs/growth/services.ts
import type { PackContext } from "plughive/pack";
import type { SenderStore } from "./sender.js";
import type { LeadsStore } from "./store.js";

/** Pack-local services built once in setup() and merged into every tool's ctx. */
export interface GrowthServices {
  leads: LeadsStore;
  sender: SenderStore;
}

export type GrowthCtx = PackContext & GrowthServices;
