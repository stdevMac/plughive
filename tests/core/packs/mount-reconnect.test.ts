// A stdio mount whose server dies is reconnected on its own, with backoff.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PackMounts } from "../../../src/core/packs/mounts.js";

const silent = { info() {}, warn() {} };
const server = fileURLToPath(new URL("../../fixtures/flaky-mcp-server.mjs", import.meta.url));

let mounts: PackMounts | null = null;
let dir = "";
afterEach(async () => {
  await mounts?.stop();
  mounts = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

async function until(check: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("mount auto-reconnect", () => {
  it("reconnects a stdio mount after its server exits", async () => {
    dir = mkdtempSync(join(tmpdir(), "plughive-reconnect-"));
    const log = join(dir, "launches.log");
    const mount = {
      id: "user/flaky",
      prefix: "flaky",
      transport: "stdio" as const,
      command: process.execPath,
      args: [server, log],
      env: {},
    };
    mounts = new PackMounts({ logger: silent, reconnectBaseMs: 10 });
    const m = mounts;
    await m.sync({ resolvedMounts: async () => [mount] } as never);
    expect(m.connection(mount.id)).toMatchObject({ connected: true, tools: 1 });

    // The first server exits; the mount says so, then comes back.
    await until(() => !m.connection(mount.id).connected);
    expect(m.connection(mount.id).error).toMatch(/connection lost/);
    await until(() => m.connection(mount.id).connected);
    expect(m.connection(mount.id)).toEqual({ connected: true, tools: 1, error: null });
    expect(readFileSync(log, "utf8").trim().split("\n")).toEqual(["session 1", "session 2"]);
  });
});
