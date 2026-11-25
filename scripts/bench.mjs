#!/usr/bin/env node
// scripts/bench.mjs
//
// Performance benchmark of the built daemon (run `pnpm build` first). Starts
// the daemon on a throwaway home with a throwaway keychain service and
// reports:
//   - cold start (fresh home, empty compile cache) and warm start (same home
//     and cache): spawn -> first 200 from /health
//   - CPU time the process used until it answered: far less noisy than wall
//     time on a busy machine
//   - RSS after start, idle and after the request load; shutdown time
//   - latency (p50/p95/mean) and throughput of /health, MCP initialize,
//     tools/list, a cheap tools/call, the dashboard's /api reads, the
//     dashboard index and its main script (as served with br, and plain)
//
// --entry cli (default) runs `dist/src/cli.js start`, the way the CLI, the
// login service and the app start the daemon (V8's compile cache on).
// --entry server runs dist/src/server.js directly (no compile cache).
//
//   node scripts/bench.mjs [--runs 5] [--iters 300] [--entry cli|server] [--json out.json]
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : def;
};
const RUNS = Number(arg("runs", 5));
const ITERS = Number(arg("iters", 300));
const JSON_OUT = arg("json");
const ENTRY_KIND = arg("entry", "cli");
const PORT = Number(process.env.BENCH_PORT ?? 7795);
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = randomBytes(24).toString("hex");
const SERVICE = `plughive-bench-${randomBytes(4).toString("hex")}`;
const ENTRY_ARGS =
  ENTRY_KIND === "server"
    ? [join(ROOT, "dist", "src", "server.js")]
    : [join(ROOT, "dist", "src", "cli.js"), "start"];
if (!existsSync(ENTRY_ARGS[0]))
  throw new Error(`${ENTRY_ARGS[0]} is missing: run \`pnpm build\` first`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function env(home, cache) {
  const e = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith("PLUGHIVE_") || k.startsWith("NODE_") || /KEY|TOKEN|SECRET/i.test(k)) continue;
    e[k] = v;
  }
  return {
    ...e,
    PLUGHIVE_PORT: String(PORT),
    PLUGHIVE_BIND_HOST: "127.0.0.1",
    PLUGHIVE_HOME: home,
    PLUGHIVE_NO_DOTENV: "1",
    PLUGHIVE_LOG_LEVEL: "warn",
    PLUGHIVE_ADMIN_TOKEN: ADMIN,
    PLUGHIVE_KEYCHAIN_SERVICE: SERVICE,
    // enableCompileCache() uses this directory when it is set.
    NODE_COMPILE_CACHE: cache,
  };
}

/** CPU time (user + system) a process has used so far, from ps ("M:SS.cc"). */
function cpuMs(pid) {
  const t = execFileSync("ps", ["-o", "time=", "-p", String(pid)])
    .toString()
    .trim();
  let s = 0;
  for (const part of t.split(":")) s = s * 60 + Number(part);
  return s * 1000;
}

async function start(home, cache) {
  const t0 = performance.now();
  const child = spawn(process.execPath, ENTRY_ARGS, {
    cwd: ROOT,
    env: env(home, cache),
    stdio: ["ignore", "ignore", "inherit"],
  });
  for (;;) {
    if (child.exitCode !== null) throw new Error(`daemon exited with ${child.exitCode}`);
    try {
      const r = await fetch(`${BASE}/health`);
      await r.arrayBuffer();
      if (r.ok) break;
    } catch {}
    if (performance.now() - t0 > 60_000) throw new Error("daemon did not start");
    await sleep(2);
  }
  return { child, ms: performance.now() - t0, cpu: cpuMs(child.pid) };
}

async function stop(child) {
  if (child.exitCode !== null) return;
  const exited = new Promise((r) => child.once("exit", r));
  const t0 = performance.now();
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 15_000);
  await exited;
  clearTimeout(timer);
  return performance.now() - t0;
}

const rssMb = (pid) =>
  Number(
    execFileSync("ps", ["-o", "rss=", "-p", String(pid)])
      .toString()
      .trim(),
  ) / 1024;

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return { n: s.length, min: s[0], p50: q(0.5), p95: q(0.95), max: s[s.length - 1], mean };
}

let sessionId;
let nextId = 1;
async function rpc(method, params) {
  const headers = {
    authorization: `Bearer ${ADMIN}`,
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const r = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
  });
  sessionId = r.headers.get("mcp-session-id") ?? sessionId;
  const raw = await r.text();
  return { status: r.status, bytes: raw.length };
}
async function notify(method) {
  await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${ADMIN}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method }),
  }).then((r) => r.arrayBuffer());
}
async function api(path) {
  const r = await fetch(BASE + path, {
    headers: { authorization: `Bearer ${ADMIN}`, "x-plughive-csrf": "1" },
  });
  const b = await r.arrayBuffer();
  return { status: r.status, bytes: b.byteLength };
}
/** A GET whose size is the bytes on the wire (no transparent decoding). */
function get(path, headers = {}) {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ request }) => {
      const req = request(BASE + path, { headers }, (res) => {
        let bytes = 0;
        res.on("data", (c) => {
          bytes += c.length;
        });
        res.on("end", () =>
          resolve({ status: res.statusCode, bytes, enc: res.headers["content-encoding"] ?? null }),
        );
        res.on("error", reject);
      });
      req.on("error", reject);
      req.end();
    }, reject);
  });
}

async function measure(label, fn, iters = ITERS) {
  let last;
  for (let i = 0; i < Math.min(20, iters); i++) last = await fn(); // warmup
  const xs = [];
  const t0 = performance.now();
  for (let i = 0; i < iters; i++) {
    const t = performance.now();
    last = await fn();
    xs.push(performance.now() - t);
  }
  const total = performance.now() - t0;
  return {
    label,
    ...stats(xs),
    rps: (iters / total) * 1000,
    status: last?.status,
    bytes: last?.bytes,
    enc: last?.enc,
  };
}

async function concurrent(label, fn, conc = 32, total = ITERS * 4) {
  let done = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: conc }, async () => {
      while (done < total) {
        done++;
        await fn();
      }
    }),
  );
  return { label: `${label} x${conc}`, rps: (total / (performance.now() - t0)) * 1000 };
}

const fmt = (n) => (typeof n === "number" ? n.toFixed(2) : String(n ?? ""));

async function main() {
  const work = mkdtempSync(join(tmpdir(), "plughive-bench-"));
  const out = {
    node: process.version,
    entry: ENTRY_KIND,
    cold: [],
    coldCpu: [],
    warm: [],
    warmCpu: [],
    latency: [],
    throughput: [],
  };
  try {
    // Cold starts: each on a brand new home and an empty compile cache.
    for (let i = 0; i < RUNS; i++) {
      const { child, ms, cpu } = await start(join(work, `cold-${i}`), join(work, `cache-${i}`));
      out.cold.push(ms);
      out.coldCpu.push(cpu);
      if (i === 0) out.rssStartMb = rssMb(child.pid);
      await stop(child);
    }
    // Warm starts: same home and cache, already initialised.
    const home = join(work, "warm");
    const cache = join(work, "cache-warm");
    await stop((await start(home, cache)).child);
    for (let i = 0; i < RUNS; i++) {
      const { child, ms, cpu } = await start(home, cache);
      out.warm.push(ms);
      out.warmCpu.push(cpu);
      await stop(child);
    }

    const { child } = await start(home, cache);
    await sleep(4000); // let the post-start warmers run
    out.rssIdleMb = rssMb(child.pid);

    out.latency.push(await measure("GET /health", () => get("/health")));
    out.latency.push(
      await measure("GET / (dashboard index)", () => get("/", { "accept-encoding": "gzip, br" })),
    );
    // The dashboard's main script, as a browser asks for it and uncompressed.
    const html = await (await fetch(`${BASE}/`)).text();
    const mainJs = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    if (mainJs) {
      out.latency.push(
        await measure("GET main script (br)", () => get(mainJs, { "accept-encoding": "br, gzip" })),
      );
      out.latency.push(
        await measure("GET main script (plain)", () =>
          get(mainJs, { "accept-encoding": "identity" }),
        ),
      );
    }
    out.latency.push(
      await measure(
        "MCP initialize (new session)",
        async () => {
          sessionId = undefined;
          return rpc("initialize", {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "bench", version: "0" },
          });
        },
        Math.min(ITERS, 200),
      ),
    );
    await notify("notifications/initialized");
    out.latency.push(await measure("MCP tools/list", () => rpc("tools/list", {})));
    out.latency.push(await measure("MCP resources/list", () => rpc("resources/list", {})));
    out.latency.push(
      await measure("MCP tools/call search_tools", () =>
        rpc("tools/call", { name: "search_tools", arguments: { query: "image" } }),
      ),
    );
    for (const p of ["/api/packs", "/api/tools", "/api/usage", "/api/jobs"]) {
      out.latency.push(await measure(`GET ${p}`, () => api(p), Math.min(ITERS, 150)));
    }
    out.throughput.push(await concurrent("GET /health", () => get("/health")));
    out.throughput.push(await concurrent("MCP tools/list", () => rpc("tools/list", {})));
    out.rssLoadedMb = rssMb(child.pid);
    out.shutdownMs = await stop(child);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  const c = stats(out.cold);
  const w = stats(out.warm);
  const cc = stats(out.coldCpu);
  const wc = stats(out.warmCpu);
  console.log(`node ${out.node}  entry ${out.entry}`);
  console.log(`cold start  p50 ${fmt(c.p50)} ms  min ${fmt(c.min)}  max ${fmt(c.max)}`);
  console.log(`warm start  p50 ${fmt(w.p50)} ms  min ${fmt(w.min)}  max ${fmt(w.max)}`);
  console.log(`startup CPU cold p50 ${fmt(cc.p50)} ms  min ${fmt(cc.min)}`);
  console.log(`startup CPU warm p50 ${fmt(wc.p50)} ms  min ${fmt(wc.min)}`);
  console.log(
    `RSS start ${fmt(out.rssStartMb)} MB  idle ${fmt(out.rssIdleMb)} MB  loaded ${fmt(out.rssLoadedMb)} MB  shutdown ${fmt(out.shutdownMs)} ms`,
  );
  console.log(
    "\nlatency (ms)                         p50     p95    mean      rps  status  bytes enc",
  );
  for (const l of out.latency)
    console.log(
      `${l.label.padEnd(34)} ${fmt(l.p50).padStart(7)} ${fmt(l.p95).padStart(7)} ${fmt(l.mean).padStart(7)} ${l.rps.toFixed(0).padStart(8)}  ${String(l.status).padStart(6)} ${String(l.bytes).padStart(6)} ${l.enc ?? ""}`,
    );
  console.log("\nthroughput");
  for (const t of out.throughput) console.log(`${t.label.padEnd(34)} ${t.rps.toFixed(0)} rps`);
  if (JSON_OUT) writeFileSync(JSON_OUT, JSON.stringify(out, null, 2));
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
