// src/cli/connect.ts
//
//   plughive clients
//   plughive connect <client> [--url URL] [--profile ID] [--name NAME] [--dry-run]
//   plughive connect <client> --remove [--name NAME]
//
// Writes (or removes) the daemon's entry in the config file of a local MCP
// client through src/clients, which keeps the rest of the file untouched,
// backs it up once and refuses a file it cannot parse.
//
// The access key is passed on only when the daemon is configured with one
// (PLUGHIVE_ACCESS_KEY); it is never printed, and a dry run shows the file
// with the key masked.
import {
  CLIENT_IDS,
  ClientConfigError,
  type ClientEnv,
  type ClientId,
  ConfigParseError,
  connectClient,
  disconnectClient,
  listClients,
  planConnect,
  restartHint,
} from "../clients/index.js";
import { daemonTarget, isThisMachine } from "./api.js";
import { CliError, type CliIo, EXIT_FAIL, EXIT_OK, EXIT_USAGE, parse } from "./args.js";

export const CONNECT_HELP = `Usage: plughive clients
       plughive connect <client> [options]

Add the daemon to an MCP client on this computer. Clients:
  ${CLIENT_IDS.join(", ")}

"plughive clients" lists them with their config file and whether each is
installed and already connected.

Options:
  --url URL       MCP endpoint to write (default: this daemon's endpoint,
                  from PLUGHIVE_PORT and PLUGHIVE_PUBLIC_URL)
  --profile ID    use the endpoint of a profile (/p/<ID>/mcp)
  --name NAME     server name in the client config (default plughive)
  --dry-run       show the file as it would be written, change nothing
  --remove        remove the entry instead of adding it
  --allow-http    write the access key even though the endpoint is plain
                  http:// on another computer (it then crosses the network
                  unencrypted)
  -h, --help      show this help

Only the one entry is changed. The file is backed up once before the first
change, and a file that does not parse is left alone. When
PLUGHIVE_ACCESS_KEY is set, it is written as an Authorization header where
the client supports one. The key is only written for an https:// endpoint
or one on this computer, unless --allow-http is given.`;

const OPTIONS = {
  url: { type: "string" },
  profile: { type: "string" },
  name: { type: "string" },
  "dry-run": { type: "boolean" },
  remove: { type: "boolean" },
  "allow-http": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const;

/** Test seam: where client config files are looked up. Empty in normal use. */
export interface ConnectDeps {
  clientEnv?: ClientEnv;
}

function isClientId(value: string): value is ClientId {
  return (CLIENT_IDS as readonly string[]).includes(value);
}

function mask(text: string, secret: string | undefined): string {
  return secret ? text.split(secret).join("********") : text;
}

function endpoint(io: CliIo, url: string | undefined, profile: string | undefined): string {
  if (url !== undefined && profile !== undefined) {
    throw new CliError("Use --url or --profile, not both.", EXIT_USAGE);
  }
  if (url !== undefined) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new CliError(`--url is not a URL: ${url}`, EXIT_USAGE);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new CliError("--url must start with http:// or https://", EXIT_USAGE);
    }
    if (parsed.username || parsed.password || parsed.search) {
      throw new CliError("--url must not carry credentials or a query string.", EXIT_USAGE);
    }
    return parsed.toString();
  }
  const base = daemonTarget(io.env).baseUrl.replace(/\/+$/, "");
  if (profile !== undefined) {
    if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(profile)) {
      throw new CliError(`--profile is not a profile id: ${profile}`, EXIT_USAGE);
    }
    return `${base}/p/${profile}/mcp`;
  }
  return `${base}/mcp`;
}

/**
 * The client sends the access key with every request. Over plain HTTP to
 * another computer anyone on the network path could read it, so that needs
 * --allow-http.
 */
function assertKeyTransport(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol === "https:" || isThisMachine(parsed.hostname)) return;
  throw new CliError(
    `refusing to write the access key for plain HTTP to ${parsed.host}: the client would send it unencrypted over the network. Use an https:// PLUGHIVE_PUBLIC_URL, or pass --allow-http if this network is trusted.`,
    EXIT_USAGE,
  );
}

function runClients(io: CliIo, deps: ConnectDeps): number {
  for (const c of listClients(deps.clientEnv ?? {})) {
    const state = c.error
      ? `config not readable: ${c.error}`
      : c.connected
        ? `connected${c.url ? ` (${c.url})` : ""}`
        : c.installed
          ? "installed, not connected"
          : "not found";
    io.out(`${c.id.padEnd(15)} ${state}`);
    io.out(`${"".padEnd(15)} ${c.configPath}`);
  }
  return EXIT_OK;
}

export function runConnect(
  command: "connect" | "clients",
  argv: string[],
  io: CliIo,
  deps: ConnectDeps = {},
): number {
  const { values, positionals } = parse(command, argv, OPTIONS, true);
  if (values.help) {
    io.out(CONNECT_HELP);
    return EXIT_OK;
  }
  if (command === "clients") return runClients(io, deps);

  const [id, ...extra] = positionals;
  if (id === undefined || extra.length > 0 || !isClientId(id)) {
    throw new CliError(
      `Name one client: ${CLIENT_IDS.join(", ")}.\nRun "plughive connect --help" for usage.`,
      EXIT_USAGE,
    );
  }
  const name = values.name;
  const env = deps.clientEnv ?? {};
  try {
    if (values.remove) {
      const res = disconnectClient(id, { ...env, ...(name ? { name } : {}) });
      io.out(res.changed ? `Removed from ${res.path}` : `Nothing to remove in ${res.path}`);
      if (res.backupPath) io.out(`Backup: ${res.backupPath}`);
      return EXIT_OK;
    }
    const url = endpoint(io, values.url, values.profile);
    const accessKey = values.url === undefined ? daemonTarget(io.env).config.accessKey : undefined;
    if (accessKey && !values["allow-http"]) assertKeyTransport(url);
    const opts = {
      ...env,
      url,
      ...(name ? { name } : {}),
      ...(accessKey ? { accessKey } : {}),
    };
    if (values["dry-run"]) {
      const plan = planConnect(id, opts);
      // Shown with a placeholder key: the file may escape the real key (a quote
      // or backslash), and then masking the raw key alone would miss it.
      const shown = accessKey
        ? planConnect(id, { ...opts, accessKey: "********" }).after
        : plan.after;
      io.out(`${plan.path} ${plan.changed ? "would become:" : "is already up to date:"}`);
      io.out(mask(shown, accessKey ?? undefined));
      if (plan.note) io.out(plan.note);
      return EXIT_OK;
    }
    const plan = planConnect(id, opts);
    const res = connectClient(id, opts);
    io.out(res.changed ? `Wrote ${res.path}` : `Already connected in ${res.path}`);
    if (res.backupPath) io.out(`Backup: ${res.backupPath}`);
    if (plan.note) io.out(plan.note);
    if (res.changed) io.out(restartHint(id));
    return EXIT_OK;
  } catch (e) {
    if (e instanceof CliError) throw e;
    if (e instanceof ClientConfigError || e instanceof ConfigParseError) {
      io.err(`plughive connect: ${e.message}`);
      return EXIT_FAIL;
    }
    throw e;
  }
}
