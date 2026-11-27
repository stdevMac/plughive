// run_tool_script: nothing from the host realm reaches the snippet, so the
// classic node:vm escapes (`x.constructor.constructor("return process")()`)
// fail on every value and callback a script can touch.
import { describe, expect, it } from "vitest";
import { type ScriptArgs, runScript } from "../../../src/core/tools/builtin/script.js";
import type { ToolEnvelope } from "../../../src/core/tools/registry.js";

const deps = {
  call: async (name: string, args: unknown): Promise<ToolEnvelope> => {
    if (name === "throw") throw new Error("host failure");
    return { ok: true, result: { name, args } };
  },
};
const run = (code: string, extra: Partial<ScriptArgs> = {}) => runScript(deps, { code, ...extra });

// Each probe returns "escaped" when it reaches the host's process object.
const probe = (expr: string) => `
  const v = ${expr};
  const tries = [];
  const seen = new Set();
  const walk = (x, depth) => {
    if (x === null || x === undefined || depth > 3 || seen.has(x)) return;
    if (typeof x !== "object" && typeof x !== "function") return;
    seen.add(x);
    tries.push(x);
    try { walk(Object.getPrototypeOf(x), depth + 1); } catch {}
    for (const k of ["constructor", "__proto__", "cause", "stack", "then"]) {
      try { walk(x[k], depth + 1); } catch {}
    }
  };
  walk(v, 0);
  for (const x of tries) {
    try {
      const F = x.constructor && x.constructor.constructor;
      const p = F && F("return process")();
      if (p && p.pid) return "escaped";
    } catch {}
    try {
      const p = typeof x === "function" ? x.constructor("return process")() : null;
      if (p && p.pid) return "escaped";
    } catch {}
  }
  return "contained:" + tries.length;
`;

describe("run_tool_script: realm isolation", () => {
  it("a rejected tools.call gives an in-realm Error (refused tool)", async () => {
    const out = await run(`
      let e;
      try { await tools.call("batch_run", {}); } catch (err) { e = err; }
      ${probe("e")}
    `);
    expect(out.result).toMatch(/^contained/);
  });

  it("a rejected tools.call gives an in-realm Error (host throws, bad args, call limit)", async () => {
    for (const call of [
      'tools.call("throw", {})',
      'tools.call("x", { b: 1n })',
      'tools.call("x", {}).then(() => tools.call("x", {}))',
    ]) {
      const out = await run(
        `
        let e;
        try { await ${call}; } catch (err) { e = err; }
        if (e === undefined) return "no error";
        if (!(e instanceof Error)) return "foreign error";
        ${probe("e")}
      `,
        { max_calls: 1 },
      );
      expect(out.result, call).toMatch(/^contained/);
    }
  });

  it("the promise tools.call returns and its result are in-realm", async () => {
    const out = await run(`
      const p = tools.call("echo", { a: 1 });
      if (!(p instanceof Promise)) return "foreign promise";
      const r = await p;
      if (Object.getPrototypeOf(r) !== Object.prototype) return "foreign result";
      ${probe("[p, r, tools, tools.call, console, console.log]")}
    `);
    expect(out.result).toMatch(/^contained/);
  });

  it("errors raised by a deep stack at the bridge stay in-realm", async () => {
    const out = await run(`
      let caught = [];
      const deep = (n) => {
        try { return deep(n + 1); }
        catch (e) {
          try { tools.call("echo", {}).catch((x) => caught.push(x)); } catch (x) { caught.push(x); }
          caught.push(e);
          return n;
        }
      };
      deep(0);
      await new Promise((r) => r());
      await tools.call("echo", {}).catch(() => {});
      ${probe("caught")}
    `);
    expect(out.result).toMatch(/^contained/);
  });

  it("cannot reach a host function through Function.prototype.caller", async () => {
    const out = await run(`
      const found = [];
      function sloppy() { try { found.push(sloppy.caller); } catch {} return {}; }
      const thenable = { then(res) { sloppy(); res(1); } };
      await tools.call("echo", {}).then(sloppy);
      ${probe("found")}
    `);
    expect(out.result).toMatch(/^contained/);
  });
});

describe("run_tool_script: results that are not JSON", () => {
  it("a function, symbol or toJSON-undefined result is null, not a crash", async () => {
    for (const code of [
      "return () => {}",
      "return Symbol('x')",
      "return { toJSON() { return undefined; } }",
      "return undefined",
    ]) {
      const out = await run(code);
      expect(out.result, code).toBeNull();
    }
  });

  it("a result JSON cannot encode is a clean script error", async () => {
    await expect(run("return 1n")).rejects.toMatchObject({ code: "SCRIPT_ERROR" });
    await expect(run("const a = {}; a.a = a; return a")).rejects.toMatchObject({
      code: "SCRIPT_ERROR",
    });
  });
});
