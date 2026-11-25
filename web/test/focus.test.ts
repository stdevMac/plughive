import { describe, expect, it } from "vitest";
import {
  type FocusCandidate,
  initialFocusIndex,
  nextTrapIndex,
  shouldSwallowEnter,
} from "../src/lib/focus";

const c = (over: Partial<FocusCandidate> = {}): FocusCandidate => ({
  autofocus: false,
  danger: false,
  inFooter: false,
  ...over,
});

describe("initialFocusIndex", () => {
  it("never starts on a destructive button", () => {
    // [close (treated as not a first stop), Delete]
    expect(
      initialFocusIndex([c({ danger: true }), c({ danger: true, inFooter: true })], true),
    ).toBe(-1);
  });

  it("starts confirmations on the first safe footer action (Cancel)", () => {
    const items = [
      c({ danger: true }),
      c(),
      c({ inFooter: true }),
      c({ inFooter: true, danger: true }),
    ];
    expect(initialFocusIndex(items, true)).toBe(2);
  });

  it("puts Cancel first even when Delete comes before it", () => {
    const items = [c({ danger: true }), c({ inFooter: true, danger: true }), c({ inFooter: true })];
    expect(initialFocusIndex(items, true)).toBe(2);
  });

  it("honours data-autofocus, but not on a destructive button", () => {
    expect(initialFocusIndex([c(), c({ autofocus: true })], false)).toBe(1);
    expect(initialFocusIndex([c(), c({ autofocus: true, danger: true })], true)).toBe(0);
  });

  it("plain dialogs start on the first safe control", () => {
    expect(initialFocusIndex([c({ danger: true }), c(), c({ inFooter: true })], false)).toBe(1);
  });
});

describe("shouldSwallowEnter", () => {
  it("ignores Enter on a destructive button only", () => {
    expect(shouldSwallowEnter("Enter", true)).toBe(true);
    expect(shouldSwallowEnter("Enter", false)).toBe(false);
    expect(shouldSwallowEnter(" ", true)).toBe(false);
  });
});

describe("nextTrapIndex", () => {
  it("wraps forward from the last element", () => {
    expect(nextTrapIndex(2, 3, false)).toBe(0);
  });
  it("wraps backward from the first element", () => {
    expect(nextTrapIndex(0, 3, true)).toBe(2);
  });
  it("pulls focus back in from outside", () => {
    expect(nextTrapIndex(-1, 3, false)).toBe(0);
    expect(nextTrapIndex(-1, 3, true)).toBe(2);
  });
  it("lets the browser move focus in the middle", () => {
    expect(nextTrapIndex(1, 3, false)).toBeNull();
    expect(nextTrapIndex(1, 3, true)).toBeNull();
  });
  it("does nothing with no focusable elements", () => {
    expect(nextTrapIndex(-1, 0, false)).toBeNull();
  });
});
