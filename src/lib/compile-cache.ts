// src/lib/compile-cache.ts: V8's on-disk compile cache, in a private directory.
//
// Node's default directory is os.tmpdir()/node-compile-cache. On Linux that is
// usually the shared /tmp: another local user could create it first and plant
// compiled code that the daemon would then run. So the cache lives in the
// user's own cache directory, created 0700 and used only when this user owns
// it and nobody else can write to it.
//
// No imports beyond node: built-ins, so it is cheap to load before the daemon.
import { mkdirSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

/** The per-user directory for the cache (not created here). */
export function compileCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  let base: string;
  if (platform === "darwin") base = join(home, "Library", "Caches");
  else if (platform === "win32") base = env.LOCALAPPDATA || join(home, "AppData", "Local");
  else base = env.XDG_CACHE_HOME?.startsWith("/") ? env.XDG_CACHE_HOME : join(home, ".cache");
  return join(base, "plughive", "node-compile-cache");
}

/** True when `dir` is a directory this user owns and only this user can write. */
export function isPrivateDir(dir: string): boolean {
  const st = statSync(dir);
  if (!st.isDirectory()) return false;
  if (typeof process.getuid !== "function") return true; // Windows: per-user profile ACLs
  return st.uid === process.getuid() && (st.mode & 0o022) === 0;
}

/**
 * Turns the compile cache on, in compileCacheDir(). Does nothing on Node
 * 22.0 (no enableCompileCache), with NODE_DISABLE_COMPILE_CACHE=1, or when the
 * directory can't be made private. An explicit NODE_COMPILE_CACHE is the
 * user's choice and is used as is. Never throws: the cache only costs speed.
 */
export function enablePrivateCompileCache(env: NodeJS.ProcessEnv = process.env): void {
  try {
    const enable = nodeModule.enableCompileCache;
    if (typeof enable !== "function" || env.NODE_DISABLE_COMPILE_CACHE) return;
    if (env.NODE_COMPILE_CACHE) {
      enable();
      return;
    }
    const dir = compileCacheDir(env);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!isPrivateDir(dir)) return;
    enable(dir);
  } catch {
    /* an unusable cache directory only costs speed */
  }
}
