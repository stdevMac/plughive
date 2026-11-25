import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openPrivateDb } from "../../src/lib/private-db.js";

describe("openPrivateDb", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it.skipIf(process.platform === "win32")("makes the database and its WAL owner-only", () => {
    dir = mkdtempSync(join(tmpdir(), "plughive-db-"));
    const path = join(dir, "x.db");
    const old = process.umask(0o022);
    try {
      const db = openPrivateDb(path);
      db.pragma("journal_mode = WAL");
      db.exec("CREATE TABLE t (a); INSERT INTO t VALUES (1)");
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(statSync(`${path}-wal`).mode & 0o777).toBe(0o600);
      db.close();
    } finally {
      process.umask(old);
    }
  });
});
