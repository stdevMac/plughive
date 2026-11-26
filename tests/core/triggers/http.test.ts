// The webhook RateLimiter: fixed one-minute windows per key, and a full
// table never hands every key a fresh budget.
import { describe, expect, it } from "vitest";
import { RateLimiter } from "../../../src/core/triggers/http.js";

describe("RateLimiter", () => {
  it("D-M5: a full table refuses new keys instead of resetting the live ones", () => {
    const clock = { now: 0 };
    const limiter = new RateLimiter(1, () => clock.now);
    expect(limiter.take("hot")).toBe(true);
    expect(limiter.take("hot")).toBe(false);
    for (let i = 0; i < 10_000; i++) limiter.take(`k${i}`);
    expect(limiter.take("one-more")).toBe(false);
    expect(limiter.take("hot")).toBe(false); // still limited, not reset
    // Once the windows have ended there is room again.
    clock.now = 60_000;
    expect(limiter.take("one-more")).toBe(true);
    expect(limiter.take("hot")).toBe(true);
  });
});
