import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { SERVER_INFO } from "../../src/core/mcp/server.js";
import { packageVersion } from "../../src/lib/version.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as {
  version: string;
};

describe("packageVersion", () => {
  it("reads the version from package.json", () => {
    expect(packageVersion()).toBe(pkg.version);
  });

  it("is the version the server reports on /health and in the MCP handshake", () => {
    expect(SERVER_INFO.version).toBe(pkg.version);
  });
});
