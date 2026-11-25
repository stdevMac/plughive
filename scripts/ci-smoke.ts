/**
 * Cross-OS smoke test of the built daemon (run after `pnpm build`, on every
 * OS in CI, and locally with `pnpm smoke:ci`).
 *
 * Starts dist/src/server.js on port 7795 with a throwaway PLUGHIVE_HOME and a
 * throwaway admin token, then checks, all free and offline:
 *   - /health answers;
 *   - an MCP client can initialize and call tools through execute_tool:
 *     local_status (which probes ffmpeg and the other local engines),
 *     list_installable and software_status for ffmpeg;
 *   - a secret round-trip through this OS's default backend (Keychain on
 *     macOS, Credential Manager on Windows, the Secret Service or the file on
 *     Linux) under a throwaway service name: store, read back as present,
 *     delete, read back as absent. The value itself is never returned by the
 *     API, so presence and source are what is checked.
 * Exits non-zero on the first failure. Never touches ~/.plughive.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.SMOKE_PORT ?? 7795);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = `smoke-${randomBytes(24).toString("base64url")}`;
const SERVICE = `plughive-smoke-${randomBytes(4).toString("hex")}`;
// A secret some bundled pack declares; any value will do, it is never used.
const SECRET = { pack: "fal", name: "FAL_KEY" };
// Credentials in the runner's environment never reach the daemon under test.
const SECRET_NAME = /(KEY|KEY_ID|TOKEN|SECRET|PASSPHRASE|PASSWORD|_LOGIN|_PAT|CREDENTIALS?)$/i;

const log = (msg: string) => process.stdout.write(`[smoke] ${msg}\n`);

function fail(msg: string): never {
  throw new Error(msg);
}

function daemonEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_NAME.test(k) || k.startsWith("PLUGHIVE_")) continue;
    env[k] = v;
  }
  return {
    ...env,
    PLUGHIVE_PORT: String(PORT),
    PLUGHIVE_BIND_HOST: "127.0.0.1",
    PLUGHIVE_HOME: home,
    PLUGHIVE_NO_DOTENV: "1",
    PLUGHIVE_LOG_LEVEL: "warn",
    PLUGHIVE_ADMIN_TOKEN: ADMIN,
    PLUGHIVE_KEYCHAIN_SERVICE: SERVICE,
  };
}

async function waitForHealth(child: ChildProcess, timeoutMs = 60_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) fail(`daemon exited early with code ${child.exitCode}`);
    try {
      const r = await fetch(`${BASE}/health`);
      if (r.ok) return (await r.json()) as { ok: boolean; version: string };
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  fail("daemon did not become healthy in time");
}

async function stopDaemon(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  child.kill(process.platform === "win32" ? undefined : "SIGTERM");
  const timer = setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}

/** One JSON-RPC reply, whether the server answered with JSON or an SSE stream. */
// biome-ignore lint/suspicious/noExplicitAny: smoke script reads JSON-RPC replies loosely
async function readRpc(res: Response): Promise<any> {
  const text = await res.text();
  if (!res.ok) fail(`HTTP ${res.status}: ${text.slice(0, 400)}`);
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const data = text
      .split("\n")
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim())
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .find((m) => m.id !== undefined);
    return data ?? fail(`no JSON-RPC reply in the stream: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text);
}

let nextId = 1;
async function callTool(name: string, args: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/call",
      "mcp-name": "execute_tool",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: nextId++,
      method: "tools/call",
      params: {
        name: "execute_tool",
        arguments: { name, arguments: args },
        _meta: {
          "io.modelcontextprotocol/protocolVersion": "2026-07-28",
          "io.modelcontextprotocol/clientInfo": { name: "ci-smoke", version: "1.0.0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const reply = await readRpc(res);
  if (reply.error) fail(`${name}: ${JSON.stringify(reply.error)}`);
  const result = reply.result;
  if (result?.isError) fail(`${name} failed: ${JSON.stringify(result.content).slice(0, 600)}`);
  let out = result?.structuredContent;
  if (!out) {
    const text = result?.content?.find((c: { type: string }) => c.type === "text")?.text;
    try {
      out = JSON.parse(text);
    } catch {
      return text;
    }
  }
  // execute_tool wraps the tool's own result: {ok, result} or {ok: false, error}.
  if (out && typeof out === "object" && "ok" in out) {
    if (out.ok !== true) fail(`${name} failed: ${JSON.stringify(out.error ?? out).slice(0, 600)}`);
    return out.result;
  }
  return out;
}

async function admin(method: string, path: string, body?: unknown) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${ADMIN}`,
      "content-type": "application/json",
      "x-plughive-csrf": "1",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) fail(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(json)}`);
  return json;
}

async function secretRow() {
  const list = (await admin("GET", "/api/secrets")) as {
    backend: string;
    secrets: { pack: string; name: string; present: boolean; source: string | null }[];
  };
  const row = list.secrets.find((s) => s.pack === SECRET.pack && s.name === SECRET.name);
  if (!row) fail(`${SECRET.pack}/${SECRET.name} is not a declared secret`);
  return { backend: list.backend, row };
}

async function main() {
  const server = join(ROOT, "dist", "src", "server.js");
  if (!existsSync(server)) fail("dist/src/server.js is missing: run pnpm build first");
  const home = mkdtempSync(join(tmpdir(), "plughive-smoke-"));
  log(`${process.platform}/${process.arch}, node ${process.version}, home ${home}`);
  const child = spawn(process.execPath, [server], {
    cwd: ROOT,
    env: daemonEnv(home),
    stdio: ["ignore", "inherit", "inherit"],
  });
  let stored = false;
  try {
    const health = await waitForHealth(child);
    log(`health ok, version ${health.version}`);

    const local = (await callTool("local_status")) as Record<string, unknown>;
    log(`local_status: ${JSON.stringify(local).slice(0, 300)}`);

    const installable = (await callTool("list_installable")) as {
      items: { id: string; installed?: boolean; install_kind?: string }[];
    };
    if (!Array.isArray(installable.items) || installable.items.length < 10) {
      fail(`list_installable returned ${JSON.stringify(installable).slice(0, 300)}`);
    }
    log(`list_installable: ${installable.items.length} programs`);

    const ffmpeg = (await callTool("software_status", { id: "ffmpeg" })) as Record<string, unknown>;
    log(`software_status ffmpeg: ${JSON.stringify(ffmpeg).slice(0, 300)}`);

    const before = await secretRow();
    log(`secrets backend: ${before.backend}`);
    if (before.row.present) fail("the throwaway secret is already present");
    await admin("PUT", `/api/secrets/${SECRET.pack}/${SECRET.name}`, {
      value: `smoke-${randomBytes(16).toString("hex")}`,
    });
    stored = true;
    const after = await secretRow();
    if (!after.row.present) fail("the stored secret does not read back as present");
    if (after.row.source === "env") fail("the secret came from the environment, not the store");
    log(`secret stored and read back (source ${after.row.source})`);
    await admin("DELETE", `/api/secrets/${SECRET.pack}/${SECRET.name}`);
    stored = false;
    if ((await secretRow()).row.present) fail("the deleted secret still reads back as present");
    log("secret deleted");
    log("all checks passed");
  } finally {
    if (stored) {
      await admin("DELETE", `/api/secrets/${SECRET.pack}/${SECRET.name}`).catch(() => undefined);
    }
    await stopDaemon(child);
    rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}

main().catch((err) => {
  process.stderr.write(`[smoke] FAILED: ${(err as Error).message}\n`);
  process.exit(1);
});
