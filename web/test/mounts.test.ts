import { describe, expect, it } from "vitest";
import { type MountStatusView, NEEDS_SIGN_IN, mountState, needsSignIn } from "../src/lib/mounts";

const base: MountStatusView = { enabled: true, connected: true, error: null, secrets: [] };

describe("mountState", () => {
  it("reports key mounts as before", () => {
    expect(mountState(base)).toEqual({ text: "Connected", tone: "ok" });
    expect(mountState({ ...base, enabled: false })).toBeNull();
    expect(mountState({ ...base, connected: false, secrets: [{ present: false }] })).toEqual({
      text: "Needs a key",
      tone: "warn",
    });
    expect(mountState({ ...base, connected: false, error: "boom" })).toEqual({
      text: "Cannot connect",
      tone: "danger",
    });
  });

  it("asks for a sign-in on an OAuth mount without one", () => {
    const off = {
      ...base,
      enabled: false,
      connected: false,
      oauth: { signedIn: false, pending: false },
    };
    expect(needsSignIn(off)).toBe(true);
    expect(mountState(off)).toEqual({ text: "Not signed in", tone: "neutral" });
    expect(mountState({ ...off, enabled: true, error: NEEDS_SIGN_IN })).toEqual({
      text: "Needs sign-in",
      tone: "warn",
    });
    expect(mountState({ ...off, oauth: { signedIn: false, pending: true } })).toEqual({
      text: "Waiting for sign-in",
      tone: "neutral",
    });
  });

  it("a refused refresh asks for a new sign-in even with records left", () => {
    const m = {
      ...base,
      connected: false,
      error: NEEDS_SIGN_IN,
      oauth: { signedIn: true, pending: false },
    };
    expect(needsSignIn(m)).toBe(true);
    expect(mountState(m)).toEqual({ text: "Needs sign-in", tone: "warn" });
  });

  it("a signed-in OAuth mount reads like any other", () => {
    const m = { ...base, oauth: { signedIn: true, pending: false } };
    expect(needsSignIn(m)).toBe(false);
    expect(mountState(m)).toEqual({ text: "Connected", tone: "ok" });
    expect(mountState({ ...m, enabled: false, connected: false })).toEqual({
      text: "Signed in",
      tone: "neutral",
    });
  });
});
