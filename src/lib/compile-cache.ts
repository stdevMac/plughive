// src/lib/compile-cache.ts: V8's on-disk compile cache, in a private directory.
//
// Node's default directory is os.tmpdir()/node-compile-cache. On Linux that is
// usually the shared /tmp: another local user could create it first and plant
// compiled code that the daemon would then run. So the cache lives in the
// user's own cache directory, created 0700 and used only when this user owns
// it and nobody else can write to it.
//
// No imports beyond node: built-ins, so it is cheap to load before the daemon.
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import * as nodeModule from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * True when `dir` is a directory this user owns and only this user can write,
 * and no folder above it lets another user swap it out: each parent is owned
 * by this user or root and is not writable by others (unless sticky, like
 * /tmp). Checked on the resolved path, so a symlink cannot point it elsewhere.
 */
export function isPrivateDir(dir: string): boolean {
  if (typeof process.getuid !== "function") return statSync(dir).isDirectory(); // Windows: per-user profile ACLs
  const uid = process.getuid();
  const real = realpathSync(dir);
  const st = lstatSync(real);
  if (!st.isDirectory() || st.uid !== uid || (st.mode & 0o022) !== 0) return false;
  for (let p = dirname(real); ; p = dirname(p)) {
    const parent = lstatSync(p);
    if (parent.uid !== uid && parent.uid !== 0) return false;
    if ((parent.mode & 0o022) !== 0 && (parent.mode & 0o1000) === 0) return false;
    if (dirname(p) === p) return true;
  }
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
    const real = realpathSync(dir);
    if (!isPrivateDir(real)) return;
    enable(real);
  } catch {
    /* an unusable cache directory only costs speed */
  }
}
