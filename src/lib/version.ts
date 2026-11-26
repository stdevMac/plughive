// src/lib/version.ts: the plughive version, read once from package.json.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/** The version in plughive's package.json (found from src/lib/ or dist/src/lib/). */
export function packageVersion(): string {
  if (cached !== undefined) return cached;
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "plughive" && pkg.version) {
          cached = pkg.version;
          return cached;
        }
      } catch {
        // Keep looking.
      }
    }
    dir = dirname(dir);
  }
  cached = "unknown";
  return cached;
}
