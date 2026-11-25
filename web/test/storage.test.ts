import { describe, expect, it } from "vitest";
import { storageLabel, storageState, storageWords } from "../src/components/StorageNote";
import { artifactDownloadUrl } from "../src/lib/media";

const ORIGIN = "http://127.0.0.1:7777";

describe("where keys are stored, in words", () => {
  it("prefers the reported storage state and falls back to the backend", () => {
    expect(storageState("file", "file-plain")).toBe("file-plain");
    expect(storageState("file", "file-encrypted")).toBe("file-encrypted");
    expect(storageState("keychain", undefined)).toBe("keychain");
    expect(storageState("memory", null)).toBe("memory");
    // An older daemon: a file of unknown encryption is not guessed.
    expect(storageState("file", undefined)).toBeNull();
    expect(storageState(null, undefined)).toBeNull();
  });

  it("says plainly whether the file is encrypted", () => {
    const enc = storageWords("file", "/data", "file-encrypted");
    expect(enc).toContain("encrypted in /data/secrets.json");
    const plain = storageWords("file", "/data", "file-plain");
    expect(plain).toContain("without encryption");
    expect(plain).toContain("/data/secrets.json");
    expect(storageWords("file", null, undefined)).toContain(
      "encrypted only when PLUGHIVE_SECRETS_PASSPHRASE is set",
    );
    expect(storageWords("memory", "/data", "memory")).toContain("lost when the daemon restarts");
  });

  it("names a non-default keychain service only", () => {
    expect(storageWords("keychain", null, "keychain", "plughive")).toBe(
      "Keys are saved in the macOS Keychain on this computer.",
    );
    expect(storageWords("keychain", null, "keychain", null)).toBe(
      "Keys are saved in the macOS Keychain on this computer.",
    );
    expect(storageWords("keychain", null, "keychain", "plughive-dev")).toContain(
      "service name plughive-dev",
    );
  });

  it("has a short label for each state", () => {
    expect(storageLabel("keychain", "keychain")).toBe("macOS Keychain");
    expect(storageLabel("file", "file-encrypted")).toBe("Encrypted file");
    expect(storageLabel("file", "file-plain")).toBe("File, not encrypted");
    expect(storageLabel("memory", "memory")).toMatch(/lost on restart/);
    expect(storageLabel("file", undefined)).toBeNull();
  });
});

describe("artifactDownloadUrl", () => {
  it("adds download=1 to artifact links and keeps signed parameters", () => {
    expect(artifactDownloadUrl("/artifacts/img_X", ORIGIN)).toBe("/artifacts/img_X?download=1");
    expect(artifactDownloadUrl("/artifacts/img_X?exp=1&sig=abc", ORIGIN)).toBe(
      "/artifacts/img_X?exp=1&sig=abc&download=1",
    );
    expect(artifactDownloadUrl("http://127.0.0.1:7777/artifacts/img_X?exp=1", ORIGIN)).toBe(
      "http://127.0.0.1:7777/artifacts/img_X?exp=1&download=1",
    );
    // Already there: set once, not repeated.
    expect(artifactDownloadUrl("/artifacts/img_X?download=0&download=1", ORIGIN)).toBe(
      "/artifacts/img_X?download=1",
    );
  });

  it("leaves other links alone", () => {
    expect(artifactDownloadUrl("https://example.com/file.png", ORIGIN)).toBe(
      "https://example.com/file.png",
    );
    expect(artifactDownloadUrl("/api/info", ORIGIN)).toBe("/api/info");
  });
});
