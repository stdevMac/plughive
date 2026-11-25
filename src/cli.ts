#!/usr/bin/env node
// src/cli.ts: the plughive command.
//
// IMPORTANT: ./lib/network.js MUST be the first import, as in server.ts: it
// sets the global fetch dispatcher before anything else can call fetch().
import "./lib/network.js";

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CliError, type CliIo, EXIT_OK, EXIT_USAGE, processIo, safeIo } from "./cli/args.js";
import { enablePrivateCompileCache } from "./lib/compile-cache.js";
import { packageVersion } from "./lib/version.js";

export const MAIN_HELP = `Usage: plughive [command] [options]

A local MCP gateway: one endpoint for your agents, your own provider keys.

Commands:
  start         start the daemon in the foreground (default)
  dashboard     open the dashboard, signed in (--print to print the link)
  doctor        check that this machine can run the daemon
  status        show whether the daemon runs, with pack and tool counts
  pack          packs: list, show, consent, enable, disable, reload, settings, add, remove
  cursor-link   print a link that adds the daemon to Cursor
  clients       list MCP clients on this computer and their state
  connect       add the daemon to a client (claude-code, cursor, codex, ...)
  service       start the daemon at login (install, uninstall, status)
  version       print the version

What the dashboard shows and does (the daemon must run):
  tools         list, show and call tools (the Playground)
  jobs          list, show, wait for and cancel background jobs
  artifacts     list, download and delete generated files (the Library)
  approvals     pending spend requests: approve or deny them
  policy        spend caps and approval rules
  usage         spend and calls by vendor, capability and tool
  secrets       API keys: what is set, set or remove one (values never shown)
  capabilities  which provider serves each capability, and your preference
  mounts        other MCP servers: add, switch, sign in, smart mount
  triggers      workflows on a schedule or a webhook
  software      programs the tools use: install and remove them
  setup         what a goal still needs on this machine, and how to get it
  profiles      what each agent profile exposes (the Exposure page)
  prefs         dashboard preferences (language)
  watch         follow jobs, packs and approvals as they change
  api           call any /api endpoint with the admin token

Run "plughive <command> --help" for the options of a command.

Settings come from environment variables (PLUGHIVE_PORT, PLUGHIVE_HOME,
PLUGHIVE_ACCESS_KEY, ...). The CLI does not read a .env file; use
"node --env-file=.env" or export the variables. See docs/configuration.md.`;

export { packageVersion };

/**
 * Runs one command. Resolves the exit code, or null when the command keeps
 * the process alive (start). Errors are printed here, never thrown.
 */
export async function runCli(argv: string[], ioIn: CliIo = processIo()): Promise<number | null> {
  // Every line a command prints goes through clean(): text from the daemon,
  // packs and mounted servers must not reach the terminal as control codes.
  const io = safeIo(ioIn);
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
      case "tools":
      case "tool":
        return await (await import("./cli/tools.js")).runTools(args, io);
      case "jobs":
      case "job":
        return await (await import("./cli/jobs.js")).runJobs(args, io);
      case "artifacts":
      case "library":
        return await (await import("./cli/jobs.js")).runArtifacts(args, io);
      case "usage":
        return await (await import("./cli/jobs.js")).runUsage(args, io);
      case "approvals":
        return await (await import("./cli/approvals.js")).runApprovals(args, io);
      case "policy":
        return await (await import("./cli/approvals.js")).runPolicy(args, io);
      case "secrets":
        return await (await import("./cli/secrets.js")).runSecrets(args, io);
      case "capabilities":
      case "caps":
        return await (await import("./cli/capabilities.js")).runCapabilities(args, io);
      case "mounts":
      case "mount":
        return await (await import("./cli/mounts.js")).runMounts(args, io);
      case "triggers":
      case "trigger":
        return await (await import("./cli/triggers.js")).runTriggers(args, io);
      case "software":
        return await (await import("./cli/software.js")).runSoftware(args, io);
      case "setup":
        return await (await import("./cli/software.js")).runSetup(args, io);
      case "profiles":
      case "profile":
        return await (await import("./cli/profiles.js")).runProfiles(args, io);
      case "prefs":
      case "preferences":
        return await (await import("./cli/profiles.js")).runPrefs(args, io);
      case "watch":
      case "events":
        return await (await import("./cli/raw.js")).runWatch(args, io);
      case "api":
        return await (await import("./cli/raw.js")).runApi(args, io);
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
