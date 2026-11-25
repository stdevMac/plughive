// "Connect your agent" snippets. The access key is never filled in: the
// placeholder stays for the user to replace.
import { t } from "../i18n";

export const KEY_PLACEHOLDER = "<your access key>";

/**
 * The exact mcp-remote release the Claude Desktop snippet runs: a copy of
 * MCP_REMOTE_PACKAGE in src/clients/index.ts (that module uses node:fs and
 * cannot be bundled into the dashboard). Bump both together.
 */
export const MCP_REMOTE_PACKAGE = "mcp-remote@0.16.7";

export interface Snippet {
  id: string;
  label: string;
  where: string;
  language: string;
  code: string;
  note?: string;
}

export function connectSnippets(url: string, withKey: boolean, name = "plughive"): Snippet[] {
  const auth = `Bearer ${KEY_PLACEHOLDER}`;
  const json = (v: unknown) => JSON.stringify(v, null, 2);
  // The same entry `plughive connect claude-desktop` writes (src/clients/index.ts):
  // the key travels in an env var the bridge turns into a header, never as a
  // command-line argument (visible in ps), and the transport is pinned.
  let loopback = false;
  try {
    const host = new URL(url).hostname;
    loopback = host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1";
  } catch {
    loopback = false;
  }
  const desktopArgs = [
    "-y",
    MCP_REMOTE_PACKAGE,
    url,
    "--transport",
    "http-only",
    ...(url.startsWith("http:") && !loopback ? ["--allow-http"] : []),
    ...(withKey ? ["--header", "Authorization:${AUTH_HEADER}"] : []),
  ];

  return [
    {
      id: "claude-code",
      label: "Claude Code",
      where: t("connect.snippets.claudeCode.where"),
      language: "shell",
      code: withKey
        ? `claude mcp add --transport http ${name} ${url} \\\n  --header "Authorization: ${auth}"`
        : `claude mcp add --transport http ${name} ${url}`,
    },
    {
      id: "claude-desktop",
      label: "Claude Desktop",
      where: t("connect.snippets.claudeDesktop.where", { file: "claude_desktop_config.json" }),
      language: "json",
      code: json({
        mcpServers: {
          [name]: {
            command: "npx",
            args: desktopArgs,
            // Claude Desktop mangles spaces inside args on some platforms, so
            // the header value sits in an env var (mcp-remote's documented
            // workaround), exactly like the entry the CLI writes.
            ...(withKey ? { env: { AUTH_HEADER: auth } } : {}),
          },
        },
      }),
      note: t("connect.snippets.claudeDesktop.note"),
    },
    {
      id: "cursor",
      label: "Cursor",
      where: "~/.cursor/mcp.json",
      language: "json",
      code: json({
        mcpServers: { [name]: { url, ...(withKey ? { headers: { Authorization: auth } } : {}) } },
      }),
    },
    {
      id: "codex",
      label: "Codex",
      where: "~/.codex/config.toml",
      language: "toml",
      code: [
        `[mcp_servers.${name}]`,
        `url = "${url}"`,
        ...(withKey ? [`http_headers = { "Authorization" = "${auth}" }`] : []),
      ].join("\n"),
    },
    {
      id: "hermes",
      label: "Hermes",
      where: "~/.hermes/config.yaml",
      language: "yaml",
      code: [
        "mcp_servers:",
        `  ${name}:`,
        `    url: "${url}"`,
        ...(withKey ? ["    headers:", `      Authorization: "${auth}"`] : []),
      ].join("\n"),
    },
    {
      id: "other",
      label: t("connect.snippets.other.label"),
      where: t("connect.snippets.other.where"),
      language: "text",
      code: [
        `URL: ${url}`,
        "Transport: Streamable HTTP",
        ...(withKey ? [`Header: Authorization: ${auth}`] : []),
      ].join("\n"),
    },
  ];
}
