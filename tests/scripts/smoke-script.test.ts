// scripts/smoke.ts runs against a fake daemon here. Its generate_image call is a
// paid provider call, so it must only happen with an explicit --paid flag (L13).
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../..", import.meta.url));
// tsx's own CLI under this node: .bin/tsx is a shell script, which Windows cannot spawn.
const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
const script = join(root, "scripts", "smoke.ts");

let server: Server | null = null;
let cwd: string | null = null;

afterEach(async () => {
  if (server) await new Promise((r) => server?.close(r));
  server = null;
  if (cwd) rmSync(cwd, { recursive: true, force: true });
  cwd = null;
});

/** A daemon stand-in that answers the smoke script and records every tool call. */
async function fakeDaemon(): Promise<{ url: string; calls: string[] }> {
  const calls: string[] = [];
  server = createServer((req, res) => {
    if (req.url === "/health") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      const msg = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
      if (msg.id === undefined) {
        res.statusCode = 202;
        res.end();
        return;
      }
      let result: unknown = {};
      if (msg.method === "initialize") result = { serverInfo: { name: "fake" } };
      if (msg.method === "tools/list") result = { tools: [{ name: "list_artifacts" }] };
      if (msg.method === "tools/call") {
        const name = msg.params?.name ?? "";
        calls.push(name);
        const payload =
          name === "generate_image"
            ? {
                ok: true,
                result: {
                  artifacts: [{ id: "a1", bytes: 1, mime: "image/png", cost_usd: 0, url: "u" }],
                },
              }
            : { ok: true, result: { artifacts: [] } };
        result = { content: [{ type: "text", text: JSON.stringify(payload) }] };
      }
      res.setHeader("content-type", "application/json");
      res.setHeader("mcp-session-id", "s1");
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  await new Promise<void>((r) => server?.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, calls };
}

function runSmoke(url: string, args: string[]): Promise<{ code: number | null; out: string }> {
  // An empty working directory, so dotenv finds no .env to load.
  const dir = mkdtempSync(join(tmpdir(), "plughive-smoke-"));
  cwd = dir;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tsxCli, script, ...args], {
      cwd: dir,
      env: { ...process.env, PLUGHIVE_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c;
    });
    child.stderr.on("data", (c) => {
      out += c;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("scripts/smoke.ts", () => {
  it("makes no paid call without --paid", async () => {
    const d = await fakeDaemon();
    const r = await runSmoke(d.url, []);
    expect(r.code, r.out).toBe(0);
    expect(d.calls).toEqual(["list_artifacts"]);
    expect(r.out).toMatch(/pass --paid/);
  }, 30_000);

  it("calls generate_image only when --paid is given", async () => {
    const d = await fakeDaemon();
    const r = await runSmoke(d.url, ["--paid"]);
    expect(r.code, r.out).toBe(0);
    expect(d.calls).toEqual(["generate_image", "list_artifacts"]);
  }, 30_000);
});
