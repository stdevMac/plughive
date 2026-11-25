// src/core/tools/builtin/index.ts
//
// The daemon's own tools, registered under the "core" origin:
//   list_artifacts, import_artifact   the artifact library
//   get_job_status                    background jobs
//   usage_report                      the usage ledger
//   gateway_status                    packs, mounts, providers, queue
//   batch_run                         one tool over many inputs, as a job
//   run_tool_script                   code mode, only with PLUGHIVE_CODE_MODE=1
// (search_tools, describe_tool, execute_tool, wait_for_job and cancel_job are
// served by the protocol layer, src/core/mcp/server.ts.)
import type { RegisteredTool } from "../registry.js";
import { type ArtifactToolDeps, artifactTools } from "./artifacts.js";
import { type BatchToolDeps, batchTools } from "./batch.js";
import { CORE_PACK_ID } from "./define.js";
import { type JobToolDeps, jobTools } from "./jobs.js";
import { CODE_MODE_TOOL, type ScriptToolDeps, scriptTools } from "./script.js";
import { type StatusToolDeps, statusTools } from "./status.js";

export { CORE_PACK_ID };
export { artifactView, isInside, resolveImportSource } from "./artifacts.js";
export { JOB_ID_PATTERN, type JobRow, jobView } from "./jobs.js";
export { gatewayStatus } from "./status.js";
export type { ArtifactToolDeps, BatchToolDeps, JobToolDeps, StatusToolDeps };

type BaseDeps = ArtifactToolDeps & JobToolDeps & StatusToolDeps;
/** `script` is set only when code mode is on (PLUGHIVE_CODE_MODE=1). */
export type CoreToolDeps = BaseDeps & { batch: BatchToolDeps; script?: ScriptToolDeps };
export { CODE_MODE_TOOL };

/** Tools that are bookkeeping, not work: not written to the usage ledger. */
export const METERING_EXEMPT: ReadonlySet<string> = new Set(["usage_report", "gateway_status"]);

/** Every core tool name, in listing order (run_tool_script, opt-in, is not one of them). */
export const CORE_TOOL_NAMES: readonly string[] = Object.freeze([
  "list_artifacts",
  "import_artifact",
  "get_job_status",
  "usage_report",
  "gateway_status",
  "batch_run",
]);

export function coreTools(deps: CoreToolDeps): RegisteredTool[] {
  return [
    ...artifactTools(deps),
    ...jobTools(deps),
    ...statusTools(deps),
    ...batchTools(deps.batch),
    ...(deps.script ? scriptTools(deps.script) : []),
  ];
}
