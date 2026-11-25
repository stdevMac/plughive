import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKEND_CHOICE_FILE,
  createSecretStore,
  linuxBackendKind,
} from "../../../src/core/secrets/store.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plughive-linux-secrets-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const BUS = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };
const recorded = () => readFileSync(join(home, BACKEND_CHOICE_FILE), "utf8").trim();

describe("Linux secrets backend choice", () => {
  it("headless (no session bus): the file, without asking the bus", () => {
    const probe = vi.fn(() => true);
    expect(linuxBackendKind(home, {}, probe)).toBe("file");
    expect(probe).not.toHaveBeenCalled();
    expect(recorded()).toBe("file");
  });

  it("a session bus with a Secret Service: the keyring", () => {
    expect(linuxBackendKind(home, BUS, () => true)).toBe("keyring");
    expect(recorded()).toBe("keyring");
  });

  it("a session bus but no Secret Service (a server's systemd user session): the file", () => {
    expect(linuxBackendKind(home, BUS, () => false)).toBe("file");
    expect(recorded()).toBe("file");
  });

  it("a bus that cannot be asked counts as a desktop", () => {
    expect(linuxBackendKind(home, BUS, () => undefined)).toBe("keyring");
  });

  it("keeps the first choice, so secrets never seem to vanish", () => {
    expect(linuxBackendKind(home, BUS, () => true)).toBe("keyring");
    // The keyring is briefly unreachable at the next start: still the keyring.
    const probe = vi.fn(() => false);
    expect(linuxBackendKind(home, BUS, probe)).toBe("keyring");
    expect(probe).not.toHaveBeenCalled();
  });

  it("existing secrets in the file win over a keyring", () => {
    writeFileSync(join(home, "secrets.json"), "{}");
    expect(linuxBackendKind(home, BUS, () => true)).toBe("file");
  });

  it("ignores a garbled record and decides again", () => {
    writeFileSync(join(home, BACKEND_CHOICE_FILE), "keychain\n");
    expect(linuxBackendKind(home, BUS, () => false)).toBe("file");
  });

  it("the store follows it, and PLUGHIVE_SECRETS still overrides", async () => {
    const store = createSecretStore({
      home,
      env: BUS,
      platform: "linux",
      probeSecretService: () => false,
    });
    expect(store.backendKind).toBe("file");
    await store.set("SOME_KEY", "v");
    expect(await store.get("SOME_KEY")).toBe("v");
    const forced = createSecretStore({
      home: mkdtempSync(join(tmpdir(), "plughive-linux-secrets-")),
      env: { ...BUS, PLUGHIVE_SECRETS: "keyring" },
      platform: "linux",
      probeSecretService: () => false,
    });
    expect(forced.backendKind).toBe("keyring");
  });
});
