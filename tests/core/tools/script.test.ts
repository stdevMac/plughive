// run_tool_script (code mode): off by default, chains tool calls through the
// scoped path, and enforces its limits (time, calls, output) with no require,
// process, import() or eval inside the snippet.
import { once } from "node:events";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { requestScope } from "../../../src/core/mcp/scope.js";
import { CORE_TOOL_NAMES, coreTools } from "../../../src/core/tools/builtin/index.js";
import {
  CODE_MODE_TOOL,
  type ScriptArgs,
  ScriptError,
  runScript,
  scriptChildArgs,
  scriptChildPids,
  scriptTools,
  spawnScriptChild,
} from "../../../src/core/tools/builtin/script.js";
import { type CallContext, ToolRegistry } from "../../../src/core/tools/registry.js";
import { loadConfig } from "../../../src/lib/config.js";
import { mockTool } from "../../http/harness.js";

function setup() {
  const registry = new ToolRegistry();
  registry.registerPack("demo", [
    mockTool("add", async (i) => ({ sum: (i.a as number) + (i.b as number) }), {
      input: z.object({ a: z.number(), b: z.number() }),
    }),
    mockTool("boom", async () => {
      throw new Error("kaboom");
    }),
  ]);
  const deps = {
    call: (name: string, args: unknown, ctx?: CallContext) => registry.call(name, args, ctx),
  };
  registry.registerPack("core", scriptTools(deps));
  const run = (args: Partial<ScriptArgs> & { code: string }, ctx?: CallContext) =>
    runScript(deps, args, ctx);
  return { registry, run };
}

describe("run_tool_script: switch", () => {
  it("is off by default and on with PLUGHIVE_CODE_MODE=1", () => {
    expect(loadConfig({ env: {} }).codeMode).toBe(false);
    expect(loadConfig({ env: { PLUGHIVE_CODE_MODE: "0" } }).codeMode).toBe(false);
    expect(loadConfig({ env: { PLUGHIVE_CODE_MODE: "1" } }).codeMode).toBe(true);
    expect(CORE_TOOL_NAMES).not.toContain(CODE_MODE_TOOL);
    const base = {
      library: {} as never,
      importRoots: [],
      urlFor: (id: string) => id,
      jobs: {} as never,
      usage: {} as never,
      packs: {} as never,
      mounts: {} as never,
      capabilities: { list: () => [] },
      tools: () => [],
      daemon: { version: "0", bindHost: "127.0.0.1", authRequired: false, importRoots: 0 },
      batch: { call: async () => ({ ok: true as const, result: null }), tools: () => [] },
    };
    const off = coreTools(base as never).map((t) => t.name);
    expect(off).not.toContain(CODE_MODE_TOOL);
    const on = coreTools({ ...base, script: { call: base.batch.call } } as never).map(
      (t) => t.name,
    );
    expect(on).toContain(CODE_MODE_TOOL);
  });
});

describe("run_tool_script: running", () => {
  it("chains tool calls and returns the value and console output", async () => {
    const { run } = setup();
    const out = await run({
      code: `
        const a = await tools.call("add", { a: 1, b: 2 });
        const b = await tools.call("add", { a: a.result.sum, b: 10 });
        const bad = await tools.call("boom", {});
        console.log("sum is", b.result.sum);
        return { sum: b.result.sum, badOk: bad.ok, badMsg: bad.error.message };
      `,
    });
    expect(out.result).toEqual({ sum: 13, badOk: false, badMsg: "kaboom" });
    expect(out.logs).toBe("sum is 13");
    expect(out.calls).toBe(3);
  });

  it("runs as a registered long-running core tool returning an envelope", async () => {
    const { registry } = setup();
    expect(registry.get(CODE_MODE_TOOL)?.longRunning).toBe(true);
    const env = await registry.call(CODE_MODE_TOOL, { code: "return 42" });
    expect(env).toMatchObject({ ok: true, result: { result: 42 } });
    const failed = await registry.call(CODE_MODE_TOOL, { code: "throw new Error('nope')" });
    expect(failed).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("nope") },
    });
  });

  it("has no require, process, import() or eval", async () => {
    const { run } = setup();
    const out = await run({
      code: "return [typeof require, typeof process, typeof module, typeof fetch, typeof setTimeout]",
    });
    expect(out.result).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined"]);
    await expect(run({ code: 'return await import("node:fs")' })).rejects.toThrow(ScriptError);
    await expect(run({ code: 'return eval("1+1")' })).rejects.toThrow(/disallowed/);
    await expect(run({ code: 'return (() => {}).constructor("return 1")()' })).rejects.toThrow(
      /disallowed/,
    );
    // Intrinsics are frozen: the snippet cannot patch them.
    const frozen = await run({
      code: "try { Object.prototype.polluted = 1 } catch (e) {} return [({}).polluted, Object.isFrozen(Array.prototype), Object.isFrozen(tools)]",
    });
    expect(frozen.result).toEqual([null, true, true]);
  });

  it("stops a busy loop at the time limit (sync and after an await)", async () => {
    const { run } = setup();
    await expect(run({ code: "while (true) {}", timeout_ms: 300 })).rejects.toMatchObject({
      code: "SCRIPT_TIMEOUT",
    });
    await expect(
      run({ code: 'await tools.call("add", {a:1,b:1}); while (true) {}', timeout_ms: 400 }),
    ).rejects.toMatchObject({ code: "SCRIPT_TIMEOUT" });
  }, 15_000);

  it("reports a busy loop as a timeout even when the worker's own limit fires first", async () => {
    const { run } = setup();
    // Several at once, so the worker's sync limit and the host timer race.
    const runs = Array.from({ length: 4 }, () => run({ code: "while (true) {}", timeout_ms: 250 }));
    // Every promise gets its handler now: they settle in any order.
    await Promise.all(
      runs.map((r) =>
        expect(r).rejects.toMatchObject({ code: "SCRIPT_TIMEOUT", message: /ran over 250 ms/ }),
      ),
    );
  }, 20_000);

  it("limits the number of tool calls", async () => {
    const { run } = setup();
    const out = await run({
      code: `
        const r = [];
        for (let i = 0; i < 4; i++) {
          try { r.push((await tools.call("add", { a: i, b: 0 })).ok); }
          catch (e) { r.push(e.message); }
        }
        return r;
      `,
      max_calls: 2,
    });
    expect(out.result).toEqual([true, true, expect.stringContaining("limit"), expect.any(String)]);
  });

  it("limits the output size", async () => {
    const { run } = setup();
    await expect(run({ code: 'return "x".repeat(300 * 1024)' })).rejects.toMatchObject({
      code: "SCRIPT_OUTPUT_LIMIT",
    });
    await expect(
      run({ code: 'for (let i = 0; i < 400; i++) console.log("y".repeat(1024)); return 1' }),
    ).rejects.toThrow(/over the limit/);
  });

  it("refuses recursion and stays inside the caller's profile", async () => {
    const { run } = setup();
    const self = await run({
      code: 'try { await tools.call("run_tool_script", { code: "return 1" }) } catch (e) { return e.message }',
    });
    expect(self.result).toContain("cannot be called from a script");
    const scope = { profileId: "narrow", allows: (t: string) => t === CODE_MODE_TOOL };
    const scopedDeps = {
      call: async (name: string, args: unknown) => {
        const allowed = requestScope.getStore()?.allows?.(name) ?? true;
        return allowed
          ? { ok: true as const, result: args }
          : {
              ok: false as const,
              error: { code: "TOOL_ERROR" as const, message: "not in profile", retryable: false },
            };
      },
    };
    const out = await requestScope.run(scope as never, () =>
      runScript(scopedDeps, { code: 'return (await tools.call("add", {a:1,b:2})).ok' }),
    );
    expect(out.result).toBe(false);
  });

  it("stops when the job is cancelled", async () => {
    const { run } = setup();
    const ac = new AbortController();
    const p = run(
      { code: "await new Promise(() => {})", timeout_ms: 10_000 },
      { signal: ac.signal },
    );
    setTimeout(() => ac.abort(), 100);
    await expect(p).rejects.toMatchObject({ code: "SCRIPT_CANCELLED" });
  });
});

// What a vm escape would land in: the child process itself. The probe is
// appended to the real child code and spawned exactly as run_tool_script
// spawns it, so it runs with the same flags, env, cwd and hardening, and
// reports what `process` and `require` can still do there.
describe("run_tool_script: the child process", () => {
  const probe = (target: string, port: number) => `
;(async () => {
  const out = {};
  const t = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = e.code || e.message; } };
  t("read", () => (require("node:fs").readFileSync(${JSON.stringify(target)}, "utf8"), "READ"));
  t("write", () => (require("node:fs").writeFileSync(${JSON.stringify(join(tmpdir(), `plughive-probe-${process.pid}`))}, "x"), "WROTE"));
  t("spawn", () => (require("node:child_process").execFileSync(process.execPath, ["-v"]), "RAN"));
  t("worker", () => (new (require("node:worker_threads").Worker)("1", { eval: true }), "STARTED"));
  t("binding", () => typeof process.binding("fs"));
  t("kill", () => (process.kill(process.ppid, 0), "SIGNALLED"));
  t("priority", () => (require("node:os").setPriority(process.ppid, 0), "SET"));
  t("codegen", () => Function("return 1")());
  out.env = Object.keys(process.env);
  out.cwd = process.cwd();
  out.net = await new Promise((done) => {
    try {
      const s = require("node:net").connect(${port}, "127.0.0.1");
      s.on("connect", () => { s.destroy(); done("CONNECTED"); });
      s.on("error", (e) => done(e.code));
    } catch (e) { done(e.code); }
  });
  process.send({ probe: out });
})();
`;

  it("cannot read or write files, start programs or workers, signal processes, or see the env", async () => {
    const server = createServer((s) => s.destroy()).listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    process.env.PLUGHIVE_PROBE_SECRET = "s3cret";
    try {
      const args = scriptChildArgs();
      args[args.length - 1] += probe(join(process.cwd(), "package.json"), port);
      const child = spawnScriptChild(args);
      const [msg] = (await once(child, "message")) as [{ probe: Record<string, unknown> }];
      child.kill("SIGKILL");
      const out = msg.probe;
      expect(out).toMatchObject({
        read: "ERR_ACCESS_DENIED",
        write: "ERR_ACCESS_DENIED",
        spawn: "ERR_ACCESS_DENIED",
        worker: "ERR_ACCESS_DENIED",
        binding: "ERR_ACCESS_DENIED",
        kill: "not available to a script",
        priority: "not available to a script",
        codegen: expect.stringMatching(/disallowed/),
      });
      // Nothing inherited (macOS adds its own __CF_USER_TEXT_ENCODING).
      expect((out.env as string[]).filter((k) => !k.startsWith("__CF_"))).toEqual([]);
      expect(out.cwd).not.toBe(process.cwd());
      // The permission model covers the network only from Node 25 on.
      if (Number(process.versions.node.split(".")[0]) >= 25) {
        expect(out.net).toBe("ERR_ACCESS_DENIED");
      }
    } finally {
      delete process.env.PLUGHIVE_PROBE_SECRET;
      server.close();
    }
  }, 60_000);

  it("leaves no process behind when a script times out, is cancelled or ends", async () => {
    const { run } = setup();
    const ac = new AbortController();
    const p = run(
      { code: "await new Promise(() => {})", timeout_ms: 60_000 },
      { signal: ac.signal },
    );
    const t = run({ code: "while (true) {}", timeout_ms: 300 });
    const q = run({ code: "return 1" });
    let pids: number[] = [];
    for (let i = 0; i < 200 && pids.length < 3; i++) {
      pids = scriptChildPids();
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(pids.length).toBeGreaterThan(0);
    ac.abort();
    await expect(p).rejects.toMatchObject({ code: "SCRIPT_CANCELLED" });
    await expect(t).rejects.toMatchObject({ code: "SCRIPT_TIMEOUT" });
    await expect(q).resolves.toMatchObject({ result: 1 });
    expect(scriptChildPids()).toEqual([]);
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 100 && pids.some(alive); i++) await new Promise((r) => setTimeout(r, 50));
    expect(pids.filter(alive)).toEqual([]);
  }, 60_000);
});
