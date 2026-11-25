import { cpSync, existsSync, lstatSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function copySkills(
  source = resolve(repoRoot, "src/skills"),
  destination = resolve(repoRoot, "dist/src/skills"),
) {
  if (!existsSync(source)) return;
  cpSync(source, destination, { recursive: true });
}

/**
 * Never copied into dist (and so never published): local secrets a developer
 * may keep next to a pack, and symlinks, which could point anywhere on the
 * build machine.
 */
export function isShippableAsset(src) {
  const base = basename(src);
  if (/^\.env(\..*)?$/.test(base) && base !== ".env.example") return false;
  if (/\.(pem|key|p12|pfx)$/i.test(base)) return false;
  if (base === "secrets.json" || base === "admin-token" || base === ".npmrc") return false;
  try {
    if (lstatSync(src).isSymbolicLink()) return false;
  } catch {
    return false;
  }
  return true;
}

/** Copy pack assets (pack.json, SKILL.md, workflows) next to the compiled pack code. */
export function copyPackAssets(
  source = resolve(repoRoot, "packs"),
  destination = resolve(repoRoot, "dist/packs"),
) {
  if (!existsSync(source)) return;
  cpSync(source, destination, {
    recursive: true,
    filter: (src) => !/\.(ts|tsx|mts|cts)$/.test(src) && isShippableAsset(src),
  });
}

/**
 * Copy the built dashboard to where the compiled daemon looks for it (dist/web/dist).
 * The destination is replaced, not merged: every build gives the bundles new hashed
 * names, so merging would pile up old bundles in dist and in the app payload.
 */
export function copyWeb(
  source = resolve(repoRoot, "web/dist"),
  destination = resolve(repoRoot, "dist/web/dist"),
) {
  if (!existsSync(source)) return;
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  copySkills();
  copyPackAssets();
  copyWeb();
}
