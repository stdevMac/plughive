// src/core/tools/builtin/status.ts
//
// usage_report and gateway_status. Neither is metered (they are bookkeeping),
// neither returns a secret value: gateway_status reports which secret names
// are missing, never what is stored.
import { z } from "zod";
import type { UsageEvent, UsageSummary } from "../../../lib/usage.js";
import type { MountInfo } from "../../mounts/manager.js";
import type { CapabilityProviderInfo } from "../../pack-api.js";
import type { PackStatus } from "../../packs/loader.js";
import type { RegisteredTool } from "../registry.js";
import { coreTool } from "./define.js";

export interface StatusToolDeps {
  usage: {
    list(opts: { since?: string; tool?: string; limit?: number }): UsageEvent[];
    summarize(opts: { since?: string }): UsageSummary;
  };
  packs: { listPacks(): Promise<PackStatus[]> };
  mounts: { listMounts(): Promise<MountInfo[]>; userFileError(): string | null };
  capabilities: { list(): Promise<CapabilityProviderInfo[]> };
  jobs: { counts(): Record<string, number> };
  tools: () => ReadonlyArray<{ origin: string }>;
  daemon: { version: string; bindHost: string; authRequired: boolean; importRoots: number };
}

const TERMINAL = new Set(["succeeded", "failed", "cancelled", "expired", "submission_unknown"]);

/** The daemon's state in one object (gateway_status and GET /api/status share it). */
export async function gatewayStatus(deps: StatusToolDeps) {
  const [packs, mounts, providers] = await Promise.all([
    deps.packs.listPacks(),
    deps.mounts.listMounts(),
    deps.capabilities.list(),
  ]);
  const byState = (state: string) => packs.filter((p) => p.state === state);
  const capabilities: Record<string, unknown[]> = {};
  for (const p of providers) {
    const list = capabilities[p.capability] ?? [];
    list.push({
      id: p.id,
      pack: p.pack,
      priority: p.priority,
      configured: p.configured,
      preferred: p.preferred,
      auto_route: p.autoRoute,
      cooling_down_until: p.coolingDownUntil,
    });
    capabilities[p.capability] = list;
  }
  const counts = deps.jobs.counts();
  const running = Object.entries(counts)
    .filter(([status]) => status !== "queued" && !TERMINAL.has(status))
    .reduce((n, [, c]) => n + c, 0);
  const tools = deps.tools();
  return {
    version: deps.daemon.version,
    bind_host: deps.daemon.bindHost,
    auth_required: deps.daemon.authRequired,
    import_roots: deps.daemon.importRoots,
    tools: {
      total: tools.length,
      mounted: tools.filter((t) => t.origin === "mounted").length,
    },
    packs: {
      total: packs.length,
      loaded: byState("loaded").map((p) => p.id),
      disabled: byState("disabled").map((p) => p.id),
      failed: [...byState("failed"), ...byState("invalid")].map((p) => ({
        id: p.id,
        error: p.error,
      })),
      needs_review: byState("needs-review").map((p) => p.id),
      missing_secrets: packs
        .filter((p) => p.state === "loaded")
        .flatMap((p) =>
          p.secrets
            .filter((s) => s.required && s.granted && !s.present)
            .map((s) => ({ pack: p.id, secret: s.name })),
        ),
    },
    mounts: mounts.map((m) => ({
      id: m.id,
      source: m.source,
      transport: m.transport,
      prefix: m.prefix,
      enabled: m.enabled,
      connected: m.connected,
      tools: m.tools,
      note: m.note,
      error: m.error,
    })),
    mounts_file_error: deps.mounts.userFileError(),
    capabilities,
    jobs: { queued: counts.queued ?? 0, running, by_status: counts },
  };
}

export function statusTools(deps: StatusToolDeps): RegisteredTool[] {
  return [
    coreTool({
      name: "usage_report",
      description:
        "Calls and cost recorded in the usage ledger: totals by tool, provider and capability, optionally the latest events.",
      input: z
        .object({
          since: z.string().max(40).optional().describe("ISO time: only usage at or after it"),
          tool: z.string().max(128).optional(),
          limit: z.number().int().min(1).max(500).default(50),
          include_events: z.boolean().default(false),
        })
        .strict(),
      tags: ["usage"],
      run: ({ since, tool, limit, include_events }) => ({
        summary: deps.usage.summarize(since ? { since } : {}),
        events: include_events
          ? deps.usage.list({ ...(since ? { since } : {}), ...(tool ? { tool } : {}), limit })
          : [],
      }),
    }),
    coreTool({
      name: "gateway_status",
      description:
        "State of the daemon: packs loaded, failed or waiting for review, upstream mounts, providers per capability and the job queue.",
      input: z.object({}).strict(),
      tags: ["status"],
      run: () => gatewayStatus(deps),
    }),
  ];
}
