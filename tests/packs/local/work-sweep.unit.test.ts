import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { STALE_WORK_MS, sweepStaleWorkDirs } from "../../../packs/local/lib/util.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("sweepStaleWorkDirs", () => {
  it("removes old work folders only, keeps fresh ones and anything else", async () => {
    const data = mkdtempSync(join(tmpdir(), "plughive-sweep-"));
    dirs.push(data);
    const work = join(data, "work");
    const old = join(work, "5c9259a7-d9ad-4129-8a0d-224aca023181");
    const fresh = join(work, "147f6ee8-c833-4d6d-8fdb-e7874865af19");
    const other = join(work, "keep-me");
    for (const d of [old, fresh, other]) mkdirSync(d, { recursive: true });
    writeFileSync(join(old, "in0.png"), "x");
    const now = Date.now();
    const past = new Date(now - STALE_WORK_MS - 60_000);
    utimesSync(old, past, past);
    utimesSync(other, past, past);
    expect(await sweepStaleWorkDirs(data, STALE_WORK_MS, now)).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
    expect(existsSync(other)).toBe(true);
  });

  it("is a no-op when there is no work folder", async () => {
    const data = mkdtempSync(join(tmpdir(), "plughive-sweep-"));
    dirs.push(data);
    expect(await sweepStaleWorkDirs(data)).toBe(0);
  });
});
