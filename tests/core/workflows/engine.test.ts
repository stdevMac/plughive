// The workflow engine: recipe schema and compile errors, templating and
// conditions (types, missing paths, caps, injection), and the runner through
// the real PackLoader with mock tools: forEach, parallel groups, concurrency,
// onError, limits, cancellation, the runtime limit, pre-flight, load-time
// permission checks, no retries, and the recursion limit.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { evaluate, parseCondition, parseOperand } from "../../../src/core/workflows/expr.js";
import {
  RecipeError,
  WORKFLOW_LIMITS,
  WorkflowError,
  parseRecipe,
  runRecipe,
} from "../../../src/core/workflows/index.js";
import { capOutput, collectArtifacts } from "../../../src/core/workflows/runner.js";
import { recipeInputZod } from "../../../src/core/workflows/schema.js";
import { TemplateError, compileValue, resolveValue } from "../../../src/core/workflows/template.js";
import {
  type LoaderHarness,
  MockTools,
  bootLoader,
  recipe,
  runOk,
  writeMockPack,
  writeWorkflowPack,
} from "./support.js";

type Obj = Record<string, unknown>;

const ROOTS = new Set(["input", "steps"]);
const LIMITS = { maxStringChars: 100_000 };
const resolve = (v: unknown, input: Obj, steps: Obj = {}, limits = LIMITS) =>
  resolveValue(compileValue(v, ROOTS, "test"), { roots: { input, steps } }, limits);
const parse = (r: unknown, name?: string) => parseRecipe(JSON.stringify(r), name);
const items = {
  type: "object",
  properties: { items: { type: "array", items: { type: "string" } } },
  required: [],
};
const testPack = { tools: [{ name: "echo" }, { name: "boom" }] };

// --- schema and compile -------------------------------------------------------------

describe("recipe schema", () => {
  const ok = (steps: unknown[], extra: Obj = {}) => recipe("demo", steps, extra);

  it("compiles a valid recipe into the wf_ tool", () => {
    const c = parse(ok([{ id: "a", set: 1 }]), "demo");
    expect(c.toolName).toBe("wf_demo");
  });

  it.each([
    ["a name that is not snake_case", recipe("Bad-Name", [{ id: "a", set: 1 }]), /name/],
    [
      "two kinds in one step",
      ok([{ id: "a", tool: "echo", set: 1 }]),
      /exactly one of tool, capability, set, save or parallel/,
    ],
    ["no kind", ok([{ id: "a" }]), /exactly one of/],
    [
      "a group with forEach",
      ok([{ id: "g", parallel: [{ id: "a", set: 1 }], forEach: "${input.x}" }]),
      /group step "g" cannot use forEach/,
    ],
    [
      "a reserved forEach variable",
      ok([{ id: "a", set: 1, forEach: "${input.x}", as: "input" }]),
      /reserved/,
    ],
    ["as without forEach", ok([{ id: "a", set: 1, as: "it" }]), /forEach/],
    ["args on a set step", ok([{ id: "a", set: 1, args: {} }]), /args/],
    ["parse on a set step", ok([{ id: "a", set: 1, parse: "json" }]), /parse/],
    ["an unknown field", ok([{ id: "a", set: 1, retries: 3 }]), /retries|Unrecognized|unknown/i],
    ["a step id that is not snake_case", ok([{ id: "Fetch", set: 1 }]), RecipeError],
    [
      "a fallback with a fallback",
      ok([
        {
          id: "a",
          tool: "echo",
          onError: {
            fallback: { id: "b", tool: "echo", onError: { fallback: { id: "c", set: 1 } } },
          },
        },
      ]),
      RecipeError,
    ],
    [
      "an uppercase input property",
      ok([{ id: "a", set: 1 }], {
        input: { type: "object", properties: { Topic: { type: "string" } } },
      }),
      /snake_case/,
    ],
    [
      "a reserved dry_run input",
      ok([{ id: "a", set: 1 }], {
        input: { type: "object", properties: { dry_run: { type: "boolean" } } },
      }),
      /dry_run/,
    ],
    [
      "a runtime limit under 10 s",
      ok([{ id: "a", set: 1 }], { limits: { timeoutSeconds: 5 } }),
      /timeoutSeconds/,
    ],
    [
      "more steps than the limit",
      ok(Array.from({ length: 41 }, (_, i) => ({ id: `s${i}`, set: i }))),
      /steps/,
    ],
    [
      "an unknown step reference",
      ok([{ id: "a", set: "${steps.nope.x}" }]),
      /there is no step "nope"/,
    ],
    [
      "a reference to a later step",
      ok([
        { id: "a", set: "${steps.b}" },
        { id: "b", set: 1 },
      ]),
      /there is no step "b"/,
    ],
    [
      "group members reading each other",
      ok([
        {
          id: "g",
          parallel: [
            { id: "a", set: 1 },
            { id: "b", set: "${steps.a}" },
          ],
        },
      ]),
      /not available here/,
    ],
    [
      "a duplicate step id",
      ok([
        { id: "a", set: 1 },
        { id: "a", set: 2 },
      ]),
      /used twice/,
    ],
    ["an unknown root", ok([{ id: "a", set: "${process.env}" }]), RecipeError],
    ["an unknown helper", ok([{ id: "a", set: "${run_code('1')}" }]), RecipeError],
    [
      "available() outside a condition",
      ok([{ id: "a", set: "${available('echo')}" }]),
      RecipeError,
    ],
    ["a broken condition", ok([{ id: "a", set: 1, when: "input.x ==" }]), RecipeError],
  ])("rejects %s", (_label, r, expected) => {
    expect(() => parse(r)).toThrow(expected as RegExp);
  });

  it("rejects a name that does not match its file", () => {
    expect(() => parse(ok([{ id: "a", set: 1 }]), "other")).toThrow(
      /must match the file name "other.json"/,
    );
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseRecipe("{", "demo")).toThrow(/not valid JSON/);
  });

  it("rejects a __proto__ key in step arguments", () => {
    const text = JSON.stringify(ok([{ id: "a", tool: "echo", args: { x: 1 } }])).replace(
      '"x":1',
      '"__proto__":{"polluted":true}',
    );
    expect(() => parseRecipe(text)).toThrow(
      /recipe\.steps\.0\.args: the key "__proto__" is not allowed/,
    );
    expect(({} as Obj).polluted).toBeUndefined();
  });
});

// --- templates ------------------------------------------------------------------------

describe("templates", () => {
  const input = { n: 5, flag: false, obj: { a: [1, 2], b: "x" }, s: "hello", list: ["a", "b"] };

  it("keeps the type of a whole-string template", () => {
    expect(resolve("${input.n}", input)).toBe(5);
    expect(resolve("${input.flag}", input)).toBe(false);
    expect(resolve("${input.obj}", input)).toEqual(input.obj);
    expect(resolve("${input.obj.a.1}", input)).toBe(2);
    expect(resolve({ k: ["${input.list}", "${input.n}"] }, input)).toEqual({ k: [["a", "b"], 5] });
  });

  it("stringifies embedded templates", () => {
    expect(resolve("n=${input.n} ok=${input.flag}", input)).toBe("n=5 ok=false");
    expect(resolve("${json(input.obj)}", input)).toBe('{"a":[1,2],"b":"x"}');
    expect(resolve("${join(input.list, '+')}", input)).toBe("a+b");
  });

  it("drops a key or element whose whole-string template has no value", () => {
    expect(resolve({ a: "${input.missing}", b: 1 }, input)).toEqual({ b: 1 });
    expect(resolve(["${input.missing.deep}", "${input.s}"], input)).toEqual(["hello"]);
    expect(resolve("${default(input.missing, 'fallback')}", input)).toBe("fallback");
  });

  it("refuses an embedded template that has no value", () => {
    expect(() => resolve("Topic: ${input.missing}", input)).toThrow(/has no value/);
  });

  it("caps the size of a produced string", () => {
    const tiny = { maxStringChars: 10 };
    expect(() => resolve("${input.s}${input.s}${input.s}", input, {}, tiny)).toThrow(
      /over the 10 limit/,
    );
    expect(resolve("${truncate(input.big, 4)}", { big: "x".repeat(11) }, {}, tiny)).toHaveLength(4);
  });

  it("never evaluates code or reaches prototypes", () => {
    for (const src of [
      "${constructor.constructor('return process')()}",
      "${constructor.constructor}",
      "${input.constructor.constructor}",
      "${input.__proto__}",
      "${input.obj.prototype}",
      "${steps.a.__proto__.x}",
    ]) {
      expect(() => compileValue(src, ROOTS, "t"), src).toThrow(TemplateError);
    }
    expect(() => compileValue(JSON.parse('{"__proto__": "${input.s}"}'), ROOTS, "t")).toThrow(
      /not allowed/,
    );
  });

  it("pick reads own keys only", () => {
    const voices = { a: "sam" };
    expect(resolve("${pick(input.v, 'a')}", { v: voices })).toBe("sam");
    expect(resolve("${pick(input.v, input.k)}", { v: voices, k: "__proto__" })).toBeUndefined();
    expect(resolve("${pick(input.v, input.k)}", { v: voices, k: "toString" })).toBeUndefined();
  });

  it("treats template text inside values as data", () => {
    expect(resolve("${input.s}", { s: "${input.secret}", secret: "nope" })).toBe("${input.secret}");
    expect(resolve("say ${input.s}", { s: "${constructor}" })).toBe("say ${constructor}");
  });

  it("helpers: slice, at, pluck, compact, concat, length, number, string", () => {
    const shots = [{ p: "a" }, { p: "b" }, { q: 1 }];
    expect(resolve("${slice(input.shots, 0, 2)}", { shots })).toEqual(shots.slice(0, 2));
    expect(resolve("${compact(pluck(input.shots, 'p'))}", { shots })).toEqual(["a", "b"]);
    expect(resolve("${at(input.shots, 1)}", { shots })).toEqual({ p: "b" });
    expect(resolve("${concat(input.a, input.b)}", { a: ["x"], b: ["y"] })).toEqual(["x", "y"]);
    expect(resolve("${length(input.shots)}", { shots })).toBe(3);
    expect(resolve("${number('42')}", {})).toBe(42);
    expect(resolve("${string(input.n)}", { n: 7 })).toBe("7");
  });
});

describe("size limits on shared values (D-H3)", () => {
  // One 1 KB object held 2000 times: small in memory, 2 MB once written out.
  const shared = () => Array.from({ length: 2000 }, () => SHARED);
  const SHARED = { s: "x".repeat(1000) };

  it("json() and embedded templates refuse a large value before writing it out", () => {
    const spy = vi.spyOn(JSON, "stringify");
    try {
      expect(() => resolve("${json(input.many)}", { many: shared() })).toThrow(/too large/);
      expect(() => resolve("many: ${input.many}", { many: shared() })).toThrow(/too large/);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("join() stops as soon as its text passes the limit", () => {
    // 600 million characters joined: past the longest string V8 can hold.
    const many = new Array<string>(600_000).fill("y".repeat(1000));
    expect(() => resolve("${join(input.many, '')}", { many })).toThrow(/join\(\) result too large/);
  });

  it("concat() refuses a list longer than 10000 items", () => {
    const a = Array.from({ length: 6000 }, (_, i) => i);
    expect(() => resolve("${concat(input.a, input.a)}", { a })).toThrow(/longer than 10000 items/);
    expect(resolve("${concat(input.a, input.b)}", { a, b: [1] })).toHaveLength(6001);
  });

  it("a step output is measured without writing it out, and a cycle counts as too large", () => {
    const spy = vi.spyOn(JSON, "stringify");
    try {
      expect(capOutput(shared())).toMatchObject({ truncated: true, artifacts: [] });
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    const loop: Obj = { a: 1 };
    loop.self = loop;
    expect(capOutput(loop)).toMatchObject({ truncated: true, bytes: null });
    expect(capOutput({ a: [1, 2] })).toEqual({ a: [1, 2] });
  });

  it("collectArtifacts walks an object held in many places once", () => {
    let reads = 0;
    const art = {
      get id() {
        reads++;
        return "img_abcdef";
      },
      mime: "image/png",
    };
    let v: unknown = art;
    for (let i = 0; i < 6; i++) v = Array.from({ length: 6 }, () => v);
    expect([...collectArtifacts(v).keys()]).toEqual(["img_abcdef"]);
    expect(reads).toBeLessThanOrEqual(2);
  });
});

describe("conditions", () => {
  const cond = (src: string, input: Obj, available: (t: string) => boolean = () => false) =>
    evaluate(parseCondition(src, ROOTS), { roots: { input, steps: {} }, available });

  it("compares, negates and combines", () => {
    expect(cond("input.hosts == 2", { hosts: 2 })).toBe(true);
    expect(cond("input.hosts != 2", { hosts: 2 })).toBe(false);
    expect(cond("input.media == 'video' && !input.skip", { media: "video" })).toBeTruthy();
    expect(cond("input.a || input.b", { b: "x" })).toBeTruthy();
    expect(cond("!(input.a || input.b)", {})).toBe(true);
    expect(cond("${input.captions}", { captions: true })).toBeTruthy();
    expect(cond("input.x == null", {})).toBe(true);
  });

  it("available() answers from the pre-flight", () => {
    const avail = (t: string) => t === "elevenlabs_dub";
    expect(cond("available('elevenlabs_dub')", {}, avail)).toBe(true);
    expect(cond('!available("elevenlabs_dub") && input.x', { x: 1 }, avail)).toBeFalsy();
    expect(cond("available('other')", {}, avail)).toBe(false);
  });

  it("rejects malformed and unsafe conditions", () => {
    for (const src of [
      "input.a ==",
      "input.a = 1",
      "input.constructor",
      "nope.a",
      "available(input.tool)",
      "input.a; input.b",
    ]) {
      expect(() => parseCondition(src, ROOTS), src).toThrow();
    }
    expect(() => parseOperand("available('x')", ROOTS)).toThrow();
  });
});

// --- the runner through the loader --------------------------------------------------------

const FLOW_TOOLS = ["echo", "boom", "wf_r_self", "wf_r_middle", "wf_r_inner"];

const FLOWS = [
  recipe(
    "r_each",
    [
      {
        id: "each",
        title: "Echo each",
        tool: "echo",
        forEach: "${input.items}",
        as: "it",
        concurrency: 2,
        maxItems: 3,
        paid: true,
        args: { v: "${it}", i: "${index}" },
      },
    ],
    { input: items, output: "${steps.each}" },
  ),
  recipe(
    "r_group",
    [
      {
        id: "read",
        title: "Read side by side",
        parallel: [
          { id: "a", tool: "echo", args: { n: 1 } },
          { id: "b", tool: "echo", args: { n: 2 } },
          { id: "c", tool: "echo", args: { n: 3 } },
        ],
        concurrency: 2,
      },
      { id: "sum", set: { a: "${steps.a.n}", c: "${steps.c}" } },
    ],
    { output: "${steps.sum}" },
  ),
  recipe(
    "r_errors",
    [
      { id: "x", tool: "boom", onError: "continue" },
      {
        id: "y",
        tool: "boom",
        onError: { fallback: { id: "y_backup", tool: "echo", args: { fallback: true } } },
      },
      { id: "z", tool: "boom", forEach: "${input.items}", onError: "continue" },
      {
        id: "out",
        set: { x: "${steps.x}", y: "${steps.y}", backup: "${steps.y_backup}", z: "${steps.z}" },
      },
    ],
    { input: items, output: "${steps.out}" },
  ),
  recipe("r_fail", [
    { id: "one", title: "First", tool: "echo", args: { a: 1 } },
    { id: "two", title: "Second", tool: "boom", args: {} },
    { id: "three", title: "Third", tool: "echo", args: { a: 3 } },
  ]),
  recipe(
    "r_slow",
    [{ id: "slow", tool: "echo", forEach: "${input.items}", args: { v: "${item}" } }],
    { input: items },
  ),
  recipe(
    "r_when",
    [
      { id: "maybe", tool: "echo", args: { x: 1 }, when: "${input.go}" },
      { id: "after", set: "${default(steps.maybe.x, 'skipped')}" },
    ],
    {
      input: { type: "object", properties: { go: { type: "boolean", default: false } } },
      output: "${steps.after}",
    },
  ),
  recipe("r_big_out", [{ id: "a", tool: "echo", args: {} }], {
    output: Array.from({ length: 8 }, () => "${steps.a}"),
  }),
  recipe("r_self", [{ id: "again", tool: "wf_r_self", args: {} }]),
  recipe("r_outer", [{ id: "down", tool: "wf_r_middle", args: {} }]),
  recipe("r_middle", [{ id: "down", tool: "wf_r_inner", args: {} }], {
    output: "${steps.down.output}",
  }),
  recipe("r_inner", [{ id: "leaf", set: "inner ran" }], { output: "${steps.leaf}" }),
];

let h: LoaderHarness;
let mock: MockTools;

beforeAll(async () => {
  h = await bootLoader({
    packs: [],
    bundled: false,
    seed(b) {
      writeMockPack(b, "testtools", testPack);
      writeWorkflowPack(b, FLOWS, { id: "flows", tools: [...FLOW_TOOLS, "wf_r_outer"] });
      const strict = writeWorkflowPack(
        b,
        [
          recipe("ok_one", [{ id: "a", tool: "echo", args: {} }]),
          recipe("bad_one", [{ id: "a", tool: "boom", args: {} }]),
        ],
        { id: "strict", tools: ["echo"] },
      );
      writeFileSync(join(strict, "workflows", "broken.json"), "{");
      writeFileSync(
        join(strict, "workflows", "misnamed.json"),
        JSON.stringify(recipe("other_name", [{ id: "a", set: 1 }])),
      );
    },
  });
});
afterAll(async () => h?.close());
beforeEach(() => {
  mock = new MockTools().install();
  mock.handlers.echo = (args) => ({ ...args });
  mock.handlers.boom = () => {
    throw new Error("boom: the provider said no");
  };
});

async function fail(
  harness: LoaderHarness,
  name: string,
  input: Obj = {},
  signal?: AbortSignal,
): Promise<string> {
  const env = await harness.call(name, input, signal);
  expect(env.ok).toBe(false);
  return env.error?.message ?? "";
}

describe("loading", () => {
  it("a recipe that calls an undeclared tool, or does not parse, disables only itself", async () => {
    const strict = (await h.loader.listPacks()).find((p) => p.id === "strict") as Obj | undefined;
    expect(strict?.state).toBe("loaded");
    expect(strict?.workflows).toEqual(["ok_one"]);
    const errors = Object.fromEntries(
      ((strict?.workflowErrors ?? []) as { name: string; error: string }[]).map((e) => [
        e.name,
        e.error,
      ]),
    );
    expect(errors.bad_one).toMatch(
      /uses the tool boom, which permissions.tools of the strict pack does not declare/,
    );
    expect(errors.broken).toMatch(/not valid JSON/);
    expect(errors.misnamed).toMatch(/must match the file name/);
    expect(h.registry.get("wf_ok_one")).toBeDefined();
    expect(h.registry.get("wf_bad_one")).toBeUndefined();
    await runOk(h, "wf_ok_one", {});
  });

  it("registers every flow as a long-running workflow tool of its pack", () => {
    const t = h.registry.get("wf_r_each") as Obj | undefined;
    expect(t).toMatchObject({ origin: "workflow", longRunning: true });
  });

  it("rejects input that does not match the recipe's schema", async () => {
    const env = await h.call("wf_r_each", { items: "not a list" });
    expect(env.ok).toBe(false);
    expect(mock.calls).toEqual([]);
  });
});

describe("forEach and parallel", () => {
  it("runs the items in order, at most `concurrency` at once, up to maxItems", async () => {
    mock.delayMs = 20;
    const r = await runOk(h, "wf_r_each", { items: ["a", "b", "c", "d", "e"] });
    expect(r.output).toEqual([
      { v: "a", i: 0 },
      { v: "b", i: 1 },
      { v: "c", i: 2 },
    ]);
    expect(mock.calls).toHaveLength(3);
    expect(mock.maxInFlight).toBe(2);
    expect(r.notes).toEqual(["each: ran the first 3 of 5 items (the limit)"]);
    expect((r.steps as Obj[])[0]).toMatchObject({ id: "each", status: "ok" });
  });

  it("an empty list runs nothing", async () => {
    const r = await runOk(h, "wf_r_each", { items: [] });
    expect(r.output).toEqual([]);
    expect(mock.calls).toEqual([]);
  });

  it("dry run counts known items at the cap", async () => {
    const plan = await runOk(h, "wf_r_each", { items: ["a", "b", "c", "d", "e"], dry_run: true });
    expect(plan.dry_run).toBe(true);
    expect(plan.paid_calls_max).toBe(3);
    expect((plan.steps as Obj[])[0]).toMatchObject({ id: "each", calls: 3, paid: true });
    expect(mock.calls).toEqual([]);
  });

  it("a parallel group runs its members side by side and exposes each output", async () => {
    mock.delayMs = 20;
    const r = await runOk(h, "wf_r_group", {});
    expect(mock.maxInFlight).toBe(2);
    expect(mock.calls).toHaveLength(3);
    expect(r.output).toEqual({ a: 1, c: { n: 3 } });
  });
});

describe("run output limit (D-H3)", () => {
  it("a run output over 1 MB keeps its artifact ids only", async () => {
    mock.handlers.echo = () => ({ text: "z".repeat(200_000) });
    const r = await runOk(h, "wf_r_big_out", {});
    expect(r.output).toMatchObject({ truncated: true });
    expect(WORKFLOW_LIMITS.maxOutputBytes).toBe(1024 * 1024);
  });
});

describe("onError and conditions", () => {
  it("continue skips the output, fallback stands in for it", async () => {
    const r = await runOk(h, "wf_r_errors", { items: ["p", "q"] });
    expect(mock.order()).toEqual(["boom", "boom", "echo", "boom", "boom"]);
    expect(r.output).toEqual({
      y: { fallback: true },
      backup: { fallback: true },
      z: [null, null],
    });
    const status = Object.fromEntries(
      (r.steps as { id: string; status: string }[]).map((s) => [s.id, s.status]),
    );
    expect(status).toMatchObject({ x: "continued", y: "fallback", out: "ok" });
  });

  it("a condition decides whether a step runs", async () => {
    expect((await runOk(h, "wf_r_when", {})).output).toBe("skipped");
    expect(mock.calls).toEqual([]);
    expect((await runOk(h, "wf_r_when", { go: true })).output).toBe(1);
    const plan = await runOk(h, "wf_r_when", { dry_run: true });
    expect((plan.steps as Obj[])[0]).toMatchObject({ id: "maybe", runs: "no" });
  });
});

describe("failure and recursion", () => {
  it("stops at the failing step without retrying and lists what completed", async () => {
    const message = await fail(h, "wf_r_fail");
    expect(mock.order()).toEqual(["echo", "boom"]);
    const lines = message.split("\n");
    expect(lines[0]).toContain('failed at step 2 of 3 "two" (Second): boom: the provider said no');
    expect(lines).toContain("Nothing was retried.");
    expect(lines.some((l) => l.startsWith("Completed: one"))).toBe(true);
    const detail = JSON.parse(lines.find((l) => l.startsWith("Detail: "))?.slice(8) ?? "{}");
    expect(detail.failed).toMatchObject({ id: "two" });
    expect(detail.completed.map((c: Obj) => c.id)).toEqual(["one"]);
  });

  it("a recipe cannot run itself", async () => {
    expect(await fail(h, "wf_r_self")).toMatch(/wf_r_self cannot run itself/);
  });

  it("workflows nest at most two deep", async () => {
    expect((await runOk(h, "wf_r_middle", {})).output).toBe("inner ran");
    expect(await fail(h, "wf_r_outer")).toMatch(
      /workflows nest at most 2 deep \(wf_r_outer > wf_r_middle > wf_r_inner\)/,
    );
  });
});

describe("cancellation, the runtime limit and progress", () => {
  it("cancelling stops the run", async () => {
    mock.delayMs = 40;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    const message = await fail(h, "wf_r_slow", { items: ["a", "b", "c", "d"] }, ac.signal);
    expect(message).toMatch(/cancel/i);
    expect(mock.calls.length).toBeLessThan(4);
  });

  it("the runtime limit stops the run with its own message", async () => {
    const c = parse(
      recipe(
        "limited",
        [
          { id: "a", title: "Long call", tool: "echo", args: {} },
          { id: "b", tool: "echo", args: {} },
        ],
        { limits: { timeoutSeconds: 10 } },
      ),
    );
    const timeout = new AbortController();
    const calls: string[] = [];
    const ctx = {
      signal: timeout.signal,
      progress() {},
      tools: {
        async call(name: string) {
          calls.push(name);
          timeout.abort();
          return { ok: true, result: {} };
        },
      },
    };
    const run = runRecipe(
      c,
      {},
      { ctx: ctx as never, available: new Map(), timeout: timeout.signal },
    );
    await expect(run).rejects.toThrow(WorkflowError);
    await expect(run).rejects.toThrow(/stopped: it ran past its 10 s limit/);
    expect(calls).toEqual(["echo"]);
  });

  it("reports progress as step i of n: title", async () => {
    const c = parse(
      recipe(
        "progress",
        [
          { id: "a", title: "Plan it", set: 1 },
          { id: "b", title: "Echo each", tool: "echo", forEach: "${input.items}", args: {} },
          { id: "c", set: 2 },
        ],
        { input: items },
      ),
    );
    const labels: string[] = [];
    const ctx = {
      signal: new AbortController().signal,
      progress(_f: number, label: string) {
        labels.push(label);
      },
      tools: { call: async () => ({ ok: true, result: {} }) },
    };
    await runRecipe(c, { items: ["x", "y"] }, { ctx: ctx as never, available: new Map() });
    expect(labels[0]).toBe("step 1 of 3: Plan it");
    expect(labels).toContain("step 2 of 3: Echo each (2 of 2)");
    expect(labels.at(-1)).toBe("done");
  });
});

describe("pre-flight", () => {
  let pre: LoaderHarness;
  beforeAll(async () => {
    pre = await bootLoader({
      packs: ["web"],
      bundled: false,
      secrets: {},
      seed(b) {
        writeMockPack(b, "testtools", testPack);
        writeWorkflowPack(
          b,
          [
            recipe("pf_missing", [
              { id: "first", tool: "echo", args: {} },
              { id: "ghost", title: "Ghost", tool: "ghost_tool", args: {} },
            ]),
            recipe("pf_key", [
              {
                id: "read",
                tool: "firecrawl_scrape",
                pack: "web",
                args: { url: "https://example.com" },
              },
            ]),
            recipe(
              "pf_soft",
              [
                { id: "ghost", tool: "ghost_tool", args: {}, onError: "continue" },
                { id: "skipped", tool: "ghost_tool", args: {}, when: "input.go" },
                { id: "echo", tool: "echo", args: { ok: true } },
              ],
              {
                input: { type: "object", properties: { go: { type: "boolean", default: false } } },
                output: "${steps.echo}",
              },
            ),
          ],
          { id: "pf", tools: ["echo", "ghost_tool", "firecrawl_scrape"] },
        );
      },
    });
  });
  afterAll(async () => pre?.close());

  it("a missing tool blocks the run before anything starts", async () => {
    const plan = await runOk(pre, "wf_pf_missing", { dry_run: true });
    expect(plan.ok).toBe(false);
    expect(plan.blocking).toEqual([
      {
        step: "ghost",
        message:
          "the tool ghost_tool is not available: install or enable the pack that provides it",
      },
    ]);
    const env = await pre.call("wf_pf_missing", {});
    expect(env.ok).toBe(false);
    expect(env.error?.message).toMatch(/cannot run yet; nothing was started/);
    expect(env.error?.message).toContain("ghost_tool");
    expect(mock.calls).toEqual([]);
  });

  it("a missing key names the key and the pack", async () => {
    const plan = await runOk(pre, "wf_pf_key", { dry_run: true });
    expect(plan.ok).toBe(false);
    expect((plan.blocking as Obj[])[0]?.message).toBe(
      "the tool firecrawl_scrape needs the key FIRECRAWL_API_KEY of the web pack: set it",
    );
    expect((await pre.call("wf_pf_key", {})).ok).toBe(false);
    expect(mock.calls).toEqual([]);
  });

  it("a step that continues on error, or will not run, does not block", async () => {
    const plan = await runOk(pre, "wf_pf_soft", { dry_run: true });
    expect(plan.ok).toBe(true);
    const r = await runOk(pre, "wf_pf_soft", {});
    expect(r.output).toEqual({ ok: true });
    expect((await runOk(pre, "wf_pf_soft", { go: true, dry_run: true })).ok).toBe(false);
  });

  it("a disabled pack is named, with what to do", async () => {
    await pre.loader.disable("web");
    const plan = await runOk(pre, "wf_pf_key", { dry_run: true });
    expect((plan.blocking as Obj[])[0]?.message).toBe(
      "the tool firecrawl_scrape needs the web pack, which is disabled: enable it",
    );
  });
});

describe("recipe input schema", () => {
  it("additionalProperties: false makes unknown input keys an error, not silently stripped", () => {
    const strict = recipeInputZod({
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
      additionalProperties: false,
    });
    expect(strict.safeParse({ topic: "x", extra: 1 }).success).toBe(false);
    expect(strict.safeParse({ topic: "x", dry_run: true }).success).toBe(true);
    // Without the flag the old behaviour stands: unknown keys are stripped.
    const loose = recipeInputZod({
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    });
    const parsed = loose.parse({ topic: "x", extra: 1 });
    expect(parsed).toEqual({ topic: "x" });
  });
});
