// tests/clients/fs-safe.test.ts
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { backupOnce, readIfExists, restrictMode, writeAtomic } from "../../src/clients/fs-safe.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "plughive-fs-safe-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe.skipIf(process.platform === "win32")(
  "D-M16: fs-safe never follows a swapped-in link",
  () => {
    function plant(): { victim: string; target: string } {
      const victim = join(dir, "victim");
      writeFileSync(victim, "secret: other-server-token\n", { mode: 0o644 });
      chmodSync(victim, 0o644);
      const target = join(dir, "config.yaml");
      symlinkSync(victim, target);
      return { victim, target };
    }

    it("refuses to read, back up or chmod through a symlink at the resolved target", () => {
      const { victim, target } = plant();
      expect(() => readIfExists(target)).toThrow(/symbolic link/);
      expect(() => backupOnce(target)).toThrow(/symbolic link/);
      expect(() => restrictMode(target)).toThrow(/symbolic link/);
      expect(statSync(victim).mode & 0o777).toBe(0o644);
    });

    it("still reads, backs up and writes a plain file", () => {
      const target = join(dir, "config.yaml");
      writeFileSync(target, "a: 1\n", { mode: 0o644 });
      chmodSync(target, 0o644);
      expect(readIfExists(target)).toBe("a: 1\n");
      const backup = backupOnce(target);
      expect(backup && readFileSync(backup, "utf8")).toBe("a: 1\n");
      restrictMode(target);
      expect(statSync(target).mode & 0o777).toBe(0o600);
      writeAtomic(target, "a: 2\n", { secret: true });
      expect(readFileSync(target, "utf8")).toBe("a: 2\n");
      expect(readIfExists(join(dir, "missing"))).toBeNull();
    });
  },
);
