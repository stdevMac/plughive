// src/lib/lazy-mcp-client.ts: the MCP client SDK, loaded on first use.
//
// The client side of the SDK (plus its stdio transport) is only needed once a
// remote or local MCP server is mounted or an OAuth sign-in runs. Most daemons
// mount none, so it stays off the startup path. Each promise is shared, so the
// cost is paid once.
type ClientModule = typeof import("@modelcontextprotocol/client");
type StdioModule = typeof import("@modelcontextprotocol/client/stdio");

let client: ClientModule | undefined;
let clientLoading: Promise<ClientModule> | undefined;
let stdioLoading: Promise<StdioModule> | undefined;

export function loadMcpClient(): Promise<ClientModule> {
  clientLoading ??= import("@modelcontextprotocol/client").then((m) => {
    client = m;
    return m;
  });
  return clientLoading;
}

/** The client SDK when it is already loaded. Errors it throws cannot exist before that. */
export function loadedMcpClient(): ClientModule | undefined {
  return client;
}

export function loadMcpStdio(): Promise<StdioModule> {
  stdioLoading ??= import("@modelcontextprotocol/client/stdio");
  return stdioLoading;
}
