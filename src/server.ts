// src/server.ts
//
// IMPORTANT: ./lib/network.js MUST be the first import. It sets the global
// undici dispatcher (IPv4-first, longer connect timeout) at module load,
// before any other module has a chance to call fetch().
import "./lib/network.js";

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { config as loadEnv } from "dotenv";
import { createApp, createHttpServer } from "./app.js";
import { currentScope } from "./core/mcp/scope.js";
import { ApprovalStore } from "./core/policy/approvals.js";
import { PolicyGate } from "./core/policy/gate.js";
import { TELEGRAM_TOKEN_SECRET, TelegramApprover } from "./core/policy/telegram.js";
import { ProfileStore } from "./core/profiles.js";
import { createPackRuntime, vendorOf } from "./core/runtime.js";
import { createSecretStore } from "./core/secrets/index.js";
import { createPathScrubber } from "./core/tools/registry.js";
import { createArtifactSigner } from "./http/artifacts.js";
import {
  assertEncryptedSecretsOnNetwork,
  assertNoMultiKeyConfig,
  assertSafeBind,
  isLoopbackHost,
} from "./lib/access-key.js";
import { dashboardUrl, loadOrCreateAdminToken } from "./lib/admin-token.js";
import { daemonOrigin, loadConfig } from "./lib/config.js";
import { createCrashHandler } from "./lib/crash.js";
import { JobQueue } from "./lib/jobs.js";
import { Library } from "./lib/library.js";
import { createLogger } from "./lib/logger.js";
import { openPrivateDb } from "./lib/private-db.js";
import { applySecretFiles } from "./lib/secret-files.js";
import { UsageLedger } from "./lib/usage.js";

/** How stale the cached pack manifests (secret labels, help links) may get. */
const PACK_INFO_MAX_AGE_MS = 5000;
/** Longest one shutdown step may take, and the whole shutdown. */
const SHUTDOWN_STEP_MS = 5000;
/** After start, when provider probes run once to fill their caches. */
const WARM_DELAY_MS = 3000;
const SHUTDOWN_TOTAL_MS = 15_000;

export interface StartDaemonOptions {
  /**
   * Print the endpoint, and on a TTY the dashboard sign-in link, to stdout.
   * Never through the logger. Default true.
   */
  banner?: boolean;
}

export interface RunningDaemon {
  /** The origin clients use (PLUGHIVE_PUBLIC_URL, else the bind address). */
  baseUrl: string;
  host: string;
  port: number;
  /** The dashboard sign-in link. It carries the admin token: never log it. */
  dashboardLink(): string;
  /** Idempotent graceful shutdown. */
  shutdown(): Promise<void>;
}

/**
 * Boot the daemon with the settings in process.env and resolve once it
 * listens. Rejects when it cannot start (bad configuration, port taken).
 * Used by `node dist/src/server.js`, `pnpm dev` and the `plughive` CLI.
 */
export async function startDaemon(opts: StartDaemonOptions = {}): Promise<RunningDaemon> {
  const banner = opts.banner ?? true;
  applySecretFiles(process.env);
  const cfg = loadConfig();
  const home = cfg.root;
  // Provider keys are not daemon configuration: packs declare the names they
  // need and read them through this store (which falls back to the
  // environment for declared names only).
  const store = createSecretStore({ home, env: process.env });
  if (cfg.accessKey) store.redactor.register(cfg.accessKey);
  assertNoMultiKeyConfig(process.env);
  assertSafeBind(cfg.bindHost, cfg.accessKey);
  assertEncryptedSecretsOnNetwork(cfg.bindHost, process.env, store.storage());
  // The credential of /api. Distinct from the access key: what an agent holds
  // must not administer the daemon. Registered with the redactor; it is never
  // passed to the logger.
  const admin = loadOrCreateAdminToken(home, process.env);
  if (cfg.accessKey && cfg.accessKey === admin.token) {
    throw new Error("PLUGHIVE_ADMIN_TOKEN must differ from PLUGHIVE_ACCESS_KEY");
  }
  store.redactor.register(admin.token);
  const logger = createLogger(cfg.root);
  const scrubPaths = createPathScrubber({ home: homedir(), dataDir: cfg.root });
  const scrub = (text: string) => scrubPaths(store.redactor.redact(text));
  /** An error as it may be logged: secrets redacted, private directories hidden. */
  const safeError = (err: unknown): string => {
    const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return scrub(text).slice(0, 2000);
  };

  // After an uncaught exception the process state is unknown (a job marked
  // started and never finished, a half-applied loader change): log it, flush
  // what is in flight and exit non-zero so a supervisor starts a clean
  // daemon. A rejected promise nobody awaited is a contained fault: it is
  // logged (redacted) and serving goes on.
  let flush: (() => Promise<void>) | null = null;
  process.on(
    "uncaughtException",
    createCrashHandler({
      log: (err) => logger.error({ err: safeError(err) }, "uncaught exception; shutting down"),
      flush: () => flush?.(),
      exit: (code) => process.exit(code),
      timeoutMs: SHUTDOWN_TOTAL_MS,
    }),
  );
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: safeError(reason) }, "unhandled rejection");
  });

  // PLUGHIVE_PUBLIC_URL when set, else the bind address. Never a request's Host.
  const baseUrl = daemonOrigin(cfg);
  const library = new Library({ root: cfg.root, baseUrl });
  const jobsDb = openPrivateDb(join(cfg.root, "jobs.db"));
  const jobs = new JobQueue({
    db: jobsDb,
    concurrency: cfg.jobConcurrency,
    maxQueued: cfg.jobMaxQueued,
    redactor: store.redactor,
  });
  // Spend is recorded under the profile the call ran for (profile caps).
  const usage = new UsageLedger({ root: cfg.root, profileOf: () => currentScope()?.profileId });
  // Spend caps and approvals: requests live next to the jobs that may wait for them.
  const policy = new PolicyGate({
    home,
    approvals: new ApprovalStore({ db: jobsDb, redact: (s) => store.redactor.redact(s) }),
    spend: usage,
    baseUrl,
    vendorOf,
    logger,
  });
  // Opt-in approvals over Telegram: idle (one policy read every 30 s) unless
  // policy.json turns it on for some chats.
  const telegram = new TelegramApprover({
    gate: policy,
    token: () => store.get(TELEGRAM_TOKEN_SECRET),
    logger,
  });
  // One signer for the links tools hand out and the route that checks them.
  const artifactSigner = createArtifactSigner();

  const runtime = await createPackRuntime({
    config: cfg,
    logger,
    library,
    jobs,
    usage,
    store,
    home,
    policy,
    // A browser cannot send the access key: when one is required, the links
    // packs hand out carry a short-lived signature instead.
    artifactUrl: (id) =>
      cfg.accessKey ? artifactSigner.url(baseUrl, id) : `${baseUrl}/artifacts/${id}`,
  });
  const loader = runtime.loader;
  runtime.registry.setPathScrubber(scrubPaths);
  // Smart mount: in "auto" mode an hourly sweep parks idle mounts.
  runtime.smartMounts.start();

  // What each pack's manifest says about its secrets: the only source of the
  // label and help link shown when a key is missing. Refreshed in the
  // background so a reloaded pack is picked up.
  type SecretInfo = { label?: string; helpUrl?: string };
  let packSecrets = new Map<string, Map<string, SecretInfo>>();
  let packSecretsAt = 0;
  let refreshing = false;
  const refreshPackSecrets = async () => {
    if (refreshing) return;
    refreshing = true;
    try {
      const packsNow = await loader.listPacks();
      const next = new Map<string, Map<string, SecretInfo>>();
      for (const p of packsNow) {
        next.set(
          p.id,
          new Map(
            p.secrets.map((s) => [
              s.name,
              {
                ...(s.label ? { label: s.label } : {}),
                ...(s.helpUrl ? { helpUrl: s.helpUrl } : {}),
              },
            ]),
          ),
        );
      }
      packSecrets = next;
      packSecretsAt = Date.now();
      return packsNow;
    } finally {
      refreshing = false;
    }
  };
  for (const p of (await refreshPackSecrets()) ?? []) {
    if (p.state === "failed" || p.state === "invalid")
      logger.warn({ pack: p.id, err: p.error }, "pack not loaded");
  }

  const created = createApp({
    config: cfg,
    logger,
    library,
    usage,
    jobs,
    registry: runtime.registry,
    loader,
    mounts: runtime.mounts,
    mountOAuth: runtime.mountOAuth,
    smartMounts: runtime.smartMounts,
    capabilities: runtime.capabilities,
    installer: runtime.installer,
    advisor: runtime.advisor,
    store,
    home,
    profiles: new ProfileStore({ home, logger }),
    artifactSigner,
    adminToken: admin.token,
    ...(cfg.triggers ? { triggers: { db: jobsDb, hookRatePerMinute: cfg.hookRateLimit } } : {}),
    onShutdown: () => onSignal(),
    policy,
    scrub,
    hasSecret: (name) => store.has(name),
    secretInfo: (pack, secret) => {
      if (Date.now() - packSecretsAt > PACK_INFO_MAX_AGE_MS) {
        void refreshPackSecrets().catch(() => undefined);
      }
      return packSecrets.get(pack)?.get(secret);
    },
  });
  const { app, mcp } = created;

  // Only now: the tool-call job handler is registered, so no job left over
  // from a previous run is claimed by a worker that cannot run it.
  jobs.startWorker({ intervalMs: 500 });

  const server = createHttpServer(app);

  /** One shutdown step: a failure or a hang is logged and the next step runs. */
  const step = async (name: string, fn: () => unknown): Promise<void> => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.resolve().then(fn),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out")), SHUTDOWN_STEP_MS);
          timer.unref();
        }),
      ]);
    } catch (e) {
      logger.warn({ step: name, err: safeError(e) }, "shutdown step did not finish");
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  let stopping: Promise<void> | null = null;
  /** Idempotent: every caller gets the same shutdown. */
  // Ask every provider and program once, soon after start, so the first
  // dashboard visit finds the probe caches warm instead of waiting on spawns.
  const warm = setTimeout(() => {
    void runtime.capabilities.list().catch(() => undefined);
    void runtime.installer?.status().catch(() => undefined);
  }, WARM_DELAY_MS);
  warm.unref();
  const shutdown = (): Promise<void> => {
    clearTimeout(warm);
    runtime.smartMounts.stop();
    stopping ??= (async () => {
      await step("jobs", () => jobs.stopWorker());
      await step("telegram", () => telegram.stop());
      await step("app", () => created.close());
      server.close();
      server.closeIdleConnections();
      await step("mcp", () => mcp.close());
      await step("packs", () => loader.close());
      // After the packs: nothing calls a mounted tool any more.
      await step("mounts", () => runtime.packMounts.stop());
      server.closeAllConnections();
      await step("usage", () => usage.close());
      await step("library", () => library.close());
      await step("jobs-db", () => jobsDb.close());
    })();
    return stopping;
  };
  flush = shutdown;
  const onSignal = () => {
    // Whatever hangs, the process is gone after SHUTDOWN_TOTAL_MS.
    setTimeout(() => process.exit(1), SHUTDOWN_TOTAL_MS).unref();
    void shutdown().then(() => process.exit(0));
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  // Ctrl+Break in a Windows console; a closed terminal elsewhere.
  if (process.platform === "win32") process.on("SIGBREAK", onSignal);
  else process.on("SIGHUP", onSignal);

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err) => {
      // Cannot listen (port taken, address not available): nothing to serve.
      reject(
        new Error(`plughive could not listen on ${cfg.bindHost}:${cfg.port}: ${safeError(err)}`),
      );
    });
    server.listen(cfg.port, cfg.bindHost, () => resolve());
  });
  telegram.start();
  void runtime.mounts
    .listMounts()
    .then((mounts) => {
      logger.info(
        {
          port: cfg.port,
          bind: cfg.bindHost,
          public_url: cfg.publicUrl,
          tools: runtime.registry.list().length,
          packs: loader.summary(),
          mounts: mounts.filter((m) => m.connected).length,
          secrets: store.backendKind,
          auth: !!cfg.accessKey,
        },
        "plughive listening",
      );
    })
    .catch(() => undefined);
  if (!isLoopbackHost(cfg.bindHost) && !cfg.publicUrl) {
    // Behind a TLS proxy the daemon cannot tell it is reached over https.
    logger.warn(
      { bind: cfg.bindHost },
      "network bind without PLUGHIVE_PUBLIC_URL: every Host name is accepted and the dashboard cookie is not marked Secure; put a TLS proxy in front and set PLUGHIVE_PUBLIC_URL=https://<name>",
    );
  }
  if (banner) {
    console.log(`plughive on ${baseUrl}`);
    if (cfg.accessKey) console.log("Access key required for /mcp, /p and /artifacts");
    if (process.stdout.isTTY) {
      // Straight to the terminal, never through the logger: the link carries
      // the admin token (in the fragment, which no server or Referer sees).
      process.stdout.write(`Dashboard: ${dashboardUrl(baseUrl, admin.token)}\n`);
    } else if (admin.path) {
      logger.info({ path: admin.path }, `admin token is in ${admin.path}`);
    } else {
      logger.info({}, "admin token is taken from PLUGHIVE_ADMIN_TOKEN");
    }
  }
  return {
    baseUrl,
    host: cfg.bindHost,
    port: cfg.port,
    dashboardLink: () => dashboardUrl(baseUrl, admin.token),
    shutdown,
  };
}

/** True when this file is the process entry point (node, tsx), not an import. */
function isEntryPoint(): boolean {
  const arg = process.argv[1];
  if (!arg) return false;
  try {
    return realpathSync(arg) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // PLUGHIVE_NO_DOTENV=1 skips .env (tests, temp-root boots).
  if (!process.env.PLUGHIVE_NO_DOTENV) loadEnv();
  startDaemon().catch((e) => {
    // Startup failures are configuration errors written for the user; the name
    // and message are enough, a stack adds only paths.
    console.error(e instanceof Error ? `${e.name}: ${e.message}` : String(e));
    process.exit(1);
  });
}
