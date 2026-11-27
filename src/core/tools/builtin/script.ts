// src/core/tools/builtin/script.ts
//
// run_tool_script ("code mode"): run a short JavaScript snippet that chains
// tool calls, so a model can do in one call what would otherwise take many
// round trips. Off by default: registered only when PLUGHIVE_CODE_MODE=1.
//
// The snippet runs in a fresh node:vm context inside a separate Node process:
//   - its only capability is `tools.call(name, args)`, which returns the same
//     envelope as the registry ({ok, result} or {ok: false, error}) and goes
//     through the scoped ctx.tools.call path, so the caller's profile applies;
//   - there is no require, process, import(), eval or new Function (string code
//     generation and WebAssembly are disabled in the context); the context's
//     intrinsics are frozen before the snippet runs;
//   - tool results cross into the context as JSON, never as host objects;
//   - wall time, number of calls, code size, output size and heap are limited,
//     and the process is killed when the time is up, so a busy loop cannot
//     hold the daemon.
//
// node:vm is NOT a security boundary (Node's own documentation says so), so
// the context runs in a child process rather than in the daemon. The child
// starts with Node's permission model and no fs, child_process, worker, addon
// or WASI rights, with an empty environment, a neutral cwd, no stdio and no
// string code generation even outside the context; it cannot signal other
// processes. A vm escape therefore lands in a process that holds none of the
// daemon's secrets and cannot read or write files or start programs. What it
// still has: the IPC channel (the same tools.call the snippet already had,
// counted and checked in the daemon), CPU and memory up to the limits, and,
// on Node versions before 25, the network (the permission model only covers
// the network from Node 25). Every call it makes is still limited to the
// tools the caller's profile exposes.
import { type ChildProcess, spawn } from "node:child_process";
import { parse } from "node:path";
import { z } from "zod";
import { currentScope, requestScope } from "../../mcp/scope.js";
import { runNotPreApproved } from "../../policy/run-context.js";
import {
  type CallContext,
  type RegisteredTool,
  type ToolEnvelope,
  toolInputJsonSchema,
} from "../registry.js";
import { MAX_BATCH_CONCURRENCY, MAX_NESTED_LONG_RUNNING, isHeavyTool } from "./batch.js";
import { CORE_PACK_ID } from "./define.js";

export const CODE_MODE_TOOL = "run_tool_script";
export const CODE_MODE_ENV = "PLUGHIVE_CODE_MODE";
export const MAX_SCRIPT_CHARS = 64 * 1024;
export const DEFAULT_SCRIPT_TIMEOUT_MS = 30_000;
export const MAX_SCRIPT_TIMEOUT_MS = 120_000;
export const DEFAULT_SCRIPT_CALLS = 25;
export const MAX_SCRIPT_CALLS = 100;
export const MAX_SCRIPT_OUTPUT_BYTES = 256 * 1024;
/** Tool calls a script has in flight at once; more wait their turn. */
export const MAX_SCRIPT_IN_FLIGHT = MAX_BATCH_CONCURRENCY;
const HEAP_MB = 64;
/** Tools a script may never call. */
export const SCRIPT_REFUSED: ReadonlySet<string> = new Set(["run_tool_script", "batch_run"]);

export interface ScriptToolDeps {
  /** The scoped call path (host.tools.call). */
  call(name: string, args: unknown, callCtx?: CallContext): Promise<ToolEnvelope>;
  /** Every registered tool, to tell long-running ones apart (optional). */
  tools?(): readonly RegisteredTool[];
}

/**
 * At most `limit` calls in flight, and at most `heavyLimit` of them heavy
 * (long-running tools and workflows): the whole script holds one job slot, so
 * it must not run many jobs' worth of work inside it. Extra calls wait.
 */
class CallSlots {
  private running = 0;
  private heavyRunning = 0;
  private readonly waiting: { heavy: boolean; start: () => void }[] = [];

  constructor(
    private readonly limit: number,
    private readonly heavyLimit: number,
  ) {}

  run(heavy: boolean, fn: () => Promise<void>): void {
    this.waiting.push({ heavy, start: () => void fn().finally(() => this.release(heavy)) });
    this.pump();
  }

  private release(heavy: boolean): void {
    this.running--;
    if (heavy) this.heavyRunning--;
    this.pump();
  }

  private pump(): void {
    for (let i = 0; i < this.waiting.length && this.running < this.limit; ) {
      const next = this.waiting[i] as { heavy: boolean; start: () => void };
      if (next.heavy && this.heavyRunning >= this.heavyLimit) {
        i++;
        continue;
      }
      this.waiting.splice(i, 1);
      this.running++;
      if (next.heavy) this.heavyRunning++;
      next.start();
    }
  }
}

export const ScriptInput = z
  .object({
    code: z
      .string()
      .min(1)
      .max(MAX_SCRIPT_CHARS)
      .describe(
        "The body of an async function. Use `await tools.call(name, args)` (returns {ok, result} or {ok: false, error}), `console.log(...)` and `return` a JSON-serialisable value.",
      ),
    timeout_ms: z
      .number()
      .int()
      .min(100)
      .max(MAX_SCRIPT_TIMEOUT_MS)
      .optional()
      .describe(`Wall-time limit. Default ${DEFAULT_SCRIPT_TIMEOUT_MS} ms.`),
    max_calls: z
      .number()
      .int()
      .min(0)
      .max(MAX_SCRIPT_CALLS)
      .optional()
      .describe(`Most tool calls the script may make. Default ${DEFAULT_SCRIPT_CALLS}.`),
  })
  .strict();
export type ScriptArgs = z.output<typeof ScriptInput>;

export class ScriptError extends Error {
  constructor(
    readonly code: "SCRIPT_TIMEOUT" | "SCRIPT_ERROR" | "SCRIPT_OUTPUT_LIMIT" | "SCRIPT_CANCELLED",
    message: string,
  ) {
    super(message);
    this.name = "ScriptError";
  }
}

// Realm rule: nothing created in the child's own realm (a function, Error,
// Promise or object) may ever become reachable from the snippet, because
// `x.constructor.constructor` on any of them leads to the child's own realm,
// where `process` and `require` live. So the two realms only trade primitives: the context calls `send(kind, id, text, text)`
// (which returns nothing, and whose own errors are swallowed in the context),
// and the child calls the context's `deliver(id, ok, text)`. Promises and
// Errors the snippet sees are made inside the context, and JSON is parsed
// there. The child also never calls `.then` on a context promise: the
// context's `start` does that.
//
// BOOTSTRAP runs inside the context: it captures what it needs, freezes the
// intrinsics and defines `tools` and `console` before the snippet is compiled.
const BOOTSTRAP = String.raw`(function (send, maxOut) {
  "use strict";
  const g = globalThis;
  const parse = JSON.parse, stringify = JSON.stringify;
  const P = Promise;
  const pending = new Map();
  let seq = 0;
  const post = (kind, id, a, b) => {
    try { send(kind, id, a, b); return true; } catch { return false; }
  };
  const logs = [];
  let logBytes = 0;
  const show = (v) => { try { return typeof v === "string" ? v : String(stringify(v)); } catch { try { return String(v); } catch { return "?"; } } };
  const log = (...args) => {
    const line = args.map(show).join(" ");
    logBytes += line.length + 1;
    if (logBytes > maxOut) throw new Error("console output over the limit");
    logs.push(line);
  };
  const tools = Object.freeze({
    call: async (name, args) => {
      if (typeof name !== "string") throw new TypeError("tools.call(name, args): name must be a string");
      const json = stringify(args === undefined ? {} : args);
      if (typeof json !== "string") throw new TypeError("tools.call arguments must be JSON-serialisable");
      const text = await new P((resolve, reject) => {
        const id = ++seq;
        pending.set(id, { resolve, reject });
        if (!post("call", id, name, json)) {
          pending.delete(id);
          reject(new Error("tools.call could not reach the daemon"));
        }
      });
      return parse(text);
    },
  });
  const deliver = (id, ok, text) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    if (ok === true) p.resolve(String(text)); else p.reject(new Error(String(text)));
  };
  const fail = (e) => {
    let message;
    try { message = e !== null && typeof e === "object" && typeof e.message === "string" ? e.message : String(e); }
    catch { message = "the script threw a value that cannot be shown"; }
    post("error", 0, String(message), "");
  };
  const done = (value) => {
    let out;
    try { out = stringify(value === undefined ? null : value); } catch (e) { fail(e); return; }
    // A function, a symbol or a toJSON() that gives undefined: no value.
    if (typeof out !== "string") out = "null";
    post("done", 0, out, logs.join("\n"));
  };
  const start = (p) => { P.resolve(p).then(done, fail); };
  const consoleObj = Object.freeze({ log, info: log, warn: log, error: log });
  for (const k of Object.getOwnPropertyNames(g)) {
    if (k === "globalThis") continue;
    const v = g[k];
    if ((typeof v === "function" || (typeof v === "object" && v !== null))) {
      try { Object.freeze(v); if (v.prototype) Object.freeze(v.prototype); } catch {}
    }
  }
  Object.freeze(Object.getPrototypeOf(async function () {}));
  Object.freeze(Object.getPrototypeOf(function* () {}));
  Object.freeze(Object.getPrototypeOf(async function* () {}));
  Object.defineProperty(g, "tools", { value: tools, enumerable: true });
  Object.defineProperty(g, "console", { value: consoleObj, enumerable: true });
  return Object.freeze({ deliver, start });
})`;

// The child process. Plain JavaScript passed with `-e`, so there is no file to
// ship or to let it read, and it runs the same from src/ and dist/. The snippet
// and the bootstrap arrive over IPC in the "start" message.
//
// Before anything else it takes away what the permission model leaves a
// process that has no fs, child_process or worker rights: signalling other
// processes (process.kill, so an escape cannot kill the daemon or any other
// process of this user) and changing their priority, and it empties its env.
const CHILD = String.raw`"use strict";
const vm = require("node:vm");
const deny = () => { throw new Error("not available to a script"); };
for (const k of ["kill", "_kill"]) {
  try { Object.defineProperty(process, k, { value: deny, writable: false, configurable: false }); } catch {}
}
try {
  Object.defineProperty(require("node:os"), "setPriority", { value: deny, writable: false, configurable: false });
} catch {}
// The daemon starts this process with an empty env, but Windows (libuv) still
// copies in a few system variables such as USERNAME and PATH: drop them.
for (const k of Object.keys(process.env)) {
  try { delete process.env[k]; } catch {}
}
const post = (m) => { try { process.send(m); } catch {} };
// The daemon went away: nothing is left to answer the script.
process.on("disconnect", () => process.exit(0));
let api = null;
let started = false;
let syncStarted = 0;
let syncTimeout = 0;
// Called from inside the context: takes primitives only and returns nothing.
const send = (kind, id, a, b) => {
  const text = (v, d) => (typeof v === "string" ? v : d);
  if (kind === "call" && typeof id === "number") {
    post({ type: "call", id, name: text(a, ""), args: text(b, "") });
  } else if (kind === "done") {
    post({ type: "done", out: text(a, "null"), logs: text(b, "") });
  } else if (kind === "error") {
    post({ type: "error", message: text(a, "the script failed") });
  }
};
// Compile errors are this realm's own Errors. The time-limit error is not an
// instance of this realm's Error, so it is told apart by the clock instead:
// a value the snippet threw is never read here (it could be a Proxy).
const fail = (e) => {
  if (syncStarted && Date.now() - syncStarted >= syncTimeout) {
    post({ type: "timeout" });
    return;
  }
  post({
    type: "error",
    message: e instanceof Error ? String(e.message) : "the script threw before it started",
  });
};
const run = (w) => {
  syncTimeout = Number(w.syncTimeout) || 0;
  try {
    const ctx = vm.createContext(Object.create(null), {
      name: "run_tool_script",
      codeGeneration: { strings: false, wasm: false },
    });
    const boot = vm.runInContext(String(w.bootstrap), ctx, { timeout: 10000 })(send, Number(w.maxOut));
    const start = boot.start;
    api = { deliver: boot.deliver };
    const script = new vm.Script(
      "(async () => {\n" + String(w.code) + "\n})()",
      { filename: "script.js", lineOffset: -1 },
    );
    post({ type: "ready" });
    syncStarted = Date.now();
    start(script.runInContext(ctx, { timeout: syncTimeout }));
  } catch (e) {
    fail(e);
  }
};
process.on("message", (m) => {
  if (m === null || typeof m !== "object") return;
  if (m.type === "start") {
    if (!started) { started = true; run(m); }
    return;
  }
  if (!api || typeof m.id !== "number") return;
  const ok = typeof m.json === "string";
  try { api.deliver(m.id, ok, ok ? m.json : String(m.error)); } catch {}
});
`;

/** How long the child process may take to start, apart from the script's own time limit. */
export const SCRIPT_BOOT_TIMEOUT_MS = 30_000;

/** Node 22.13+ calls it --permission; earlier 22.x only knows --experimental-permission. */
const PERMISSION_FLAG = process.allowedNodeEnvironmentFlags.has("--permission")
  ? "--permission"
  : "--experimental-permission";

/**
 * The command line of the script's child process: the permission model with
 * no fs, child_process, worker, addon or WASI rights, no string code
 * generation even outside the context, and a small heap.
 */
export function scriptChildArgs(): string[] {
  return [
    PERMISSION_FLAG,
    "--disallow-code-generation-from-strings",
    `--max-old-space-size=${HEAP_MB}`,
    "--max-semi-space-size=8",
    "-e",
    CHILD,
  ];
}

/** Start a child the way run_tool_script does: no env, a neutral cwd, IPC only. */
export function spawnScriptChild(args: readonly string[] = scriptChildArgs()): ChildProcess {
  return spawn(process.execPath, [...args], {
    env: {},
    cwd: parse(process.execPath).root,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "json",
    windowsHide: true,
  });
}

// Children still running when the daemon exits are killed with it.
const liveChildren = new Set<ChildProcess>();
/** Process ids of the script children still running (for tests). */
export function scriptChildPids(): number[] {
  return [...liveChildren].flatMap((c) => (c.pid === undefined ? [] : [c.pid]));
}
let exitHook = false;
function track(child: ChildProcess): void {
  liveChildren.add(child);
  if (exitHook) return;
  exitHook = true;
  process.once("exit", () => {
    for (const c of liveChildren) c.kill("SIGKILL");
  });
}

/** Run a snippet. Resolves with its JSON result and console output, or throws a ScriptError. */
export async function runScript(
  deps: ScriptToolDeps,
  input: ScriptArgs,
  callCtx: CallContext = {},
): Promise<{ result: unknown; logs: string; calls: number }> {
  const timeoutMs = input.timeout_ms ?? DEFAULT_SCRIPT_TIMEOUT_MS;
  const maxCalls = input.max_calls ?? DEFAULT_SCRIPT_CALLS;
  const scope = currentScope();
  const nested: CallContext = {
    ...(callCtx.signal ? { signal: callCtx.signal } : {}),
    caller: CORE_PACK_ID,
    depth: (callCtx.depth ?? 0) + 1,
  };
  let calls = 0;
  const slots = new CallSlots(MAX_SCRIPT_IN_FLIGHT, MAX_NESTED_LONG_RUNNING);
  const child = spawnScriptChild();
  track(child);
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const end = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(boot);
      clearTimeout(timer);
      callCtx.signal?.removeEventListener("abort", onAbort);
      liveChildren.delete(child);
      child.kill("SIGKILL");
      fn();
    };
    const timedOut = () =>
      end(() => reject(new ScriptError("SCRIPT_TIMEOUT", `script ran over ${timeoutMs} ms`)));
    // The script's own clock starts once the child is up and has compiled it.
    const boot = setTimeout(
      () =>
        end(() =>
          reject(
            new ScriptError(
              "SCRIPT_ERROR",
              `script failed: its process did not start within ${SCRIPT_BOOT_TIMEOUT_MS} ms`,
            ),
          ),
        ),
      SCRIPT_BOOT_TIMEOUT_MS,
    );
    const onAbort = () =>
      end(() => reject(new ScriptError("SCRIPT_CANCELLED", "script cancelled")));
    if (callCtx.signal?.aborted) {
      onAbort();
      return;
    }
    callCtx.signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) =>
      end(() => reject(new ScriptError("SCRIPT_ERROR", `script failed: ${e.message}`))),
    );
    child.on("exit", () =>
      end(() =>
        reject(
          new ScriptError(
            "SCRIPT_ERROR",
            "script stopped before it finished (it may have run out of memory)",
          ),
        ),
      ),
    );
    const toChild = (msg: object) => {
      if (settled || !child.connected) return;
      try {
        child.send(msg);
      } catch {
        // The child is gone; its exit settles the run.
      }
    };
    toChild({
      type: "start",
      code: input.code,
      bootstrap: BOOTSTRAP,
      maxOut: MAX_SCRIPT_OUTPUT_BYTES,
      syncTimeout: Math.min(timeoutMs, MAX_SCRIPT_TIMEOUT_MS),
    });
    child.on("message", (raw: unknown) => {
      if (raw === null || typeof raw !== "object") return;
      const m = raw as Record<string, unknown>;
      if (m.type === "ready") {
        if (timer === undefined && !settled) {
          clearTimeout(boot);
          timer = setTimeout(timedOut, timeoutMs);
        }
        return;
      }
      if (m.type === "done") {
        const out = String(m.out);
        const logs = String(m.logs);
        if (Buffer.byteLength(out) + Buffer.byteLength(logs) > MAX_SCRIPT_OUTPUT_BYTES) {
          end(() =>
            reject(
              new ScriptError(
                "SCRIPT_OUTPUT_LIMIT",
                `script output is over ${MAX_SCRIPT_OUTPUT_BYTES} bytes`,
              ),
            ),
          );
          return;
        }
        let result: unknown;
        try {
          result = JSON.parse(out);
        } catch {
          end(() =>
            reject(new ScriptError("SCRIPT_ERROR", "script failed: its result is not valid JSON")),
          );
          return;
        }
        end(() => resolve({ result, logs, calls }));
        return;
      }
      if (m.type === "timeout") {
        timedOut();
        return;
      }
      if (m.type === "error") {
        end(() => reject(new ScriptError("SCRIPT_ERROR", `script failed: ${String(m.message)}`)));
        return;
      }
      if (m.type !== "call") return;
      const id = m.id;
      const reply = (msg: { json: string } | { error: string }) => {
        toChild({ id, ...msg });
      };
      const name = String(m.name);
      if (++calls > maxCalls) {
        reply({ error: `tools.call limit reached (${maxCalls} calls)` });
        return;
      }
      if (SCRIPT_REFUSED.has(name)) {
        reply({ error: `${name} cannot be called from a script` });
        return;
      }
      let args: unknown;
      try {
        args = JSON.parse(String(m.args));
      } catch {
        reply({ error: "tools.call arguments must be JSON-serialisable" });
        return;
      }
      // A person's approval of whatever started this script covered that
      // call, not the calls the script makes: each one is checked on its own.
      const run = () => runNotPreApproved(() => deps.call(name, args, nested));
      const heavy = isHeavyTool(name, deps.tools?.());
      slots.run(heavy, () =>
        (scope ? requestScope.run(scope, run) : run()).then(
          (env) => {
            const json = JSON.stringify(env) ?? "null";
            if (Buffer.byteLength(json) > MAX_SCRIPT_OUTPUT_BYTES * 4) {
              reply({ error: `the result of ${name} is too large to hand to a script` });
            } else reply({ json });
          },
          (e: unknown) => reply({ error: e instanceof Error ? e.message : String(e) }),
        ),
      );
    });
  });
}

export function scriptTools(deps: ScriptToolDeps): RegisteredTool[] {
  return [
    {
      name: CODE_MODE_TOOL,
      packId: CORE_PACK_ID,
      origin: "native",
      description:
        "Run a short JavaScript snippet (the body of an async function) that chains tool calls with `await tools.call(name, args)`; each call returns {ok, result} or {ok: false, error}. No require, process, import, network or file access, only the tools in this profile. Limited time, number of calls and output size. Return a JSON-serialisable value.",
      inputSchema: toolInputJsonSchema(ScriptInput),
      annotations: { title: "Run tool script", readOnlyHint: false, openWorldHint: true },
      tags: ["core", "code-mode"],
      requiresSecrets: [],
      longRunning: true,
      input: ScriptInput,
      run: (input, callCtx) => runScript(deps, input as ScriptArgs, callCtx),
    },
  ];
}
