// src/lib/crash.ts
//
// What the daemon does after an uncaught exception: the process state is
// unknown (a job marked started and never finished, a half-applied loader
// change), so it logs, flushes what is in flight and exits non-zero. A
// supervisor (launchd, Docker, the Mac app) then starts a clean daemon.

export interface CrashHandlerOptions {
  /** Logs the error (the caller redacts it). */
  log(err: unknown): void;
  /** Stops accepting work and flushes state. Null until the daemon is up. */
  flush(): Promise<void> | void;
  /** process.exit. */
  exit(code: number): void;
  /** The process is gone after this long, whatever the flush does. */
  timeoutMs: number;
}

/** The `uncaughtException` listener. A second exception during the flush only logs. */
export function createCrashHandler(opts: CrashHandlerOptions): (err: unknown) => void {
  let crashing = false;
  return (err) => {
    try {
      opts.log(err);
    } catch {
      // Logging must not stop the exit.
    }
    if (crashing) return;
    crashing = true;
    const timer = setTimeout(() => opts.exit(1), opts.timeoutMs);
    timer.unref();
    void Promise.resolve()
      .then(() => opts.flush())
      .catch(() => undefined)
      .then(() => {
        clearTimeout(timer);
        opts.exit(1);
      });
  };
}
