// src/cli/service.ts
//
//   plughive service install|uninstall|status [--dry-run] [--home DIR]
//
// Keeps the daemon running at login with the OS's own supervisor:
//   macOS    a LaunchAgent  (~/Library/LaunchAgents/dev.plughive.daemon.plist)
//   Linux    a systemd --user unit (~/.config/systemd/user/plughive.service)
//   Windows  a Task Scheduler logon task "plughive" (from a task XML)
// Every supervisor starts `node <this cli.js> start` directly, as separate
// arguments: no shell parses a path. The definition files are built by the
// pure functions below so tests cover all three OSes on any of them.
// Secrets never go into a definition file: only PLUGHIVE_HOME, PLUGHIVE_PORT,
// PLUGHIVE_SECRETS and (macOS, Linux) PATH are carried over.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicReplaceSync, userHome, writeFileAtomicSync } from "../lib/platform.js";
import { connect, daemonTarget, daemonUp } from "./api.js";
import { CliError, type CliIo, EXIT_FAIL, EXIT_OK, EXIT_USAGE, parse } from "./args.js";

export const SERVICE_HELP = `Usage: plughive service <install|uninstall|status> [options]

Start the daemon at login and restart it when it stops, using this
computer's own service manager (launchd, systemd --user, Task Scheduler).

Commands:
  install       write the service definition and start it
  uninstall     stop the service and remove its definition
  status        show whether the service is installed and running

Options:
  --dry-run     print the definition and the commands, change nothing
  --force       install even though a daemon already answers (e.g. the
                menu-bar app runs one); the two would compete for the port
  --home DIR    data directory of the daemon (PLUGHIVE_HOME)
  -h, --help    show this help`;

export const SERVICE_LABEL = "dev.plughive.daemon";
export const SYSTEMD_UNIT = "plughive.service";
export const WINDOWS_TASK = "plughive";

/** Environment variables a service definition may carry (never a secret). */
const CARRIED_ENV = ["PLUGHIVE_HOME", "PLUGHIVE_ROOT", "PLUGHIVE_PORT", "PLUGHIVE_SECRETS"];

export interface ServiceSpec {
  /** Absolute path of the node binary. */
  node: string;
  /** Absolute path of the built cli.js. */
  script: string;
  /** Folder for stdout/stderr logs. */
  logs: string;
  /** Environment the daemon gets. */
  env: Record<string, string>;
}

export interface ServicePlan {
  /** The definition file and its content. */
  file: string;
  content: string;
  /** Commands run after writing it (file, args), in order. */
  start: Array<[string, string[]]>;
  /** Commands that stop it before removal. Failures are ignored. */
  stop: Array<[string, string[]]>;
  /** A command whose exit code 0 means "running". */
  query: [string, string[]];
}

/**
 * Refuse a value that could break out of the definition file's syntax: a
 * newline, carriage return or NUL in a path or environment value would inject
 * systemd directives or plist/task XML lines. Throws a CliError saying which
 * value is the problem.
 */
function assertNoLineBreaks(value: string, what: string): void {
  if (/[\n\r\0]/.test(value)) {
    throw new CliError(
      `${what} must not contain a newline, carriage return or NUL character (got ${JSON.stringify(
        value.slice(0, 120),
      )})`,
    );
  }
}

function xml(s: string): string {
  assertNoLineBreaks(s, "an XML value");
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function launchAgentPlist(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(spec.node)}</string><string>${xml(spec.script)}</string><string>start</string>
  </array>
  <key>EnvironmentVariables</key><dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(posix.join(spec.logs, "stdout.log"))}</string>
  <key>StandardErrorPath</key><string>${xml(posix.join(spec.logs, "stderr.log"))}</string>
</dict></plist>
`;
}

/**
 * systemd quoting: double quotes with \\ " and % escaped. `$` is doubled only
 * in ExecStart= (where systemd expands variables); Environment= never expands
 * `$`, so doubling it there would change the value.
 */
function sdQuote(s: string, exec = true): string {
  assertNoLineBreaks(s, "a systemd value");
  const q = s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
  return `"${exec ? q.replace(/\$/g, "$$$$") : q}"`;
}

export function systemdUnit(spec: ServiceSpec): string {
  const env = Object.entries(spec.env)
    .map(([k, v]) => `Environment=${sdQuote(`${k}=${v}`, false)}`)
    .join("\n");
  return `[Unit]
Description=plughive daemon (local MCP gateway)
After=network-online.target

[Service]
Type=simple
ExecStart=${sdQuote(spec.node)} ${sdQuote(spec.script)} start
${env}
UMask=0077
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
`;
}

/**
 * A Task Scheduler task (UTF-16 is not required by schtasks /XML when the
 * declaration says UTF-8 and the file has no BOM). It runs at this user's
 * logon, as this user, without elevation, and restarts on failure.
 */
export function windowsTaskXml(spec: ServiceSpec, userId: string): string {
  // Task Scheduler passes Arguments to CreateProcess verbatim: quote paths.
  const args = `"${spec.script.replace(/"/g, "")}" start`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>plughive daemon (local MCP gateway)</Description></RegistrationInfo>
  <Triggers><LogonTrigger><Enabled>true</Enabled><UserId>${xml(userId)}</UserId></LogonTrigger></Triggers>
  <Principals><Principal id="Author"><UserId>${xml(userId)}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Hidden>false</Hidden>
    <RestartOnFailure><Interval>PT1M</Interval><Count>999</Count></RestartOnFailure>
  </Settings>
  <Actions Context="Author"><Exec><Command>${xml(spec.node)}</Command><Arguments>${xml(args)}</Arguments><WorkingDirectory>${xml(spec.logs)}</WorkingDirectory></Exec></Actions>
</Task>
`;
}

export function planService(
  spec: ServiceSpec,
  platform: NodeJS.Platform,
  opts: { home: string; uid?: number; userId?: string },
): ServicePlan {
  if (platform === "darwin") {
    const file = posix.join(opts.home, "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
    const domain = `gui/${opts.uid ?? 501}`;
    return {
      file,
      content: launchAgentPlist(spec),
      stop: [["launchctl", ["bootout", `${domain}/${SERVICE_LABEL}`]]],
      start: [["launchctl", ["bootstrap", domain, file]]],
      query: ["launchctl", ["print", `${domain}/${SERVICE_LABEL}`]],
    };
  }
  if (platform === "win32") {
    return {
      file: win32.join(spec.logs, "..", "plughive-task.xml"),
      content: windowsTaskXml(spec, opts.userId ?? ""),
      stop: [["schtasks", ["/End", "/TN", WINDOWS_TASK]]],
      start: [
        [
          "schtasks",
          [
            "/Create",
            "/TN",
            WINDOWS_TASK,
            "/XML",
            win32.join(spec.logs, "..", "plughive-task.xml"),
            "/F",
          ],
        ],
        ["schtasks", ["/Run", "/TN", WINDOWS_TASK]],
      ],
      query: ["schtasks", ["/Query", "/TN", WINDOWS_TASK]],
    };
  }
  const file = posix.join(opts.home, ".config", "systemd", "user", SYSTEMD_UNIT);
  return {
    file,
    content: systemdUnit(spec),
    stop: [["systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]]],
    start: [
      ["systemctl", ["--user", "daemon-reload"]],
      ["systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]],
    ],
    query: ["systemctl", ["--user", "is-active", "--quiet", SYSTEMD_UNIT]],
  };
}

/** The built cli.js next to this file, or a clear error when running from source. */
export function builtCliPath(here = fileURLToPath(import.meta.url)): string {
  const script = join(dirname(here), "..", "cli.js");
  if (!here.endsWith(".js") || !existsSync(script)) {
    throw new CliError(
      'no built cli.js found; run "pnpm build" first, then run "node dist/src/cli.js service install"',
    );
  }
  return resolve(script);
}

export function serviceEnv(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of CARRIED_ENV) {
    const v = env[k]?.trim();
    // A newline in a carried value would inject a directive into the unit or
    // plist file; refuse it instead of quoting around it.
    if (v) assertNoLineBreaks(v, `the value of ${k}`);
    if (v) out[k] = v;
  }
  // launchd and systemd start programs with a minimal PATH; the packs look up
  // ffmpeg, whisper and friends on it. Windows tasks get the user's PATH.
  // Only absolute entries, once each: "./node_modules/.bin" or "~/x" would
  // resolve against the supervisor's working directory, not the user's.
  if (platform !== "win32" && env.PATH) {
    assertNoLineBreaks(env.PATH, "the value of PATH");
    const dirs = [...new Set(env.PATH.split(":").filter((d) => d.startsWith("/")))];
    if (dirs.length > 0) out.PATH = dirs.join(":");
  }
  return out;
}

function run(file: string, args: string[]): { ok: boolean; out: string } {
  try {
    const out = execFileSync(file, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return { ok: false, out: (err.stderr || err.message || "").trim() };
  }
}

const show = (file: string, args: string[]) =>
  [file, ...args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(" ");

export async function runService(argv: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(
    "service",
    argv,
    {
      "dry-run": { type: "boolean" },
      force: { type: "boolean" },
      home: { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    true,
  );
  if (values.help || positionals.length === 0) {
    io.out(SERVICE_HELP);
    return values.help ? EXIT_OK : EXIT_USAGE;
  }
  const action = positionals[0];
  if (positionals.length > 1 || !["install", "uninstall", "status"].includes(action ?? "")) {
    throw new CliError(
      `unknown service command "${positionals.join(" ")}"\nRun "plughive service --help".`,
      EXIT_USAGE,
    );
  }
  const env = { ...io.env };
  if (values.home !== undefined) {
    env.PLUGHIVE_HOME = resolve(values.home);
    env.PLUGHIVE_ROOT = env.PLUGHIVE_HOME;
  }
  const platform = process.platform;
  const dataDir = resolve(
    (env.PLUGHIVE_ROOT || env.PLUGHIVE_HOME || join(userHome(), ".plughive")).replace(
      /^~(?=$|[\\/])/,
      userHome(),
    ),
  );
  const dryRun = values["dry-run"] === true;
  const spec: ServiceSpec = {
    node: process.execPath,
    // Only install writes the path into a service; status and uninstall need no build.
    script: dryRun || action !== "install" ? safeCliPath() : builtCliPath(),
    logs: join(dataDir, "logs"),
    env: serviceEnv(env, platform),
  };
  const plan = planService(spec, platform, {
    home: userHome(),
    ...(typeof process.getuid === "function" ? { uid: process.getuid() } : {}),
    userId: [env.USERDOMAIN, env.USERNAME].filter(Boolean).join("\\"),
  });

  if (action === "status") {
    const installed = existsSync(plan.file);
    const running = installed && run(...plan.query).ok;
    // Only the URL is needed: a fresh home has no admin token yet.
    const target = daemonTarget(env);
    const up = await daemonUp(target.localUrl);
    io.out(`service:   ${installed ? plan.file : "not installed"}`);
    io.out(`running:   ${running ? "yes" : "no"}`);
    io.out(`daemon:    ${up ? `answering on ${target.baseUrl}` : "not answering"}`);
    return installed && running ? EXIT_OK : EXIT_FAIL;
  }

  if (dryRun) {
    io.out(`# ${plan.file}`);
    io.out(plan.content);
    for (const [f, a] of action === "install" ? [...plan.stop, ...plan.start] : plan.stop)
      io.out(`$ ${show(f, a)}`);
    return EXIT_OK;
  }

  if (action === "install") {
    if (!existsSync(plan.file) && values.force !== true) {
      const target = daemonTarget(env);
      if (await daemonUp(target.localUrl)) {
        throw new CliError(
          `a daemon already answers on ${target.baseUrl} (the menu-bar app, or "plughive start"). Stop it first, or pass --force to install the service anyway.`,
        );
      }
    }
    mkdirSync(spec.logs, { recursive: true, mode: 0o700 });
    mkdirSync(dirname(plan.file), { recursive: true });
    if (existsSync(plan.file) && readFileSync(plan.file, "utf8") !== plan.content) {
      io.out(`Replacing ${plan.file}`);
    }
    for (const [f, a] of plan.stop) run(f, a);
    writeFileAtomicSync(plan.file, plan.content);
    for (const [f, a] of plan.start) {
      const r = run(f, a);
      if (!r.ok) throw new CliError(`"${show(f, a)}" failed: ${r.out || "no output"}`);
    }
    io.out(`Installed and started: ${plan.file}`);
    io.out(`Logs: ${spec.logs}`);
    return EXIT_OK;
  }

  // uninstall: ask the daemon to stop cleanly first (Windows' schtasks /End
  // ends only the task, which may leave node running), then the supervisor.
  for (const [f, a] of plan.stop) run(f, a);
  if (platform === "win32") {
    try {
      const { target, api } = connect(env);
      if (await daemonUp(target.localUrl)) await api.post("/api/admin/shutdown");
    } catch {
      // Not running, or no admin token: nothing more to stop.
    }
    run("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"]);
  }
  rmSync(plan.file, { force: true });
  if (platform === "linux") run("systemctl", ["--user", "daemon-reload"]);
  io.out(`Removed the service (${plan.file}).`);
  return EXIT_OK;
}

/** For --dry-run from source: the would-be built path, without failing. */
function safeCliPath(): string {
  try {
    return builtCliPath();
  } catch {
    return resolve(
      join(dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "src", "cli.js"),
    );
  }
}
