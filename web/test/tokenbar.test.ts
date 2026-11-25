import { describe, expect, it } from "vitest";
import { parseThreshold, tokenScale } from "../src/lib/composer";

describe("tokenScale", () => {
  it("scales against twice the threshold, with the tick in the middle", () => {
    const s = tokenScale(4000, 4000, 8000);
    expect(s.max).toBe(16000);
    expect(s.fillPercent).toBe(25);
    expect(s.tickPercent).toBe(50);
    expect(s.over).toBe(false);
    expect(s.directPercent).toBeNull();
  });

  it("marks the full-schema size when it is larger than what is sent", () => {
    const s = tokenScale(2000, 12000, 8000);
    expect(s.directPercent).toBe(75);
  });

  it("caps the bar and says it is off the scale", () => {
    const s = tokenScale(40000, 0, 8000);
    expect(s.fillPercent).toBe(100);
    expect(s.over).toBe(true);
    expect(s.offScale).toBe(true);
  });

  it("uses 8000 when the threshold is not a positive number", () => {
    expect(tokenScale(0, 0, 0).max).toBe(16000);
  });
});

describe("parseThreshold", () => {
  it("accepts whole numbers of at least 1", () => {
    expect(parseThreshold(" 8000 ")).toEqual({ value: 8000 });
  });
  it("explains what is wrong instead of snapping back", () => {
    expect(parseThreshold("")).toEqual({ error: "Enter a number." });
    expect(parseThreshold("8k")).toEqual({ error: "Use a whole number, like 8000." });
    expect(parseThreshold("1.5")).toEqual({ error: "Use a whole number, like 8000." });
    expect(parseThreshold("0")).toEqual({ error: "Use a number of at least 1." });
  });
});
