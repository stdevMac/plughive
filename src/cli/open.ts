// src/cli/open.ts
//
// Open a URL in the user's browser with the platform's opener. The URL is an
// argument of execFile (no shell). A dashboard link carries the admin token in
// its fragment, so it is visible in this machine's process list for the
// moment the opener runs; nothing else sees it.
import { execFile } from "node:child_process";
import { browserCommand } from "../lib/platform.js";

export { browserCommand };

/** Resolves true when the opener ran, false when it is missing or failed. */
export function openInBrowser(url: string): Promise<boolean> {
  const { file, args } = browserCommand(url);
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 10_000 }, (err) => resolve(!err));
  });
}
