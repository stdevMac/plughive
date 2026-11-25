// src/core/tools/builtin/define.ts
//
// Core built-in tools are registered straight into the ToolRegistry under the
// pack id "core" (the only id that may own the reserved tool names). They are
// not packs: each one gets the host objects it needs as explicit dependencies
// and nothing else.
import type { z } from "zod";
import { type CallContext, type RegisteredTool, toolInputJsonSchema } from "../registry.js";

export const CORE_PACK_ID = "core";

export interface CoreToolSpec<S extends z.ZodType> {
  name: string;
  description: string;
  input: S;
  tags?: readonly string[];
  run(input: z.output<S>, callCtx: CallContext): Promise<unknown> | unknown;
}

export function coreTool<S extends z.ZodType>(spec: CoreToolSpec<S>): RegisteredTool {
  return {
    name: spec.name,
    packId: CORE_PACK_ID,
    origin: "native",
    description: spec.description,
    inputSchema: toolInputJsonSchema(spec.input),
    annotations: { readOnlyHint: spec.name !== "import_artifact" },
    tags: ["core", ...(spec.tags ?? [])],
    requiresSecrets: [],
    longRunning: false,
    input: spec.input,
    run: async (input, callCtx) => spec.run(input as z.output<S>, callCtx),
  };
}
