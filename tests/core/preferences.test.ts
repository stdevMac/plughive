import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect } from "vitest";
import { preferencesPath, readPreferences, writePreferences } from "../../src/core/preferences.js";
import { expectMode, itPosix, itSymlink } from "../support/platform.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "plughive-prefs-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

itSymlink("never writes through a symlink planted at a guessable temp name", () => {
  const victim = join(home, "victim.txt");
  writeFileSync(victim, "keep me\n");
  symlinkSync(victim, `${preferencesPath(home)}.${process.pid}.tmp`);
  writePreferences(home, { locale: "es" });
  expect(readFileSync(victim, "utf8")).toBe("keep me\n");
  expect(readPreferences(home).locale).toBe("es");
  expectMode(preferencesPath(home), 0o600);
});

itPosix("creates a missing home owner-only", () => {
  const nested = join(home, "new-home");
  writePreferences(nested, { locale: "en" });
  expectMode(nested, 0o700);
});
