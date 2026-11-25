// src/lib/private-db.ts
//
// The daemon's SQLite files (usage, jobs, library, memory) hold prompts, paths
// and spend: owner-only, whatever the umask. SQLite gives the -wal and -shm
// files the mode of the database file, so narrowing it right after the open,
// before the first write, covers them too.
import { chmodSync } from "node:fs";
import Database from "better-sqlite3";

export function openPrivateDb(path: string): Database.Database {
  const db = new Database(path);
  if (process.platform !== "win32") {
    try {
      chmodSync(path, 0o600);
    } catch {
      // a filesystem without modes; the data dir is 0700 anyway
    }
  }
  return db;
}
