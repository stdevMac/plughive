#!/usr/bin/env node
// src/cli.ts: the plughive command.
//
// IMPORTANT: ./lib/network.js MUST be the first import, as in server.ts: it
// sets the global fetch dispatcher before anything else can call fetch().
import "./lib/network.js";

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, type CliIo, EXIT_OK, EXIT_USAGE, processIo } from "./cli/args.js";
import { enablePrivateCompileCache } from "./lib/compile-cache.js";

export const MAIN_HELP = `Usage: plughive [command] [options]

A local MCP gateway: one endpoint for your agents, your own provider keys.

Commands:
  start         start the daemon in the foreground (default)
  dashboard     open the dashboard, signed in (--print to print the link)
  doctor        check that this machine can run the daemon
  status        show whether the daemon runs, with pack and tool counts
  pack          list, add or remove packs
  cursor-link   print a link that adds the daemon to Cursor
  clients       list MCP clients on this computer and their state
  connect       add the daemon to a client (claude-code, cursor, codex, ...)
  service       start the daemon at login (install, uninstall, status)
  version       print the version

Run "plughive <command> --help" for the options of a command.

Settings come from environment variables (PLUGHIVE_PORT, PLUGHIVE_HOME,
PLUGHIVE_ACCESS_KEY, ...). The CLI does not read a .env file; use
"node --env-file=.env" or export the variables. See docs/configuration.md.`;

/** The version in the package.json next to this file (src/ or dist/src/). */
export function packageVersion(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (pkg.name === "plughive" && pkg.version) return pkg.version;
      } catch {
        // Keep looking.
      }
    }
    dir = dirname(dir);
  }
  return "unknown";
}

/**
 * Runs one command. Resolves the exit code, or null when the command keeps
 * the process alive (start). Errors are printed here, never thrown.
 */
export async function runCli(argv: string[], io: CliIo = processIo()): Promise<number | null> {
  const [first, ...rest] = argv;
  const command = first === undefined || first.startsWith("-") ? "start" : first;
  const args = first === undefined || first.startsWith("-") ? argv : rest;
  try {
    // Docker secrets (<NAME>_FILE) apply to every command: `dashboard --print`
    // inside the container needs the admin token as much as `start` does.
    (await import("./lib/secret-files.js")).applySecretFiles(io.env);
    if (command === "start" && (args.includes("--version") || args.includes("-v"))) {
      io.out(packageVersion());
      return EXIT_OK;
    }
    if (
      command === "start" &&
      first !== "start" &&
      (args.includes("--help") || args.includes("-h"))
    ) {
      io.out(MAIN_HELP);
      return EXIT_OK;
    }
    switch (command) {
      case "start":
        return await (await import("./cli/start.js")).runStart(args, io);
      case "dashboard":
        return await (await import("./cli/dashboard.js")).runDashboard(args, io);
      case "doctor":
        return await (await import("./cli/doctor.js")).runDoctor(args, io);
      case "status":
        return await (await import("./cli/status.js")).runStatus(args, io);
      case "pack":
      case "packs":
        return await (await import("./cli/pack.js")).runPack(args, io);
      case "cursor-link":
        return (await import("./cli/cursor-link.js")).runCursorLink(args, io);
      case "connect":
      case "clients":
        return (await import("./cli/connect.js")).runConnect(command, args, io);
      case "service":
        return await (await import("./cli/service.js")).runService(args, io);
      case "version":
        io.out(packageVersion());
        return EXIT_OK;
      case "help":
        io.out(MAIN_HELP);
        return EXIT_OK;
      default:
        throw new CliError(
          `unknown command "${command}"\nRun "plughive --help" for the commands.`,
          EXIT_USAGE,
        );
    }
  } catch (e) {
    if (e instanceof CliError) {
      io.err(`plughive ${command}: ${e.message}`);
      return e.exitCode;
    }
    // Unexpected: the name and message, no stack (it adds only paths).
    io.err(`plughive ${command}: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    return 1;
  }
}

function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // Keep V8's compiled code on disk, in a private per-user directory, so the
  // next start reads the ~500 modules of the daemon from the cache instead of
  // compiling them again (a few percent of startup CPU; docs/performance.md).
  // The commands load their modules after this line, so they all benefit.
  // NODE_DISABLE_COMPILE_CACHE=1 turns it off.
  enablePrivateCompileCache();
  void runCli(process.argv.slice(2)).then((code) => {
    if (code === null) return;
    // Exit once stdout is flushed: idle keep-alive sockets of fetch would
    // otherwise hold the process open for a few seconds.
    process.exitCode = code;
    process.stdout.write("", () => process.exit(code));
  });
}
