// src/core/tools/builtin/batch.ts
//
// batch_run: run one tool (named directly, or found by capability) over a list
// of inputs as a single long-running job. Items run through the same scoped
// call path packs use (host.tools.call), so every item stays inside the
// caller's exposure profile and is metered like a direct call. A failing item
// never stops the others: the result has one entry per input, in order.
//
// With contact_sheet, image artifacts produced by the items are laid out on a
// grid by the local pack's local_contact_sheet (ffmpeg tile). That step only
// runs when the tool is registered and allowed; otherwise the result says why.
import { z } from "zod";
import { currentScopeAllows } from "../../mcp/scope.js";
import {
  type CallContext,
  type RegisteredTool,
  type ToolEnvelope,
  toolInputJsonSchema,
} from "../registry.js";
import { CORE_PACK_ID } from "./define.js";

export const MAX_BATCH_ITEMS = 100;
export const MAX_BATCH_CONCURRENCY = 8;
export const DEFAULT_BATCH_CONCURRENCY = 2;
export const CONTACT_SHEET_TOOL = "local_contact_sheet";
/** Tools a batch item may never call: no batches of batches, no scripts. */
export const BATCH_REFUSED: ReadonlySet<string> = new Set(["batch_run", "run_tool_script"]);

export interface BatchToolDeps {
  /** The scoped call path (host.tools.call): refuses tools outside the profile. */
  call(name: string, args: unknown, callCtx?: CallContext): Promise<ToolEnvelope>;
  /** Every registered tool, for capability lookups. */
  tools(): readonly RegisteredTool[];
}

export const BatchInput = z
  .object({
    tool: z
      .string()
      .regex(/^[A-Za-z0-9_.-]{1,128}$/)
      .optional()
      .describe("The tool to run for every input. Give this or capability."),
    capability: z
      .string()
      .regex(/^[a-z][a-z0-9_.-]{0,63}$/)
      .optional()
      .describe('A capability such as "image.generate"; the matching exposed tool runs.'),
    inputs: z
      .array(z.record(z.string(), z.unknown()))
      .min(1)
      .max(MAX_BATCH_ITEMS)
      .describe("One arguments object per item."),
    concurrency: z
      .number()
      .int()
      .min(1)
      .max(MAX_BATCH_CONCURRENCY)
      .optional()
      .describe(`Items run at once. Default ${DEFAULT_BATCH_CONCURRENCY}.`),
    max_items: z
      .number()
      .int()
      .min(1)
      .max(MAX_BATCH_ITEMS)
      .describe(
        "Safety cap: the batch is refused when inputs has more items than this. Set it to the number of items you mean to run.",
      ),
    contact_sheet: z
      .boolean()
      .optional()
      .describe("Lay the image outputs out on one grid image (needs ffmpeg). Default false."),
  })
  .strict()
  .refine((v) => (v.tool === undefined) !== (v.capability === undefined), {
    message: "give exactly one of tool or capability",
  })
  .refine((v) => v.inputs.length <= v.max_items, {
    message: "inputs has more items than max_items",
    path: ["inputs"],
  });
export type BatchArgs = z.output<typeof BatchInput>;

export type BatchItem =
  | { index: number; ok: true; result: unknown }
  | { index: number; ok: false; error: { code: string; message: string } };

/** The exposed tool for a capability: the media pack's front tool first, then by name. */
export function toolForCapability(
  tools: readonly RegisteredTool[],
  capability: string,
): RegisteredTool | undefined {
  return tools
    .filter(
      (t) =>
        t.capability === capability && !BATCH_REFUSED.has(t.name) && currentScopeAllows(t.name),
    )
    .sort((a, b) => {
      const pa = a.packId === "media" ? 0 : 1;
      const pb = b.packId === "media" ? 0 : 1;
      return pa - pb || a.name.localeCompare(b.name);
    })[0];
}

/** Image artifact ids in a tool result: objects with a string id and an image/* mime. */
export function imageArtifactIds(result: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 4 || result === null || typeof result !== "object") return out;
  if (Array.isArray(result)) {
    for (const v of result) imageArtifactIds(v, depth + 1, out);
    return out;
  }
  const r = result as Record<string, unknown>;
  if (typeof r.id === "string" && typeof r.mime === "string" && r.mime.startsWith("image/")) {
    if (!out.includes(r.id)) out.push(r.id);
    return out;
  }
  for (const v of Object.values(r)) imageArtifactIds(v, depth + 1, out);
  return out;
}

/** Run `work` over indices 0..n-1 with at most `limit` in flight. */
export async function pool(
  n: number,
  limit: number,
  work: (index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < n && !signal?.aborted) {
      const i = next++;
      await work(i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, n) }, worker));
}

export async function runBatch(
  deps: BatchToolDeps,
  input: BatchArgs,
  callCtx: CallContext,
): Promise<Record<string, unknown>> {
  let toolName: string;
  if (input.capability !== undefined) {
    const found = toolForCapability(deps.tools(), input.capability);
    if (!found) throw new Error(`no tool in this profile provides ${input.capability}`);
    toolName = found.name;
  } else {
    toolName = input.tool as string;
    if (BATCH_REFUSED.has(toolName)) throw new Error(`${toolName} cannot run inside a batch`);
    if (!currentScopeAllows(toolName) || !deps.tools().some((t) => t.name === toolName)) {
      throw new Error(`unknown tool: ${toolName}`);
    }
  }
  const total = input.inputs.length;
  const concurrency = Math.min(input.concurrency ?? DEFAULT_BATCH_CONCURRENCY, total);
  const items: BatchItem[] = new Array(total);
  let done = 0;
  const nested: CallContext = {
    ...(callCtx.signal ? { signal: callCtx.signal } : {}),
    caller: CORE_PACK_ID,
    depth: (callCtx.depth ?? 0) + 1,
  };
  callCtx.progress?.(0, `0/${total} items`);
  await pool(
    total,
    concurrency,
    async (i) => {
      let env: ToolEnvelope;
      try {
        env = await deps.call(toolName, input.inputs[i], nested);
      } catch (e) {
        env = {
          ok: false,
          error: { code: "TOOL_ERROR", message: (e as Error).message, retryable: false },
        };
      }
      items[i] = env.ok
        ? { index: i, ok: true, result: env.result }
        : { index: i, ok: false, error: { code: env.error.code, message: env.error.message } };
      done++;
      callCtx.progress?.(done / total, `${done}/${total} items`);
    },
    callCtx.signal,
  );
  if (callCtx.signal?.aborted) throw new Error("batch cancelled");
  const ok = items.filter((it) => it.ok).length;
  const out: Record<string, unknown> = {
    tool: toolName,
    total,
    succeeded: ok,
    failed: total - ok,
    items,
  };
  if (input.contact_sheet) out.contact_sheet = await contactSheet(deps, items, nested);
  return out;
}

async function contactSheet(
  deps: BatchToolDeps,
  items: readonly BatchItem[],
  nested: CallContext,
): Promise<unknown> {
  const ids: string[] = [];
  for (const it of items) if (it.ok) imageArtifactIds(it.result, 0, ids);
  if (ids.length === 0) return { skipped: "no image artifacts in the results" };
  if (!deps.tools().some((t) => t.name === CONTACT_SHEET_TOOL)) {
    return { skipped: `${CONTACT_SHEET_TOOL} is not installed (the local pack, with ffmpeg)` };
  }
  if (!currentScopeAllows(CONTACT_SHEET_TOOL)) {
    return { skipped: `${CONTACT_SHEET_TOOL} is not available in this profile` };
  }
  const env = await deps.call(
    CONTACT_SHEET_TOOL,
    { artifact_ids: ids.slice(0, MAX_BATCH_ITEMS) },
    nested,
  );
  return env.ok ? env.result : { error: env.error.message };
}

export function batchTools(deps: BatchToolDeps): RegisteredTool[] {
  return [
    {
      name: "batch_run",
      packId: CORE_PACK_ID,
      origin: "native",
      description:
        "Run one tool (by name, or the tool for a capability such as image.generate) over a list of inputs as one background job, a few at a time. Returns one result or error per input, in order; one failing item does not stop the rest. Optionally lays image outputs out on a contact sheet (needs ffmpeg).",
      inputSchema: toolInputJsonSchema(BatchInput),
      annotations: { title: "Batch run", readOnlyHint: false, openWorldHint: true },
      tags: ["core", "batch"],
      requiresSecrets: [],
      longRunning: true,
      input: BatchInput,
      run: (input, callCtx) => runBatch(deps, input as BatchArgs, callCtx),
    },
  ];
}
