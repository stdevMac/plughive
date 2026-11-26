import { describe, expect, it } from "vitest";
import { MCP_REMOTE_PACKAGE, connectSnippets } from "../src/lib/snippets";

describe("connectSnippets", () => {
  it("pins the mcp-remote release in the Claude Desktop snippet", () => {
    expect(MCP_REMOTE_PACKAGE).toMatch(/^mcp-remote@\d+\.\d+\.\d+$/);
    for (const withKey of [false, true]) {
      const desktop = connectSnippets("http://127.0.0.1:7870/mcp", withKey).find(
        (s) => s.id === "claude-desktop",
      );
      const args = JSON.parse(desktop?.code ?? "{}").mcpServers.plughive.args as string[];
      expect(args.slice(0, 2)).toEqual(["-y", MCP_REMOTE_PACKAGE]);
      expect(args).not.toContain("mcp-remote");
    }
  });
});

describe("claude-desktop snippet matches the CLI entry (H-10)", () => {
  const entry = (url: string, withKey: boolean) =>
    JSON.parse(connectSnippets(url, withKey).find((s) => s.id === "claude-desktop")?.code ?? "{}")
      .mcpServers.plughive;

  it("pins the transport to http-only and never puts the key in args", () => {
    for (const withKey of [false, true]) {
      for (const url of ["http://127.0.0.1:7870/mcp", "https://store.example.com/mcp"]) {
        const e = entry(url, withKey);
        expect(e.args).toContain("--transport");
        expect(e.args).toContain("http-only");
        expect(e.args).not.toContain("--allow-http");
        expect(JSON.stringify(e.args)).not.toContain("<your access key>");
      }
    }
  });

  it("carries the key in env AUTH_HEADER with the placeholder header arg", () => {
    const e = entry("http://127.0.0.1:7870/mcp", true);
    const i = e.args.indexOf("--header");
    expect(e.args[i + 1]).toBe("Authorization:${AUTH_HEADER}");
    expect(e.env).toEqual({ AUTH_HEADER: "Bearer <your access key>" });
  });

  it("adds --allow-http only for plain http to a non-loopback host", () => {
    expect(entry("http://example.com:8080/mcp", false).args).toContain("--allow-http");
    expect(entry("http://localhost:7870/mcp", false).args).not.toContain("--allow-http");
    expect(entry("https://example.com/mcp", false).args).not.toContain("--allow-http");
  });
});

describe("connectSnippets quoting (D-M14)", () => {
  it("quotes IPv6 bracketed URLs and special characters for shell, TOML, and YAML", () => {
    const ipv6 = connectSnippets("http://[::1]:7870/mcp", true);
    const claude = ipv6.find((s) => s.id === "claude-code")?.code ?? "";
    expect(claude).toContain("'http://[::1]:7870/mcp'");

    const nastyUrl = 'http://127.0.0.1:7870/mcp?a="1"&b=$(id)#\'x\ninjected: true';
    const nastyName = "plug'hive\"$(id)\n[evil]";
    const snippets = connectSnippets(nastyUrl, true, nastyName);

    const shell = snippets.find((s) => s.id === "claude-code")?.code ?? "";
    expect(shell).toContain(`'plug'\\''hive"$(id)\n[evil]'`);
    expect(shell).toContain(`'http://127.0.0.1:7870/mcp?a="1"&b=$(id)#\'\\''x\ninjected: true'`);

    const toml = snippets.find((s) => s.id === "codex")?.code ?? "";
    expect(toml).toContain(`[mcp_servers.${JSON.stringify(nastyName)}]`);
    expect(toml).toContain(`url = ${JSON.stringify(nastyUrl)}`);
    expect(toml).not.toContain("\ninjected: true");

    const yaml = snippets.find((s) => s.id === "hermes")?.code ?? "";
    expect(yaml).toContain(`  ${JSON.stringify(nastyName)}:`);
    expect(yaml).toContain(`    url: ${JSON.stringify(nastyUrl)}`);
    expect(yaml).not.toContain("\ninjected: true");
  });
});
