// The whole daemon in-process, as src/server.ts composes it: real library, job
// queue, usage ledger, pack runtime (core tools + packs) and createApp() on an
// ephemeral loopback port, with a temp home and an in-memory secret store.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { type CreatedApp, createApp } from "../../src/app.js";
import { ProfileStore } from "../../src/core/profiles.js";
import { type PackRuntime, createPackRuntime } from "../../src/core/runtime.js";
import { type LayeredSecretStore, createSecretStore } from "../../src/core/secrets/index.js";
import { createArtifactSigner } from "../../src/http/artifacts.js";
import { JobQueue } from "../../src/lib/jobs.js";
import { Library } from "../../src/lib/library.js";
import { UsageLedger } from "../../src/lib/usage.js";
import { ADMIN_TOKEN, type LogLine } from "./harness.js";

export interface FullOptions {
  accessKey?: string | null;
  /** Built-in packs directory. Default: the repository's packs/. */
  builtinDir?: string;
  /** User packs directory. Default: <home>/packs (empty). */
  userDir?: string;
  /** false: no profile store, /mcp lists every tool. */
  profiles?: boolean;
  importRoots?: string[];
  /** Environment the secret store may fall back to. Default: empty. */
  env?: Record<string, string>;
  /** Called with the temp home before anything is loaded (seed mounts.json, packs). */
  seed?: (home: string) => void;
  queue?: Record<string, unknown>;
}

export interface FullHarness {
  base: string;
  port: number;
  /** The temp directory holding the library, the databases and the home. */
  dir: string;
  home: string;
  runtime: PackRuntime;
  store: LayeredSecretStore;
  library: Library;
  jobs: JobQueue;
  usage: UsageLedger;
  app: CreatedApp;
  logs: LogLine[];
  close(): Promise<void>;
}

export async function bootFull(opts: FullOptions = {}): Promise<FullHarness> {
  const dir = mkdtempSync(join(tmpdir(), "mcp-full-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  opts.seed?.(home);
  const logs: LogLine[] = [];
  const logAt = (level: string) => (obj: unknown, msg: string) =>
    void logs.push({ level, obj, msg });
  const logger = {
    info: logAt("info"),
    warn: logAt("warn"),
    error: logAt("error"),
    debug: logAt("debug"),
  };

  let listening = 0;
  const base = () => `http://127.0.0.1:${listening}`;
  const accessKey = opts.accessKey ?? null;
  const config = {
    port: 0,
    root: dir,
    importRoots: opts.importRoots ?? [],
    jobConcurrency: 2,
    bindHost: "127.0.0.1",
    accessKey,
    publicUrl: null,
    allowedOrigins: [],
    jobMaxQueued: 100,
    codeMode: false,
  };
  const db = new Database(join(dir, "jobs.db"));
  const library = new Library({ root: dir, baseUrl: "http://127.0.0.1:0" });
  const jobs = new JobQueue({ db, concurrency: 2, ...(opts.queue ?? {}) });
  const usage = new UsageLedger({ root: dir });
  const store = createSecretStore({ home, env: opts.env ?? {}, backend: "memory" });
  const signer = createArtifactSigner();
  const runtime = await createPackRuntime({
    config,
    logger,
    library,
    jobs,
    usage,
    store,
    home,
    artifactUrl: (id) => (accessKey ? signer.url(base(), id) : `${base()}/artifacts/${id}`),
    userDir: opts.userDir ?? join(home, "packs"),
    ...(opts.builtinDir ? { builtinDir: opts.builtinDir } : {}),
    daemonPorts: [],
  });
  const created = createApp({
    config,
    logger,
    library,
    usage,
    jobs,
    registry: runtime.registry,
    loader: runtime.loader,
    mounts: runtime.mounts,
    capabilities: runtime.capabilities,
    store,
    home,
    ...(opts.profiles === false ? {} : { profiles: new ProfileStore({ home, logger }) }),
    artifactSigner: signer,
    adminToken: ADMIN_TOKEN,
    port: () => listening,
    hasSecret: (name) => store.has(name),
    scrub: (text) => store.redactor.redact(text),
    eventIntervalMs: 25,
  });
  jobs.startWorker({ intervalMs: 20 });
  const server: HttpServer = await new Promise((resolve) => {
    const s = created.app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  listening = address.port;

  return {
    port: listening,
    base: base(),
    dir,
    home,
    runtime,
    store,
    library,
    jobs,
    usage,
    app: created,
    logs,
    async close() {
      jobs.stopWorker();
      created.close();
      const inFlight = () => (jobs as unknown as { running: number }).running;
      for (let i = 0; i < 80 && inFlight() > 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      await created.mcp.close();
      await runtime.loader.close();
      await runtime.packMounts.stop();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      usage.close();
      library.close();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Headers of a JSON request to /api that passes the CSRF rule and carries the
 * admin token (or the credential given; null sends none).
 */
export function apiHeaders(token: string | null = ADMIN_TOKEN): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-plughive-csrf": "1",
    ...(token ? { authorization: `Bearer ${token}` } : {}),
  };
}
