import { describe, expect, it } from "vitest";
import { blockingFor, pathOf } from "../src/lib/navguard";

describe("pathOf", () => {
  it("drops query, hash and trailing slashes", () => {
    expect(pathOf("/exposure?profile=x")).toBe("/exposure");
    expect(pathOf("/exposure/#a")).toBe("/exposure");
    expect(pathOf("/")).toBe("/");
    expect(pathOf("")).toBe("/");
  });
});

describe("blockingFor", () => {
  const dirty = { id: 1, when: true };
  const clean = { id: 2, when: false };

  it("blocks leaving the page while there are unsaved changes", () => {
    expect(blockingFor([dirty], "/exposure", "/packs")).toBe(dirty);
  });

  it("lets query changes on the same page through", () => {
    expect(blockingFor([dirty], "/exposure?profile=a", "/exposure?profile=b")).toBeNull();
  });

  it("lets everything through when nothing is dirty", () => {
    expect(blockingFor([clean], "/exposure", "/packs")).toBeNull();
    expect(blockingFor([], "/exposure", "/packs")).toBeNull();
  });

  it("uses the most recently registered dirty blocker", () => {
    const later = { id: 3, when: true };
    expect(blockingFor([dirty, clean, later], "/a", "/b")).toBe(later);
  });
});
