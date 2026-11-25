// packs/local/lib/probe.ts
//
// Is a command-line tool installed? Runs it once with a harmless flag and a
// short timeout. A spawn failure ("not found") means missing; any exit code,
// or even a timeout (Python tools can take seconds to import), means it is
// there. Answers are cached briefly per pack data dir, because the router asks
// `isConfigured` on every call. A plain "not found" is never cached.
import type { PackContext } from "plughive/pack";
import { run } from "./ffmpeg.js";
import { LocalBackendError } from "./util.js";

export interface BackendStatus {
  available: boolean;
  details: Record<string, unknown>;
  install_hint: string | null;
  error?: string;
}

const PROBE_TIMEOUT_MS = 6000;
const HIT_TTL_MS = 5 * 60_000;
const MISS_TTL_MS = 30_000;
const cache = new Map<string, { at: number; status: BackendStatus }>();
// Probes already running, keyed like the cache: the router asks many providers
// at once, and several of them check the same program. They share one spawn.
const inFlight = new Map<string, Promise<BackendStatus>>();

function firstLine(text: string): string | null {
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l !== "");
  return line ? line.slice(0, 200) : null;
}

/** Forget cached probe results (tests, and after the user installs something). */
export function clearProbeCache(): void {
  cache.clear();
  inFlight.clear();
}

/**
 * Runs `probe` once for `key` while it is running, and keeps a result that says
 * "available" for five minutes. Anything else is asked again next time, so a
 * program installed a moment ago shows up at once.
 */
export async function rememberAvailable(
  key: string,
  probe: () => Promise<BackendStatus>,
): Promise<BackendStatus> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < HIT_TTL_MS && hit.status.available) return hit.status;
  const running = inFlight.get(key);
  if (running) return running;
  const p = probe()
    .then((status) => {
      if (status.available) cache.set(key, { at: Date.now(), status });
      else cache.delete(key);
      return status;
    })
    .finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

export async function binaryStatus(
  ctx: PackContext,
  binary: string,
  hint: string,
  args: readonly string[] = ["--version"],
): Promise<BackendStatus> {
  const key = `${ctx.pack.dataDir}\0${binary}\0${args.join(" ")}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.status.available ? HIT_TTL_MS : MISS_TTL_MS)) {
    return hit.status;
  }
  const running = inFlight.get(key);
  if (running) return running;
  const p = probeBinary(ctx, binary, hint, args, key).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function probeBinary(
  ctx: PackContext,
  binary: string,
  hint: string,
  args: readonly string[],
  key: string,
): Promise<BackendStatus> {
  let status: BackendStatus;
  try {
    const r = await run(ctx, binary, args, { timeoutMs: PROBE_TIMEOUT_MS, hint });
    status = {
      available: true,
      details: { binary, version: firstLine(r.stdout) ?? firstLine(r.stderr) },
      install_hint: null,
    };
  } catch (e) {
    const message = ((e as Error)?.message ?? String(e)).slice(0, 300);
    status =
      e instanceof LocalBackendError
        ? {
            available: false,
            details: { binary },
            install_hint: hint,
            error: `${binary} not found`,
          }
        : /timed out/.test(message)
          ? { available: true, details: { binary, version: null }, install_hint: null }
          : { available: false, details: { binary }, install_hint: hint, error: message };
  }
  // "Not found" is decided before anything starts (a PATH and tools/bin lookup),
  // so it is cheap to ask again, and caching it would hide a program the user
  // has just installed from the Software page until the entry expired.
  if (status.available || status.error !== `${binary} not found`) {
    cache.set(key, { at: Date.now(), status });
  } else {
    cache.delete(key);
  }
  return status;
}

/** Throws a LocalBackendError with the install hint unless the binary answers. */
export async function requireBinary(
  ctx: PackContext,
  binary: string,
  hint: string,
  args?: readonly string[],
): Promise<void> {
  const s = await binaryStatus(ctx, binary, hint, args);
  if (!s.available) throw new LocalBackendError(`${binary} is not installed. ${hint}`);
}
