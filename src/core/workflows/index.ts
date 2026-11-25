// src/core/workflows/index.ts
//
// A pack's workflows folder turned into tools. Each valid recipe
// `<workflows>/<name>.json` becomes the long-running tool `wf_<name>`, owned by
// the pack (origin "workflow", tags `workflow:<name>` plus the recipe's tags).
// A recipe that does not parse, does not validate, or calls something the
// pack's permissions do not declare is left out with an error; the pack and
// its other workflows still load.
//
// A call runs the pre-flight first (or only, with dry_run: true), then the
// steps with the pack's per-call context: the same permission checks, profile
// scope, depth limit, metering and cancellation as a code pack's ctx.tools.call.
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import type { CapabilityName } from "../capabilities/schemas.js";
import { resolveInside } from "../fs/safe-path.js";
import { currentScopeAllows } from "../mcp/scope.js";
import type { PackHost, ScopedPackContext } from "../packs/context.js";
import type { PackManifest } from "../packs/manifest.js";
import { type RegisteredTool, toolInputJsonSchema } from "../tools/registry.js";
import { type CompiledRecipe, RecipeError, compileRecipe, recipeTools } from "./compile.js";
import { type PlanPackState, type PlanTool, Planner, blockedMessage, isPaid } from "./planner.js";
import { runRecipe } from "./runner.js";
import { RecipeSchema, WORKFLOW_LIMITS, formatIssues } from "./schema.js";

export { compileRecipe, RecipeError } from "./compile.js";
export { Planner, blockedMessage } from "./planner.js";
export { runRecipe, WorkflowError } from "./runner.js";
export { RecipeSchema, WORKFLOW_LIMITS } from "./schema.js";

export const WORKFLOW_TOOL_PREFIX = "wf_";

export interface WorkflowLoadError {
  name: string;
  error: string;
}

export interface LoadWorkflowsOptions {
  manifest: PackManifest;
  packDir: string;
  scoped: ScopedPackContext;
  host: PackHost;
  /** Registered tools (with their secrets), for the pre-flight. */
  tool(name: string): PlanTool | undefined;
  /** Installed pack states, for the pre-flight ("disabled", "needs-review", ...). */
  pack(id: string): PlanPackState | undefined;
  /** Counts calls in flight, so an unloading pack waits for them. */
  track<T>(run: () => Promise<T>): Promise<T>;
}

export interface LoadedWorkflows {
  tools: RegisteredTool[];
  names: string[];
  errors: WorkflowLoadError[];
}

/** Workflow names running in this async chain: a recipe cannot run itself, and nesting is capped. */
const running = new AsyncLocalStorage<readonly string[]>();

const LIBRARY_WRITE = new Set(["write", "full"]);

/** Load-time check of a recipe against the pack's permissions. Null when it may load. */
export function permissionProblem(c: CompiledRecipe, manifest: PackManifest): string | null {
  const perms = manifest.permissions;
  const declared = new Set(perms.tools);
  const wildcard = perms.tools.some((t) => t.startsWith("pack:") || t.startsWith("cap:"));
  const { calls, probes } = recipeTools(c);
  for (const t of [...calls, ...probes]) {
    if (!declared.has(t) && !wildcard) {
      return `it uses the tool ${t}, which permissions.tools of the ${manifest.id} pack does not declare`;
    }
  }
  for (const s of c.all) {
    if (
      s.kind === "capability" &&
      s.target &&
      !declared.has(`cap:${s.target}`) &&
      !declared.has("cap:*")
    ) {
      return `it runs the capability ${s.target}, which needs "cap:${s.target}" in permissions.tools`;
    }
    if (s.kind === "save" && !LIBRARY_WRITE.has(perms.library)) {
      return `step "${s.id}" saves to the library, which needs permissions.library "write"`;
    }
  }
  return null;
}

function findProtoKey(v: unknown, path = "recipe", depth = 0): string | null {
  if (depth > 32 || v === null || typeof v !== "object") return null;
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const hit = findProtoKey(v[i], `${path}.${i}`, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const k of Object.keys(v)) {
    if (k === "__proto__") return path;
    const hit = findProtoKey((v as Record<string, unknown>)[k], `${path}.${k}`, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** Parse, validate and compile one recipe file's text. */
export function parseRecipe(text: string, expectedName?: string): CompiledRecipe {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new RecipeError(`not valid JSON: ${(e as Error).message}`);
  }
  // zod drops a "__proto__" key silently; refuse it so the file says what runs.
  const proto = findProtoKey(raw);
  if (proto) throw new RecipeError(`${proto}: the key "__proto__" is not allowed`);
  const parsed = RecipeSchema.safeParse(raw);
  if (!parsed.success) throw new RecipeError(formatIssues(parsed.error));
  if (expectedName !== undefined && parsed.data.name !== expectedName) {
    throw new RecipeError(
      `the name "${parsed.data.name}" must match the file name "${expectedName}.json"`,
    );
  }
  return compileRecipe(parsed.data);
}

export function loadWorkflows(opts: LoadWorkflowsOptions): LoadedWorkflows {
  const { manifest } = opts;
  const out: LoadedWorkflows = { tools: [], names: [], errors: [] };
  if (!manifest.workflows) return out;
  let dir: string;
  try {
    dir = resolveInside(opts.packDir, manifest.workflows);
  } catch (e) {
    out.errors.push({ name: "*", error: (e as Error).message });
    return out;
  }
  if (!existsSync(dir)) return out;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const name = file.slice(0, -5);
    try {
      const path = resolveInside(dir, file);
      const st = statSync(path);
      if (!st.isFile()) throw new RecipeError("not a file");
      if (st.size > WORKFLOW_LIMITS.maxRecipeBytes) {
        throw new RecipeError(`larger than ${WORKFLOW_LIMITS.maxRecipeBytes} bytes`);
      }
      const compiled = parseRecipe(readFileSync(path, "utf8"), name);
      const problem = permissionProblem(compiled, manifest);
      if (problem) throw new RecipeError(problem);
      out.tools.push(workflowTool(compiled, opts));
      out.names.push(compiled.name);
    } catch (e) {
      out.errors.push({ name, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

function description(c: CompiledRecipe): string {
  return `${c.recipe.description}\n\nWorkflow (runs as a job). Call it with dry_run: true first to see the steps, what is missing, how many paid calls it can make and what it may cost; nothing runs then.`;
}

/** The registered tool of one recipe. */
export function workflowTool(c: CompiledRecipe, opts: LoadWorkflowsOptions): RegisteredTool {
  const { manifest, scoped, host } = opts;
  const perms = new Set(manifest.permissions.tools);
  const wildcardPack = (name: string) => {
    const t = opts.tool(name);
    return t !== undefined && perms.has(`pack:${t.packId}`);
  };
  const permitted = (name: string) => {
    if (name.startsWith("cap:")) return perms.has(name) || perms.has("cap:*");
    if (perms.has(name) || wildcardPack(name)) return true;
    const cap = opts.tool(name)?.capability;
    return cap !== undefined && (perms.has(`cap:${cap}`) || perms.has("cap:*"));
  };
  const planner = () =>
    new Planner(c, {
      packId: manifest.id,
      tool: (name) => opts.tool(name),
      inScope: (name) => currentScopeAllows(name),
      permitted,
      hasSecret: (name) => host.store.has(name),
      pack: (id) => opts.pack(id),
      ...(host.capabilities
        ? {
            providers: async (cap: CapabilityName) =>
              (await host.capabilities?.list(cap))?.map((p) => ({
                pack: p.pack,
                configured: p.configured,
                autoRoute: p.autoRoute,
              })) ?? [],
          }
        : {}),
    });

  return {
    name: c.toolName,
    packId: manifest.id,
    origin: "workflow",
    description: description(c),
    inputSchema: toolInputJsonSchema(c.inputZod),
    annotations: { title: c.title },
    tags: [
      `workflow:${c.name}`,
      ...(c.recipe.tags ?? []).filter((t) => !t.startsWith("workflow:")),
    ],
    requiresSecrets: [],
    longRunning: true,
    input: c.inputZod,
    run(rawInput, callCtx) {
      const stack = running.getStore() ?? [];
      if (stack.includes(c.toolName)) {
        return Promise.reject(
          new Error(`${c.toolName} cannot run itself (called through ${stack.join(" > ")})`),
        );
      }
      if (stack.length >= WORKFLOW_LIMITS.maxWorkflowDepth) {
        return Promise.reject(
          new Error(
            `workflows nest at most ${WORKFLOW_LIMITS.maxWorkflowDepth} deep (${[...stack, c.toolName].join(" > ")})`,
          ),
        );
      }
      return running.run([...stack, c.toolName], () =>
        opts.track(async () => {
          const { dry_run: dryRun, ...input } = rawInput as Record<string, unknown> & {
            dry_run?: boolean;
          };
          const p = planner();
          const plan = await p.plan(input);
          if (dryRun === true) return { dry_run: true, ...plan };
          if (!plan.ok) {
            const err = new Error(blockedMessage(plan)) as Error & { code?: string };
            err.code = "WORKFLOW_BLOCKED";
            throw err;
          }
          const timeout = AbortSignal.timeout(c.limits.timeoutSeconds * 1000);
          const signal = callCtx.signal ? AbortSignal.any([callCtx.signal, timeout]) : timeout;
          const ctx = scoped.forCall({ ...callCtx, signal }, c.toolName);
          const available = await p.availableMap();
          const go = () =>
            runRecipe(c, input, {
              ctx,
              available,
              timeout,
              paid: (step) => isPaid(step, { tool: (name) => opts.tool(name) }),
            });
          // One approval covers the whole run when it may go over a cap; the
          // paid steps inside then run without asking again (caps still block).
          const maxUsd = plan.paid_calls_max === 0 ? 0 : plan.estimated_cost_usd.max;
          const result = host.policy
            ? await host.policy.runWorkflow({ name: c.toolName, args: input, maxUsd }, signal, go)
            : await go();
          return {
            ...result,
            paid_calls_max: plan.paid_calls_max,
            estimated_cost_usd: plan.estimated_cost_usd,
          };
        }),
      );
    },
  };
}
