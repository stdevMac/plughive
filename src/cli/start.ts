// src/cli/start.ts
//
//   plughive start [--port N] [--host H] [--home DIR] [--open]
//
// Flags are applied to the environment the daemon reads, then the daemon
// boots in this process (the same startDaemon that `node dist/src/server.js`
// uses). The CLI does not read .env: pass settings as environment variables
// (or with `node --env-file`).
import { resolve } from "node:path";
import {
  assertEncryptedSecretsOnNetwork,
  assertNoMultiKeyConfig,
  assertSafeBind,
} from "../lib/access-key.js";
import { loadConfig } from "../lib/config.js";
import { applySecretFiles } from "../lib/secret-files.js";
import { CliError, type CliIo, EXIT_OK, parse, parsePort } from "./args.js";
import { openInBrowser } from "./open.js";

export const START_HELP = `Usage: plughive start [options]

Start the daemon in the foreground. This is the default command.

Options:
  --port N      port to listen on (PLUGHIVE_PORT, default 7777)
  --host H      address to bind (PLUGHIVE_BIND_HOST, default 127.0.0.1).
                A non-loopback address needs PLUGHIVE_ACCESS_KEY.
  --home DIR    data directory (PLUGHIVE_HOME, default ~/.plughive)
  --open        open the dashboard in the browser once the daemon listens
  -h, --help    show this help

The endpoint is printed on start. On a terminal the dashboard sign-in link
is printed too; it carries the admin token, so do not paste it anywhere.
Stop the daemon with Ctrl-C (SIGINT) or SIGTERM.`;

/** Applies the flags to env. Exported for tests. */
export function applyStartFlags(
  argv: string[],
  env: NodeJS.ProcessEnv,
): { help: boolean; open: boolean } {
  const { values } = parse("start", argv, {
    port: { type: "string" },
    host: { type: "string" },
    home: { type: "string" },
    open: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  });
  if (values.help) return { help: true, open: false };
  if (values.port !== undefined) env.PLUGHIVE_PORT = String(parsePort(values.port));
  if (values.host !== undefined) {
    if (!values.host.trim()) throw new CliError("--host must not be empty", 2);
    env.PLUGHIVE_BIND_HOST = values.host.trim();
  }
  if (values.home !== undefined) {
    if (!values.home.trim()) throw new CliError("--home must not be empty", 2);
    const home = resolve(values.home);
    // PLUGHIVE_ROOT wins over PLUGHIVE_HOME in loadConfig: set both so the
    // flag always decides.
    env.PLUGHIVE_HOME = home;
    env.PLUGHIVE_ROOT = home;
  }
  // Refuse an unsafe bind before anything boots.
  try {
    applySecretFiles(env);
    const cfg = loadConfig({ env });
    assertNoMultiKeyConfig(env);
    assertSafeBind(cfg.bindHost, cfg.accessKey);
    assertEncryptedSecretsOnNetwork(cfg.bindHost, env);
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
  return { help: false, open: values.open === true };
}

/** Resolves null once the daemon listens: the process keeps running. */
export async function runStart(argv: string[], io: CliIo): Promise<number | null> {
  const flags = applyStartFlags(argv, io.env);
  if (flags.help) {
    io.out(START_HELP);
    return EXIT_OK;
  }
  const { startDaemon } = await import("../server.js");
  let daemon: Awaited<ReturnType<typeof startDaemon>>;
  try {
    daemon = await startDaemon({ banner: true });
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
  if (flags.open && !(await openInBrowser(daemon.dashboardLink()))) {
    io.err(
      'Could not open a browser. Run "plughive dashboard --print" on this machine for the link.',
    );
  }
  return null;
}
