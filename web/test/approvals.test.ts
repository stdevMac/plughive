import { describe, expect, it } from "vitest";
import {
  type CapStatus,
  type Policy,
  approvalConfirmReasons,
  capLabel,
  capProgress,
  capsFromDrafts,
  isArgsSummaryTruncated,
  parseUsd,
  pendingAfter,
  statusTone,
  toDraft,
  withCaps,
} from "../src/lib/approvals";

const status = (spent: number | null, limit: number): CapStatus => ({
  cap: { scope: "global", period: "daily", limit_usd: limit, mode: "ask" },
  since: "2026-03-10T00:00:00.000Z",
  spent_usd: spent,
  remaining_usd: spent === null ? 0 : Math.max(0, limit - spent),
});

describe("cap progress", () => {
  it("is ok, then warns from 80%, then is reached", () => {
    expect(capProgress(status(1, 10))).toEqual({ pct: 10, tone: "ok", reached: false });
    expect(capProgress(status(8, 10))).toMatchObject({ tone: "warn", reached: false });
    expect(capProgress(status(12, 10))).toEqual({ pct: 100, tone: "danger", reached: true });
  });

  it("counts an unreadable ledger as used up", () => {
    expect(capProgress(status(null, 10))).toEqual({ pct: 100, tone: "danger", reached: true });
  });

  it("treats a zero cap as reached from the start", () => {
    expect(capProgress(status(0, 0))).toMatchObject({ pct: 100, reached: true });
  });
});

describe("cap editor", () => {
  it("parses dollar amounts people type", () => {
    expect(parseUsd("5")).toBe(5);
    expect(parseUsd(" $1.50 ")).toBe(1.5);
    expect(parseUsd(".25")).toBe(0.25);
    expect(parseUsd("-1")).toBeNull();
    expect(parseUsd("abc")).toBeNull();
    expect(parseUsd("")).toBeNull();
    expect(parseUsd("2000000")).toBeNull();
  });

  it("turns drafts into caps, dropping the id of a global cap", () => {
    const r = capsFromDrafts([
      { scope: "global", id: "ignored", period: "daily", limit: "5", mode: "ask" },
      { scope: "provider", id: " fal ", period: "monthly", limit: "$20", mode: "block" },
    ]);
    expect(r.error).toBeNull();
    expect(r.caps).toEqual([
      { scope: "global", period: "daily", limit_usd: 5, mode: "ask" },
      { scope: "provider", id: "fal", period: "monthly", limit_usd: 20, mode: "block" },
    ]);
  });

  it("says what is wrong with a draft", () => {
    expect(
      capsFromDrafts([{ scope: "global", id: "", period: "daily", limit: "x", mode: "ask" }]).error,
    ).toMatch(/Cap 1: the limit/);
    expect(
      capsFromDrafts([{ scope: "provider", id: "", period: "daily", limit: "1", mode: "ask" }])
        .error,
    ).toMatch(/name the provider/);
    const dup = {
      scope: "global" as const,
      id: "",
      period: "daily" as const,
      limit: "1",
      mode: "ask" as const,
    };
    expect(capsFromDrafts([dup, { ...dup, limit: "2" }]).error).toMatch(/Cap 2 repeats/);
  });

  it("round-trips a cap through a draft", () => {
    const cap = {
      scope: "profile" as const,
      id: "work",
      period: "monthly" as const,
      limit_usd: 12.5,
      mode: "block" as const,
    };
    expect(capsFromDrafts([toDraft(cap)]).caps).toEqual([cap]);
  });

  it("keeps every other policy field when the caps change", () => {
    const policy: Policy = {
      version: 1,
      caps: [],
      rules: {
        auto_approve_under_usd: 0.5,
        always_ask_tools: ["x"],
        always_ask_providers: [],
        ask_before_destructive: true,
        ask_before_sending: false,
        approve_in_chat: false,
      },
      profiles: { work: { auto_approve_under_usd: 0 } },
      approval_ttl_minutes: 45,
      telegram: { enabled: true, allowed_chat_ids: ["123"] },
    };
    const next = withCaps(policy, [
      { scope: "global", period: "daily", limit_usd: 1, mode: "ask" },
    ]);
    expect(next).toEqual({
      ...policy,
      caps: [{ scope: "global", period: "daily", limit_usd: 1, mode: "ask" }],
    });
  });
});

describe("labels and badge", () => {
  it("labels caps", () => {
    expect(capLabel({ scope: "global", period: "daily", limit_usd: 1, mode: "ask" })).toBe(
      "Daily, everything",
    );
    expect(
      capLabel({ scope: "provider", id: "fal", period: "monthly", limit_usd: 1, mode: "ask" }),
    ).toBe("Monthly, provider fal");
  });

  it("gives every status a tone", () => {
    expect(statusTone("pending")).toBe("warn");
    expect(statusTone("denied")).toBe("danger");
    expect(statusTone("consumed")).toBe("ok");
  });

  it("takes the pending count from the event, ignoring a bad one", () => {
    expect(pendingAfter(3, { pending: 4 })).toBe(4);
    expect(pendingAfter(3, { pending: 0 })).toBe(0);
    expect(pendingAfter(3, {})).toBe(3);
    expect(pendingAfter(3, { pending: -1 })).toBe(3);
  });

  it("flags unknown-cost and truncated-args approvals for confirmation (D-M14)", () => {
    expect(isArgsSummaryTruncated('{"prompt":"hello"}')).toBe(false);
    expect(isArgsSummaryTruncated('{"prompt":"very long…')).toBe(true);
    expect(approvalConfirmReasons({ estimate_usd: 0.25, args_summary: '{"a":1}' })).toEqual({
      unknownCost: false,
      truncatedArgs: false,
    });
    expect(approvalConfirmReasons({ estimate_usd: null, args_summary: '{"a":1}' })).toEqual({
      unknownCost: true,
      truncatedArgs: false,
    });
    expect(approvalConfirmReasons({ estimate_usd: 0.25, args_summary: '{"a":"cut…' })).toEqual({
      unknownCost: false,
      truncatedArgs: true,
    });
  });
});
