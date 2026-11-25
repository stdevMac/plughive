// src/cli/dashboard.ts
//
//   plughive dashboard [--print] [--home DIR]
//
// Opens (or prints) the dashboard sign-in link: the daemon URL with the admin
// token in the fragment (#token=...), which no server log or Referer sees.
import { resolve } from "node:path";
import { dashboardUrl, loadOrCreateAdminToken } from "../lib/admin-token.js";
import { daemonTarget, daemonUp } from "./api.js";
import { CliError, type CliIo, EXIT_OK, parse } from "./args.js";
import { openInBrowser } from "./open.js";

export const DASHBOARD_HELP = `Usage: plughive dashboard [options]

Open the dashboard of the local daemon, signed in.

Options:
  --print       print the sign-in link instead of opening a browser
  --home DIR    data directory of the daemon (PLUGHIVE_HOME)
  -h, --help    show this help

The link carries the admin token. Treat it like a password: anyone who has
it can administer the daemon.`;

export async function runDashboard(argv: string[], io: CliIo): Promise<number> {
  const { values } = parse("dashboard", argv, {
    print: { type: "boolean" },
    home: { type: "string" },
    help: { type: "boolean", short: "h" },
  });
  if (values.help) {
    io.out(DASHBOARD_HELP);
    return EXIT_OK;
  }
  const env = { ...io.env };
  if (values.home !== undefined) {
    env.PLUGHIVE_HOME = resolve(values.home);
    env.PLUGHIVE_ROOT = env.PLUGHIVE_HOME;
  }
  const target = daemonTarget(env);
  let token: string;
  try {
    token = loadOrCreateAdminToken(target.config.root, env).token;
  } catch (e) {
    throw new CliError(e instanceof Error ? e.message : String(e));
  }
  const link = dashboardUrl(target.baseUrl, token);
  if (!(await daemonUp(target.localUrl))) {
    io.err(
      `No daemon answers on ${target.baseUrl} yet; the link works once "plughive start" runs.`,
    );
  }
  if (values.print) {
    io.out(link);
    return EXIT_OK;
  }
  if (await openInBrowser(link)) {
    io.out(`Opened the dashboard of ${target.baseUrl}`);
    return EXIT_OK;
  }
  throw new CliError('Could not open a browser. Run "plughive dashboard --print" for the link.');
}
