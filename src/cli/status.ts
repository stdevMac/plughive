// src/cli/status.ts
//
//   plughive status [--json] [--home DIR]
//
// Asks the running daemon (through /api, with the admin token) for its
// version, endpoint and pack and tool counts.
import { resolve } from "node:path";
import { connect, daemonTarget, daemonUp } from "./api.js";
import { type CliIo, EXIT_FAIL, EXIT_OK, jsonText, parse } from "./args.js";

export const STATUS_HELP = `Usage: plughive status [options]

Show whether the daemon runs, its version, endpoint, packs and tools.
Exits 1 when no daemon answers.

Options:
  --json        print the result as JSON
  --home DIR    data directory of the daemon (PLUGHIVE_HOME)
  -h, --help    show this help`;

interface InfoBody {
  version?: string;
  mcp_url?: string;
  auth_required?: boolean;
  secrets_backend?: string | null;
  uptime_s?: number;
}

interface PacksBody {
  packs?: { id: string; enabled: boolean; state: string; tools: string[] }[];
}

interface ToolsBody {
  tools?: unknown[];
}

export async function runStatus(argv: string[], io: CliIo): Promise<number> {
  const { values } = parse("status", argv, {
    json: { type: "boolean" },
    home: { type: "string" },
    help: { type: "boolean", short: "h" },
  });
  if (values.help) {
    io.out(STATUS_HELP);
    return EXIT_OK;
  }
  const env = { ...io.env };
  if (values.home !== undefined) {
    env.PLUGHIVE_HOME = resolve(values.home);
    env.PLUGHIVE_ROOT = env.PLUGHIVE_HOME;
  }
  const { baseUrl, localUrl } = daemonTarget(env);
  if (!(await daemonUp(localUrl))) {
    if (values.json) io.out(JSON.stringify({ up: false, base_url: baseUrl }));
    else io.out(`plughive is not running on ${baseUrl}`);
    return EXIT_FAIL;
  }
  const { api } = connect(env);
  const [info, packs, tools] = await Promise.all([
    api.get<InfoBody>("/api/info"),
    api.get<PacksBody>("/api/packs"),
    api.get<ToolsBody>("/api/tools"),
  ]);
  const list = packs.packs ?? [];
  const summary = {
    up: true,
    base_url: baseUrl,
    version: info.version ?? null,
    mcp_url: info.mcp_url ?? `${baseUrl}/mcp`,
    auth_required: info.auth_required ?? null,
    secrets_backend: info.secrets_backend ?? null,
    uptime_s: info.uptime_s ?? null,
    packs: {
      total: list.length,
      enabled: list.filter((p) => p.enabled).length,
      loaded: list.filter((p) => p.state === "loaded").length,
      needs_review: list.filter((p) => p.state === "needs-review").map((p) => p.id),
      failed: list.filter((p) => p.state === "failed" || p.state === "invalid").map((p) => p.id),
    },
    tools: Array.isArray(tools.tools) ? tools.tools.length : null,
  };
  if (values.json) {
    io.out(jsonText(summary, 2));
    return EXIT_OK;
  }
  io.out(`plughive ${summary.version ?? "(unknown version)"} on ${baseUrl}`);
  io.out(
    `  MCP endpoint:  ${summary.mcp_url}${summary.auth_required ? " (access key required)" : ""}`,
  );
  io.out(
    `  packs:         ${summary.packs.enabled} enabled, ${summary.packs.loaded} loaded, ${summary.packs.total} total`,
  );
  if (summary.packs.needs_review.length)
    io.out(`  needs review:  ${summary.packs.needs_review.join(", ")}`);
  if (summary.packs.failed.length) io.out(`  failed:        ${summary.packs.failed.join(", ")}`);
  io.out(`  tools:         ${summary.tools ?? "unknown"}`);
  if (summary.secrets_backend) io.out(`  secrets:       ${summary.secrets_backend}`);
  return EXIT_OK;
}
