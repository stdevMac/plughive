// src/cli/cursor-link.ts
//
//   plughive cursor-link [--url URL] [--name NAME] [--access-key-env VAR]
//
// Prints a Cursor MCP install link. The format is the one Cursor documents
// (https://cursor.com/docs/context/mcp/install-links):
//
//   cursor://anysphere.cursor-deeplink/mcp/install?name=<name>&config=<base64 of the server JSON>
//
// The server JSON is what one entry of mcpServers in ~/.cursor/mcp.json holds.
// The access key is never put in the link: with --access-key-env the link
// carries an Authorization header that names an environment variable, in the
// ${env:VAR} form Cursor documents for mcp.json.
import { CliError, type CliIo, EXIT_OK, EXIT_USAGE, parse } from "./args.js";

export const CURSOR_LINK_HELP = `Usage: plughive cursor-link [options]

Print a link that adds the daemon to Cursor. Open it in a browser or paste
it into the address bar; Cursor asks before it installs anything.

Options:
  --url URL             MCP endpoint (default http://127.0.0.1:7777/mcp)
  --name NAME           server name shown in Cursor (default plughive)
  --access-key-env VAR  add "Authorization: Bearer \${env:VAR}" for a daemon
                        that requires an access key. The key itself is never
                        written into the link.
  -h, --help            show this help`;

export const DEFAULT_MCP_URL = "http://127.0.0.1:7777/mcp";

export interface CursorServerConfig {
  url: string;
  headers?: Record<string, string>;
}

export function cursorServerConfig(url: string, accessKeyEnv?: string): CursorServerConfig {
  return accessKeyEnv
    ? { url, headers: { Authorization: `Bearer \${env:${accessKeyEnv}}` } }
    : { url };
}

export function cursorDeeplink(name: string, config: CursorServerConfig): string {
  const encoded = Buffer.from(JSON.stringify(config), "utf8").toString("base64");
  const query = new URLSearchParams({ name, config: encoded });
  return `cursor://anysphere.cursor-deeplink/mcp/install?${query.toString()}`;
}

export function runCursorLink(argv: string[], io: CliIo): number {
  const { values } = parse("cursor-link", argv, {
    url: { type: "string" },
    name: { type: "string" },
    "access-key-env": { type: "string" },
    help: { type: "boolean", short: "h" },
  });
  if (values.help) {
    io.out(CURSOR_LINK_HELP);
    return EXIT_OK;
  }
  const url = values.url ?? DEFAULT_MCP_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new CliError(
      "--url must be an http(s) URL such as http://127.0.0.1:7777/mcp",
      EXIT_USAGE,
    );
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username ||
    parsed.password
  ) {
    throw new CliError("--url must be an http(s) URL without credentials", EXIT_USAGE);
  }
  if (parsed.search)
    throw new CliError("--url must not carry a query (do not put a key in the URL)", EXIT_USAGE);
  const name = values.name ?? "plughive";
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) {
    throw new CliError("--name may use letters, digits, dot, dash and underscore", EXIT_USAGE);
  }
  const envVar = values["access-key-env"];
  if (envVar !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envVar)) {
    throw new CliError("--access-key-env must be an environment variable name", EXIT_USAGE);
  }
  io.out(cursorDeeplink(name, cursorServerConfig(url, envVar)));
  return EXIT_OK;
}
