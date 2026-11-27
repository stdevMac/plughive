// tests/lib/secret-files-cap.test.ts
//
// A pseudo-file can report size 0 and still stream far more: the read itself
// is capped. fstatSync is wrapped to report 0 for a large real file.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    fstatSync: ((fd: number, opts?: unknown) => {
      const st = (actual.fstatSync as (f: number, o?: unknown) => import("node:fs").Stats)(
        fd,
        opts,
      );
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { size: 0 });
    }) as typeof actual.fstatSync,
  };
});

const { applySecretFiles } = await import("../../src/lib/secret-files.js");

let dir: string;
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("applySecretFiles byte cap", () => {
  it("refuses a file that reports size 0 but holds more than 4 KiB", () => {
    dir = mkdtempSync(join(tmpdir(), "mcps-secret-cap-"));
    writeFileSync(join(dir, "big"), "k".repeat(64 * 1024));
    const env: NodeJS.ProcessEnv = { PLUGHIVE_ACCESS_KEY_FILE: join(dir, "big") };
    expect(() => applySecretFiles(env)).toThrow(/over 4096 bytes/);
  });

  it("still reads a small file that reports size 0", () => {
    dir = mkdtempSync(join(tmpdir(), "mcps-secret-cap-"));
    writeFileSync(join(dir, "key"), "small-key\n");
    const env: NodeJS.ProcessEnv = { PLUGHIVE_ACCESS_KEY_FILE: join(dir, "key") };
    applySecretFiles(env);
    expect(env.PLUGHIVE_ACCESS_KEY).toBe("small-key");
  });
});
