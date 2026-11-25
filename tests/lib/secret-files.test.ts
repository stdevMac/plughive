import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applySecretFiles } from "../../src/lib/secret-files.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "mcps-secret-files-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("applySecretFiles", () => {
  it("reads each credential from its _FILE variant and drops the _FILE variable", () => {
    writeFileSync(join(dir, "key"), "access-key-from-file\n");
    writeFileSync(join(dir, "token"), "admin-token-from-file-0123456789");
    const env: NodeJS.ProcessEnv = {
      PLUGHIVE_ACCESS_KEY_FILE: join(dir, "key"),
      PLUGHIVE_ADMIN_TOKEN_FILE: join(dir, "token"),
    };
    applySecretFiles(env);
    expect(env.PLUGHIVE_ACCESS_KEY).toBe("access-key-from-file");
    expect(env.PLUGHIVE_ADMIN_TOKEN).toBe("admin-token-from-file-0123456789");
    expect(env.PLUGHIVE_ACCESS_KEY_FILE).toBeUndefined();
    expect(env.PLUGHIVE_ADMIN_TOKEN_FILE).toBeUndefined();
  });

  it("keeps a variable that is set over its file", () => {
    writeFileSync(join(dir, "pass"), "from-file");
    const env: NodeJS.ProcessEnv = {
      PLUGHIVE_SECRETS_PASSPHRASE: "from-env",
      PLUGHIVE_SECRETS_PASSPHRASE_FILE: join(dir, "pass"),
    };
    applySecretFiles(env);
    expect(env.PLUGHIVE_SECRETS_PASSPHRASE).toBe("from-env");
  });

  it("follows a symlink to a regular file (Kubernetes secrets)", () => {
    writeFileSync(join(dir, "real"), "linked-secret");
    symlinkSync(join(dir, "real"), join(dir, "link"));
    const env: NodeJS.ProcessEnv = { PLUGHIVE_ACCESS_KEY_FILE: join(dir, "link") };
    applySecretFiles(env);
    expect(env.PLUGHIVE_ACCESS_KEY).toBe("linked-secret");
  });

  it("refuses to start on a missing, empty, oversized or non-regular file", () => {
    writeFileSync(join(dir, "empty"), "\n");
    writeFileSync(join(dir, "big"), "x".repeat(5000));
    mkdirSync(join(dir, "folder"));
    for (const [path, msg] of [
      [join(dir, "missing"), /cannot open/],
      [join(dir, "empty"), /is empty/],
      [join(dir, "big"), /over 4096 bytes/],
      [join(dir, "folder"), /not a regular file/],
    ] as const) {
      const env: NodeJS.ProcessEnv = { PLUGHIVE_ACCESS_KEY_FILE: path };
      expect(() => applySecretFiles(env)).toThrow(msg);
      expect(env.PLUGHIVE_ACCESS_KEY).toBeUndefined();
    }
  });
});
