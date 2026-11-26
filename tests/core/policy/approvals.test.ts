// Approval summaries a person reads before approving: every argument stays
// visible, and the text cannot hide or reorder itself with control or
// bidirectional characters.
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  ApprovalStore,
  MAX_ARGS_SUMMARY,
  summarizeArgs,
} from "../../../src/core/policy/approvals.js";

// Built from code points so the source itself holds no invisible characters.
const RLO = String.fromCodePoint(0x202e);
const PDF = String.fromCodePoint(0x202c);
const LRI = String.fromCodePoint(0x2066);
const RLI = String.fromCodePoint(0x2067);
const ZWSP = String.fromCodePoint(0x200b);
const BEL = String.fromCodePoint(0x07);
// biome-ignore lint/suspicious/noControlCharactersInRegex: the test looks for these characters
const UNSAFE = /[\n\u0007\u200b\u202a-\u202e\u2066-\u2069]/;

describe("summarizeArgs (D-H9)", () => {
  it("long values do not push the other keys out of the summary", () => {
    const long = "x".repeat(190);
    const text = summarizeArgs({
      prompt: long,
      style: long,
      notes: long,
      to: "attacker@example.com",
      delete: true,
    });
    expect(text.length).toBeLessThanOrEqual(MAX_ARGS_SUMMARY);
    expect(text).toContain('"to":"attacker@example.com"');
    expect(text).toContain('"delete":true');
    expect(text).toContain("…");
  });

  it("every key is shown even when there are many", () => {
    const args: Record<string, string> = {};
    for (let i = 0; i < 30; i++) args[`k${i}`] = "v".repeat(100);
    args.target = "/etc/passwd";
    const text = summarizeArgs(args);
    for (const k of Object.keys(args)) expect(text).toContain(`"${k}":`);
  });

  it("short arguments are shown in full", () => {
    expect(summarizeArgs({ a: 1, b: "two" })).toBe('{"a":1,"b":"two"}');
  });

  it("bidirectional overrides and invisible characters are removed", () => {
    const text = summarizeArgs({
      url: `https://example.com/${RLO}moc.elgoog${PDF}`,
      n: `a${LRI}b${ZWSP}c`,
    });
    expect(text).not.toMatch(UNSAFE);
  });
});

describe("ApprovalStore.request (D-H9)", () => {
  it("cleans the tool name and the reason a person reads", () => {
    const store = new ApprovalStore({ db: new Database(":memory:") });
    const a = store.request(
      {
        kind: "tool",
        tool: `send${RLO}liame`,
        provider: null,
        args: {},
        estimateUsd: null,
        reason: `cheap\nTool: free_tool${RLI} ${BEL}`,
        profile: "default",
        fingerprint: "f1",
      },
      60_000,
    );
    expect(a.tool).not.toMatch(UNSAFE);
    expect(a.reason).not.toMatch(UNSAFE);
  });
});
