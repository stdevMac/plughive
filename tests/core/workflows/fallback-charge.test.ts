// onError.fallback and money: after a paid step fails in a way that does not
// prove nothing was charged, its paid fallback only runs when the recipe says
// so (onError.afterUnknownOutcome). Unpaid fallbacks, and failures that happen
// before anything was sent, keep working as before.
import { CapabilityError, PackPermissionError } from "plughive/pack";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MissingSecretError } from "../../../src/core/secrets/errors.js";
import { WorkflowError, parseRecipe, runRecipe } from "../../../src/core/workflows/index.js";
import { provesNoCharge } from "../../../src/core/workflows/runner.js";
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
const parse = (r: unknown) => parseRecipe(JSON.stringify(r));

/** Runs a one-step recipe whose primary call fails with `error`; records what was called. */
async function runWith(step: Obj, error: unknown, paid?: (id: string) => boolean, input: Obj = {}) {
  const c = parse(recipe("fb", [step], { output: "${steps.first}" }));
  const calls: string[] = [];
  const fail = (name: string) => {
    calls.push(name);
    if (name === "primary" || name === "image.generate") throw error;
    return { from: name };
  };
  const ctx = {
    signal: new AbortController().signal,
    progress() {},
    tools: { call: async (name: string) => fail(name) },
    capabilities: { run: async (name: string) => fail(name) },
  };
  const run = runRecipe(c, input, {
    ctx: ctx as never,
    available: new Map(),
    ...(paid ? { paid: (s) => paid(s.id) } : {}),
  });
  const outcome = await run.then(
    (r) => ({ ok: true as const, output: r.output, steps: r.steps }),
    (e: unknown) => ({ ok: false as const, error: e as Error }),
  );
  return { calls, outcome };
}

const paidPair = (onError: Obj = {}): Obj => ({
  id: "first",
  tool: "primary",
  paid: true,
  args: {},
  onError: { fallback: { id: "second", tool: "backup", paid: true, args: {} }, ...onError },
});

describe("a paid fallback after a paid step", () => {
  it.each([
    ["a plain tool error", new Error("the provider said no")],
    ["a TOOL_ERROR from the registry", Object.assign(new Error("failed"), { code: "TOOL_ERROR" })],
    [
      "an outcome the router called unknown",
      Object.assign(new Error("lost"), { code: "PROVIDER_OUTCOME_UNKNOWN" }),
    ],
    [
      "an error that says it may have charged",
      Object.assign(new Error("lost"), { mayHaveCharged: true }),
    ],
    ["a CapabilityError that is not retryable", new CapabilityError("refused late")],
    [
      "a retryable CapabilityError whose cause may have charged",
      Object.assign(new CapabilityError("x", { retryable: true }), {
        cause: Object.assign(new Error("y"), { mayHaveCharged: true }),
      }),
    ],
  ])("does not run after %s", async (_label, error) => {
    const { calls, outcome } = await runWith(paidPair(), error);
    expect(calls).toEqual(["primary"]);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.error).toBeInstanceOf(WorkflowError);
    expect(outcome.error.message).toMatch(
      /may have been charged, so its paid fallback "second" was not run/,
    );
    expect(outcome.error.message).toMatch(/afterUnknownOutcome/);
  });

  it("runs when the recipe says so with afterUnknownOutcome", async () => {
    const { calls, outcome } = await runWith(
      paidPair({ afterUnknownOutcome: true }),
      new Error("the provider said no"),
    );
    expect(calls).toEqual(["primary", "backup"]);
    expect(outcome).toMatchObject({ ok: true, output: { from: "backup" } });
  });

  it("afterUnknownOutcome: false is the same as leaving it out", async () => {
    const { calls } = await runWith(paidPair({ afterUnknownOutcome: false }), new Error("no"));
    expect(calls).toEqual(["primary"]);
  });

  it.each([
    ["a missing key", new MissingSecretError({ pack: "fal", name: "FAL_KEY" })],
    ["a refused permission", new PackPermissionError("flows", "tool not declared")],
    ["an unknown tool", Object.assign(new Error("no such tool"), { code: "UNKNOWN_TOOL" })],
    ["invalid arguments", Object.assign(new Error("bad input"), { code: "INVALID_ARGUMENTS" })],
    ["no configured provider", new CapabilityError("none", { code: "NO_PROVIDER" })],
    [
      "a provider that asserts nothing was accepted",
      new CapabilityError("busy", { retryable: true }),
    ],
  ])("still runs after %s, which proves nothing was charged", async (_label, error) => {
    const { calls, outcome } = await runWith(paidPair(), error);
    expect(calls).toEqual(["primary", "backup"]);
    expect(outcome.ok).toBe(true);
  });

  it("still runs when the step failed before anything was called", async () => {
    const step = paidPair();
    // The resolved template is longer than a template may produce: the call is never made.
    step.args = { v: "${input.big}${input.big}" };
    const { calls, outcome } = await runWith(step, new Error("unused"), undefined, {
      big: "x".repeat(40_000),
    });
    expect(calls).toEqual(["backup"]);
    expect(outcome.ok).toBe(true);
  });
});

describe("fallbacks that cannot pay twice are unchanged", () => {
  it("an unpaid fallback runs after a paid step", async () => {
    const step = paidPair();
    (step.onError as { fallback: Obj }).fallback.paid = false;
    const { calls, outcome } = await runWith(step, new Error("no"));
    expect(calls).toEqual(["primary", "backup"]);
    expect(outcome.ok).toBe(true);
  });

  it("a paid fallback runs after an unpaid step", async () => {
    const step = paidPair();
    step.paid = false;
    const { calls } = await runWith(step, new Error("no"));
    expect(calls).toEqual(["primary", "backup"]);
  });

  it("a set fallback runs after a paid capability step", async () => {
    const { calls, outcome } = await runWith(
      {
        id: "first",
        capability: "image.generate",
        args: { prompt: "x" },
        onError: { fallback: { id: "second", set: "none" } },
      },
      new Error("no"),
    );
    expect(calls).toEqual(["image.generate"]);
    expect(outcome).toMatchObject({ ok: true, output: "none" });
  });

  it("capability steps are paid by default, so a capability fallback needs the flag", async () => {
    const step = {
      id: "first",
      capability: "image.generate",
      args: { prompt: "x" },
      onError: { fallback: { id: "second", tool: "backup", paid: true, args: {} } },
    };
    expect((await runWith(step, new Error("no"))).calls).toEqual(["image.generate"]);
    const allowed = { ...step, onError: { ...step.onError, afterUnknownOutcome: true } };
    expect((await runWith(allowed, new Error("no"))).calls).toEqual(["image.generate", "backup"]);
  });

  it("the host's paid rule decides (a tool the planner knows is capability backed)", async () => {
    const step = paidPair();
    delete step.paid;
    delete (step.onError as { fallback: Obj }).fallback.paid;
    expect((await runWith(step, new Error("no"))).calls).toEqual(["primary", "backup"]);
    expect((await runWith(step, new Error("no"), () => true)).calls).toEqual(["primary"]);
    expect((await runWith(step, new Error("no"), (id) => id === "first")).calls).toEqual([
      "primary",
      "backup",
    ]);
  });
});

describe("provesNoCharge", () => {
  it("only a short list of failures proves it", () => {
    expect(provesNoCharge(new Error("x"))).toBe(false);
    expect(provesNoCharge("x")).toBe(false);
    expect(provesNoCharge(null)).toBe(false);
    expect(provesNoCharge(Object.assign(new Error("x"), { code: "ECONNRESET" }))).toBe(false);
    expect(provesNoCharge(new CapabilityError("x", { retryable: true }))).toBe(true);
    expect(
      provesNoCharge(new CapabilityError("x", { retryable: true, mayHaveCharged: true })),
    ).toBe(false);
    expect(
      provesNoCharge(Object.assign(new Error("x"), { code: "UNKNOWN_TOOL", mayHaveCharged: true })),
    ).toBe(false);
    expect(provesNoCharge(Object.assign(new Error("x"), { code: "MISSING_SECRET" }))).toBe(true);
  });
});

describe("schema and plan", () => {
  it("accepts afterUnknownOutcome next to fallback and nothing else", () => {
    const c = parse(recipe("ok", [paidPair({ afterUnknownOutcome: true })]));
    const onError = c.steps[0]?.onError;
    expect(typeof onError === "object" && onError.afterUnknownOutcome).toBe(true);
    const plain = parse(recipe("ok", [paidPair()])).steps[0]?.onError;
    expect(typeof plain === "object" && plain.afterUnknownOutcome).toBe(false);
    expect(() => parse(recipe("bad", [paidPair({ afterUnknownOutcome: "yes" })]))).toThrow();
    expect(() => parse(recipe("bad", [paidPair({ retries: 2 })]))).toThrow();
  });
});

// --- through the loader: the host's paid rule reaches the runner --------------------------

describe("through the pack loader", () => {
  let h: LoaderHarness;
  let mock: MockTools;
  const pack = {
    tools: [
      { name: "gen_a", capability: "image.generate" },
      { name: "gen_b", capability: "image.generate" },
      { name: "note" },
    ],
  };
  const step = (extra: Obj = {}) => ({
    id: "first",
    tool: "gen_a",
    args: {},
    onError: { fallback: { id: "second", tool: "gen_b", args: {} }, ...extra },
  });
  const flows = [
    recipe("implicit", [step()], { output: "${steps.first}" }),
    recipe("explicit", [step({ afterUnknownOutcome: true })], { output: "${steps.first}" }),
    recipe("both_marked", [
      {
        ...step(),
        tool: "note",
        paid: true,
        onError: { fallback: { id: "second", tool: "note", paid: true, args: {} } },
      },
    ]),
    recipe(
      "free_fallback",
      [{ ...step(), onError: { fallback: { id: "second", tool: "note", args: {} } } }],
      { output: "${steps.first}" },
    ),
  ];

  beforeAll(async () => {
    h = await bootLoader({
      packs: [],
      bundled: false,
      seed(b) {
        writeMockPack(b, "gens", pack);
        writeWorkflowPack(b, flows, { id: "flows", tools: ["gen_a", "gen_b", "note"] });
      },
    });
  });
  afterAll(async () => h?.close());
  beforeEach(() => {
    mock = new MockTools().install();
    mock.handlers.gen_a = () => {
      throw new Error("gen_a: timed out after the request was sent");
    };
    mock.handlers.gen_b = () => ({ from: "gen_b" });
    mock.handlers.note = () => ({ from: "note" });
  });

  it("a capability-backed tool is paid without the recipe saying so: no implicit second charge", async () => {
    const env = await h.call("wf_implicit", {});
    expect(env.ok).toBe(false);
    expect(env.error?.message).toMatch(
      /may have been charged, so its paid fallback "second" was not run/,
    );
    expect(mock.order()).toEqual(["gen_a"]);
  });

  it("the explicit recipe falls back, and an unpaid fallback always does", async () => {
    expect((await runOk(h, "wf_explicit", {})).output).toEqual({ from: "gen_b" });
    expect(mock.order()).toEqual(["gen_a", "gen_b"]);
    expect((await runOk(h, "wf_free_fallback", {})).output).toEqual({ from: "note" });
  });

  it("the dry run shows it", async () => {
    const implicit = await runOk(h, "wf_implicit", { dry_run: true });
    expect((implicit.steps as Obj[])[0]).toMatchObject({
      on_error: "fallback",
      fallback_after_unknown_outcome: "never",
    });
    const explicit = await runOk(h, "wf_explicit", { dry_run: true });
    expect((explicit.steps as Obj[])[0]).toMatchObject({
      fallback_after_unknown_outcome: "explicit",
    });
    const marked = await runOk(h, "wf_both_marked", { dry_run: true });
    expect((marked.steps as Obj[])[0]).toMatchObject({ fallback_after_unknown_outcome: "never" });
    const free = await runOk(h, "wf_free_fallback", { dry_run: true });
    expect((free.steps as Obj[])[0]).not.toHaveProperty("fallback_after_unknown_outcome");
  });
});
