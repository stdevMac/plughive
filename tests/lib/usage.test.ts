import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// tests/lib/usage.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageLedger } from "../../src/lib/usage.js";

describe("UsageLedger", () => {
  let dir: string;
  let ledger: UsageLedger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usage-"));
    ledger = new UsageLedger({ root: dir });
  });

  afterEach(() => {
    ledger.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records and summarizes usage events", () => {
    ledger.record({
      tool: "openrouter_chat",
      vendor: "openrouter",
      costUsd: 0.02,
      latencyMs: 120,
      status: "ok",
    });
    ledger.record({
      tool: "firecrawl_search",
      vendor: "firecrawl",
      latencyMs: 80,
      status: "error",
      error: "Firecrawl 429: rate limit",
    });

    const summary = ledger.summarize();
    expect(summary.total_calls).toBe(2);
    expect(summary.ok_calls).toBe(1);
    expect(summary.error_calls).toBe(1);
    expect(summary.total_cost_usd).toBeCloseTo(0.02);
    expect(summary.by_vendor.map((v) => v.vendor)).toContain("openrouter");
    expect(summary.rate_limits.some((r) => r.vendor === "firecrawl" && r.in_cooldown)).toBe(true);
  });

  it("counts calls answered from the paid-call cache", () => {
    ledger.record({
      tool: "generate_image",
      vendor: "fal",
      costUsd: 0.04,
      latencyMs: 900,
      status: "ok",
    });
    ledger.record({
      tool: "generate_image",
      vendor: "fal",
      latencyMs: 0,
      status: "ok",
      meta: { cached: true },
    });
    ledger.record({ tool: "generate_image", latencyMs: 5, status: "ok", meta: { cached: false } });
    const summary = ledger.summarize();
    expect(summary.cached_calls).toBe(1);
    expect(summary.total_calls).toBe(3);
  });

  it("skips rate-limited vendors during cooldown", () => {
    ledger.recordRateLimit("apollo");
    expect(ledger.isVendorInCooldown("apollo")).toBe(true);
    ledger.clearVendorCooldown("apollo");
    expect(ledger.isVendorInCooldown("apollo")).toBe(false);
  });
});
