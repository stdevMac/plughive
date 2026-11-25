// src/core/mcp/meta.ts
//
// The core tools the protocol layer serves itself:
//   search_tools / describe_tool / execute_tool   the search surface of a profile
//   wait_for_job / cancel_job                     bounded wait on, and cancel of, a background job
// Their names are reserved in the ToolRegistry, so no pack or mount can shadow them.
import { z } from "zod";
import type { ToolDescriptor } from "../profiles.js";
import { type RegisteredTool, toolInputJsonSchema } from "../tools/registry.js";

export const SearchToolsInput = z.object({
  query: z.string().trim().min(1).max(200).describe("What you want to do, in a few words."),
  limit: z.number().int().min(1).max(50).default(8).describe("Maximum number of matches."),
});

export const DescribeToolInput = z.object({
  name: z
    .union([z.string().min(1).max(128), z.array(z.string().min(1).max(128)).min(1).max(20)])
    .describe("One tool name, or a list of up to 20."),
});

export const ExecuteToolInput = z.object({
  name: z.string().min(1).max(128).describe("Tool name, as returned by search_tools."),
  arguments: z
    .record(z.string(), z.unknown())
    .default({})
    .describe("Arguments matching the input schema from describe_tool."),
});

export const WAIT_MAX_SECONDS = 50;
export const WaitForJobInput = z.object({
  job_id: z.string().min(1).max(128),
  timeout_s: z
    .number()
    .min(0)
    .max(WAIT_MAX_SECONDS)
    .default(25)
    .describe("How long to wait for the job to finish before returning its current status."),
});

const readOnly = { readOnlyHint: true } as const;

export const SEARCH_TOOLS_TOOL: ToolDescriptor = {
  name: "search_tools",
  description:
    "Find tools by what they do. Returns ranked tool names with a one-line description. Next: describe_tool for the input schema, then execute_tool.",
  inputSchema: toolInputJsonSchema(SearchToolsInput),
  annotations: readOnly,
};

export const DESCRIBE_TOOL_TOOL: ToolDescriptor = {
  name: "describe_tool",
  description:
    "Return the full description and input JSON schema of one or more tools found with search_tools.",
  inputSchema: toolInputJsonSchema(DescribeToolInput),
  annotations: readOnly,
};

export const EXECUTE_TOOL_TOOL: ToolDescriptor = {
  name: "execute_tool",
  description:
    "Run a tool found with search_tools. Pass its name and the arguments described by describe_tool. The result is the tool's own result.",
  inputSchema: toolInputJsonSchema(ExecuteToolInput),
};

export const WAIT_FOR_JOB_TOOL: ToolDescriptor = {
  name: "wait_for_job",
  description:
    "Wait for a background job (a result that carries job_id) to finish, for at most timeout_s seconds. Returns the status, and the result once done. Call again while done is false.",
  inputSchema: toolInputJsonSchema(WaitForJobInput),
  annotations: readOnly,
};

export const CancelJobInput = z.object({
  job_id: z.string().min(1).max(128),
});

export const CANCEL_JOB_TOOL: ToolDescriptor = {
  name: "cancel_job",
  description:
    "Cancel a background job (a result that carries job_id) that has not finished. Returns whether it was cancelled and its status.",
  inputSchema: toolInputJsonSchema(CancelJobInput),
  annotations: { destructiveHint: true, idempotentHint: true },
};

/** The job tools the protocol layer serves when the daemon runs background jobs. */
export const JOB_TOOLS: readonly ToolDescriptor[] = [WAIT_FOR_JOB_TOOL, CANCEL_JOB_TOOL];

/** tools/list of a profile in search mode (before pinned tools). */
export const META_TOOLS: readonly ToolDescriptor[] = [
  SEARCH_TOOLS_TOOL,
  DESCRIBE_TOOL_TOOL,
  EXECUTE_TOOL_TOOL,
];

// ---------------------------------------------------------------------------
// Search: deterministic lexical ranking
// ---------------------------------------------------------------------------

export interface SearchHit {
  name: string;
  description: string;
  pack: string;
  score: number;
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/** First sentence or line, capped. */
export function oneLine(description: string, max = 160): string {
  const first = description.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const sentence = first.match(/^(.+?[.!?])(\s|$)/)?.[1] ?? first;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

/** What search ranks a tool on. */
export type SearchableTool = Pick<
  RegisteredTool,
  "name" | "description" | "tags" | "capability" | "packId"
>;

function scoreTool(t: SearchableTool, query: string, terms: readonly string[]): number {
  const name = t.name.toLowerCase();
  const nameWords = new Set(words(t.name));
  const descWords = new Set(words(t.description));
  const tagWords = new Set(t.tags.flatMap(words));
  const capWords = new Set(words(t.capability ?? ""));
  const packWords = new Set(words(t.packId));
  let score = name === query ? 100 : 0;
  for (const term of terms) {
    if (nameWords.has(term)) score += 10;
    else if (name.includes(term)) score += 6;
    if (capWords.has(term)) score += 5;
    if (tagWords.has(term)) score += 4;
    if (packWords.has(term)) score += 3;
    if (descWords.has(term)) score += 2;
  }
  return score;
}

/** Rank `tools` for `query`: score descending, then name. Tools that match nothing are dropped. */
export function searchTools(
  tools: readonly SearchableTool[],
  query: string,
  limit: number,
): { hits: SearchHit[]; total: number } {
  const q = query.trim().toLowerCase();
  const terms = [...new Set(words(q))];
  const scored = tools
    .map((t) => ({ t, score: scoreTool(t, q, terms) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.t.name < b.t.name ? -1 : a.t.name > b.t.name ? 1 : 0));
  return {
    total: scored.length,
    hits: scored.slice(0, limit).map(({ t, score }) => ({
      name: t.name,
      description: oneLine(t.description),
      pack: t.packId,
      score,
    })),
  };
}
