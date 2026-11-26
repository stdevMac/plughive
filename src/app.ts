// src/app.ts
//
// HTTP app construction, separated from main() so tests can mount it on an
// ephemeral port. Owns no lifecycle: callers start and stop the library, the
// job queue and the pack runtime they pass in.
//
// Order of the middleware, which is the security model of the HTTP surface:
//   1. Host validation (loopback binds): rebound DNS names are refused.
//   2. Pack marker: a request made through a pack's fetch never gets in.
//   3. Origin: a browser page on another origin never gets in.
//   4. Per route: the credential, then (only then) a body parser with a limit.
//      /mcp, /p and /artifacts take the access key (when one is set); /api
//      takes the admin token or a dashboard session, always.
//   5. JSON 404 and a JSON error handler: never a stack or a path.
import { randomBytes } from "node:crypto";
import { type Server as HttpServer, createServer } from "node:http";
import { hostHeaderValidation, localhostHostValidation } from "@modelcontextprotocol/express";
import type { McpHttpHandler } from "@modelcontextprotocol/server";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import type { CapabilityRouter } from "./core/capabilities/router.js";
import { mountAdminApi } from "./core/http/admin-api.js";
import { createAdminAuth } from "./core/http/admin-auth.js";
import { csrfGuard } from "./core/http/csrf.js";
import { mountDashboard } from "./core/http/dashboard.js";
import { mountDataApi } from "./core/http/data-api.js";
import { type EventStreams, mountEventsApi } from "./core/http/events-api.js";
import { mountInfoApi } from "./core/http/info-api.js";
import { mountOAuthCallback } from "./core/http/oauth-callback.js";
import { type OriginPolicy, createOriginPolicy, originGuard } from "./core/http/origin.js";
import { mountPolicyApi } from "./core/http/policy-api.js";
import { mountPreferencesApi } from "./core/http/preferences-api.js";
import { mountProfilesApi } from "./core/http/profiles-api.js";
import {
  type SecretSink,
  declaredByLoadedPack,
  mountSecretSetup,
} from "./core/http/secret-setup.js";
import { type SoftwareApiDeps, mountSoftwareApi } from "./core/http/software-api.js";
import { mountToolsApi } from "./core/http/tools-api.js";
import { RecentAgents } from "./core/mcp/agents.js";
import { createScopeBuilder } from "./core/mcp/scope-for.js";
import { DEFAULT_PROFILE_ID, type RequestScope } from "./core/mcp/scope.js";
import { type McpServerDeps, SERVER_INFO } from "./core/mcp/server.js";
import { SetupTokens } from "./core/mcp/setup-token.js";
import { createTaskEngine } from "./core/mcp/tasks.js";
import type { MountManager } from "./core/mounts/manager.js";
import { type MountOAuth, OAUTH_CALLBACK_PATH } from "./core/mounts/oauth.js";
import type { SmartMounts } from "./core/mounts/smart.js";
import { rejectPackRequests } from "./core/packs/http-guard.js";
import type { PackLoader } from "./core/packs/loader.js";
import type { PolicyGate } from "./core/policy/gate.js";
import { type Profile, type ProfileStore, resolveExposure } from "./core/profiles.js";
import type { LayeredSecretStore } from "./core/secrets/index.js";
import { CORE_PACK_ID } from "./core/tools/builtin/index.js";
import type { ToolRegistry } from "./core/tools/registry.js";
import {
  type MountedTriggers,
  type TriggerOptions,
  createTriggers,
} from "./core/triggers/index.js";
import {
  type ArtifactSigner,
  createArtifactSigner,
  mountArtifacts,
  signArtifactLinks,
} from "./http/artifacts.js";
import { isMcpPath, mountMcp } from "./http/mcp.js";
import { isLoopbackHost } from "./lib/access-key.js";
import { accessKeyMiddleware } from "./lib/auth.js";
import type { AppConfig } from "./lib/config.js";
import type { JobQueue } from "./lib/jobs.js";
import type { Library } from "./lib/library.js";
import type { UsageLedger } from "./lib/usage.js";

export interface AppLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface AppDeps {
  config: Pick<AppConfig, "port" | "bindHost" | "accessKey" | "publicUrl" | "allowedOrigins">;
  logger: AppLogger;
  library: Library;
  usage: UsageLedger;
  /**
   * The admin token: the credential of everything under /api (see
   * lib/admin-token.ts). Absent: a random one nobody knows, so /api is closed.
   */
  adminToken?: string;
  /** Tools served on /mcp and in the playground. */
  registry: ToolRegistry;
  /** Job queue: long-running tools become tasks, and /api/jobs is served. */
  jobs?: JobQueue;
  /**
   * The pack runtime. With all of `loader`, `mounts`, `capabilities`, `store`
   * and `home` present, /api/packs, /api/secrets, /api/capabilities and
   * /api/mounts are served.
   */
  loader?: PackLoader;
  mounts?: MountManager;
  /** Smart mount: with it, /api/mounts/smart is served. */
  smartMounts?: SmartMounts;
  /**
   * Sign-ins to OAuth mounts. With it and `mounts`, GET /oauth/callback is
   * served and the redirect URL handed to authorization servers is this
   * daemon's origin.
   */
  mountOAuth?: Pick<MountOAuth, "setRedirectUrl">;
  capabilities?: CapabilityRouter;
  store?: LayeredSecretStore;
  /** $PLUGHIVE_HOME. */
  home?: string;
  /** Software installs and setup plans: with both, /api/software and /api/advisor are served. */
  installer?: SoftwareApiDeps["installer"];
  advisor?: SoftwareApiDeps["advisor"];
  /**
   * Exposure profiles: enables /p/<id>/mcp and /api/profiles, and makes /mcp
   * serve the "default" profile. Absent: /mcp lists every tool.
   */
  profiles?: ProfileStore;
  /** Where the missing-key setup page stores values. Default: `store`. Neither: no setup page. */
  secrets?: SecretSink;
  /** Signs artifact links. Pass the one the pack runtime uses; default: a new one. */
  artifactSigner?: ArtifactSigner;
  /** The port the daemon listens on. Default: config.port. Tests listen on an ephemeral port. */
  port?: () => number;
  /** True when a secret is set: long-running tools report a missing key before a job starts. */
  hasSecret?: McpServerDeps["hasSecret"];
  /** What the owning pack's manifest says about one of its secrets. */
  secretInfo?: McpServerDeps["secretInfo"];
  /** Makes an error message safe to return from /api (secrets redacted, private paths hidden). */
  scrub?: (text: string) => string;
  /** How often /api/events looks for changes. Default 1000 ms. */
  eventIntervalMs?: number;
  /** The built web dashboard served at `/`. Default: defaultWebDir(). */
  webDir?: string;
  /**
   * Graceful stop. With it, `POST /api/admin/shutdown` (admin token, CSRF
   * rule) answers 202 and then calls it: the way a supervisor stops the
   * daemon on Windows, where there is no SIGTERM to send.
   */
  onShutdown?: () => void;
  /**
   * Triggers (cron schedules and inbound webhooks that start workflows). Needs
   * `jobs`. Serves POST /hooks/<id> and /api/triggers. See docs/triggers.md.
   */
  triggers?: TriggerOptions;
  /**
   * Spend caps and approvals: /api/policy, /api/approvals and the "approval"
   * event. Pass the gate the pack runtime uses.
   */
  policy?: PolicyGate;
}

/** The gate's in-chat approval hooks, for the MCP server. */
function chatApprovalsFor(gate: PolicyGate) {
  return {
    allowed: (profile: string) => gate.chatApprovalsAllowed(profile),
    formShown: (id: string) => gate.chatFormShown(id),
    decide: (id: string, approve: boolean, profile: string, token: unknown) =>
      gate.decideInChat(id, approve, profile, token),
  };
}

export interface CreatedApp {
  app: Express;
  /** The MCP handler behind /mcp; `close()` it on shutdown. */
  mcp: McpHttpHandler;
  /** The daemon's origin policy (base URL of every link it hands out). */
  origin: OriginPolicy;
  /** Mints browser-openable artifact links when an access key is configured. */
  artifactSigner: ArtifactSigner;
  /** Stops the timers this app owns and ends its event streams. */
  close(): void;
}

const SETUP_PATH = "/setup/secret";

function hostnameOf(origin: string): string | null {
  try {
    return new URL(origin).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** The bind address as a Host header names it (IPv6 in brackets, lower case). */
function bindHostName(bindHost: string): string {
  const host = bindHost.trim().toLowerCase();
  return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

export function createApp(deps: AppDeps): CreatedApp {
  const { config: cfg, logger, library, usage, registry, jobs, loader, mounts, profiles } = deps;
  const { port, hasSecret, secretInfo } = deps;
  const secrets = deps.secrets ?? deps.store;
  const app = express();
  app.disable("x-powered-by");
  const protect = accessKeyMiddleware({ accessKey: cfg.accessKey });
  const origin = createOriginPolicy({
    publicUrl: cfg.publicUrl ?? null,
    bindHost: cfg.bindHost,
    allowedOrigins: cfg.allowedOrigins ?? [],
    port: port ?? (() => cfg.port),
  });

  if (isLoopbackHost(cfg.bindHost)) {
    // Loopback daemon: refuse rebound DNS names. Host is compared by name
    // (port-agnostic), 403 otherwise. Behind a proxy the public name is added.
    const publicHost = cfg.publicUrl ? hostnameOf(cfg.publicUrl) : null;
    app.use(
      publicHost
        ? hostHeaderValidation(["localhost", "127.0.0.1", "[::1]", publicHost])
        : localhostHostValidation(),
    );
  } else if (cfg.publicUrl) {
    // Network bind with a public URL: the daemon has a name, so a request for
    // any other name (a rebound DNS name, a stray virtual host) is refused.
    // Allowed: the public name, the bind address and the loopback names (the
    // CLI and the Mac app talk to 127.0.0.1). Without a public URL nothing is
    // known about the names clients use, and every Host is accepted as before.
    const publicHost = hostnameOf(cfg.publicUrl);
    app.use(
      hostHeaderValidation([
        "localhost",
        "127.0.0.1",
        "[::1]",
        bindHostName(cfg.bindHost),
        ...(publicHost ? [publicHost] : []),
      ]),
    );
  }
  // A pack reaches the outside world through the host's fetch, which marks
  // every request. None of the daemon's own routes serves a marked request.
  app.use(rejectPackRequests);
  // Browser pages: only the daemon's own origin and the explicit allow-list.
  // The setup form has its own rule (browsers post it with `Origin: null`).
  const guard = originGuard(origin);
  app.use((req, res, next) => (req.path === SETUP_PATH ? next() : guard(req, res, next)));

  app.use((req, res, next) => {
    if (req.path.startsWith("/artifacts/")) return next();
    const start = Date.now();
    res.on("finish", () => {
      const ms = Date.now() - start;
      const session = req.header("mcp-session-id") ?? null;
      // req.path carries no query string: tokens and signatures stay out of the log.
      logger.info(
        { method: req.method, path: req.path, status: res.statusCode, ms, session },
        "http",
      );
    });
    next();
  });

  // The admin token or a dashboard session: the credential of /api (below)
  // and of the full /health report.
  const admin = createAdminAuth({
    token: deps.adminToken ?? randomBytes(32).toString("base64url"),
    secureCookie: origin.base().startsWith("https:"),
  });

  // The Mac app's supervisor sets a fresh id per launch and trusts the port
  // only when /health echoes it back, so a process that grabbed the port
  // first is never handed the admin token.
  const instanceEnv = process.env.PLUGHIVE_INSTANCE_ID;
  const instance =
    instanceEnv && /^[A-Za-z0-9_-]{16,128}$/.test(instanceEnv) ? instanceEnv : undefined;

  app.get("/health", (req, res) => {
    // A caller without the admin token learns only that the daemon is up and
    // its version: that is all the CLI (daemonUp), the Mac app's supervisor
    // and the e2e scripts read. The access key is an agent's credential, not
    // an admin one, so it does not unlock the report either.
    if (!admin.isAuthenticated(req)) {
      res.json({ ok: true, version: SERVER_INFO.version, ...(instance ? { instance } : {}) });
      return;
    }
    const tools = registry.list();
    const mounted = tools.filter((t) => t.origin === "mounted").length;
    const core = tools.filter((t) => t.packId === CORE_PACK_ID).length;
    res.json({
      ok: true,
      version: SERVER_INFO.version,
      ...(instance ? { instance } : {}),
      tools: tools.length,
      core_tools: core,
      pack_tools: tools.length - mounted - core,
      mounted_tools: mounted,
      // Secret presence per pack is on /api/packs, not on this route.
      packs: loader?.summary() ?? { total: 0, enabled: 0, loaded: 0, failed: 0, needsReview: 0 },
      jobs: jobs?.counts() ?? {},
      auth_required: !!cfg.accessKey,
      bind_host: cfg.bindHost,
      uptime_s: Math.round(process.uptime()),
    });
  });

  const artifactSigner = deps.artifactSigner ?? createArtifactSigner();
  mountArtifacts(app, library, {
    accessKey: cfg.accessKey,
    signer: artifactSigner,
    logger,
  });
  // A browser cannot send the access key, so the artifact links a client
  // shows the user are signed when a key is required.
  const decorate = cfg.accessKey
    ? (value: unknown) => signArtifactLinks(value, origin.base(), artifactSigner)
    : undefined;
  const artifactUrl = (id: string) =>
    cfg.accessKey ? artifactSigner.url(origin.base(), id) : `${origin.base()}/artifacts/${id}`;

  // A background job runs with the restrictions of the profile that started it.
  // Inline calls (/mcp, /api/tools) build their scope with the same function.
  const scopeFor = createScopeBuilder({
    registry,
    ...(profiles ? { profile: (id: string) => profiles.get(id) } : {}),
    baseUrl: () => origin.base(),
  });
  // Long-running tools run on the job queue; the setup page stores missing keys.
  const tasks = jobs ? createTaskEngine(jobs, registry, { scopeFor }) : undefined;
  const setup = secrets ? new SetupTokens() : undefined;
  // Triggers: /hooks/<id> carries its own credential (an HMAC signature), so
  // it is mounted before the /api guard; /api/triggers after it.
  const triggerKit =
    tasks && deps.triggers
      ? createTriggers(deps.triggers, {
          registry,
          tasks,
          logger,
          origin,
          scopeFor,
          ...(profiles ? { profileExists: (id: string) => profiles.get(id) !== undefined } : {}),
        })
      : undefined;
  triggerKit?.mountHooks(app);
  const store = deps.store;
  const present = hasSecret ?? (store ? (name: string) => store.has(name) : undefined);
  if (setup && secrets) {
    mountSecretSetup(app, {
      tokens: setup,
      secrets,
      logger,
      origin,
      ...(loader ? { declared: declaredByLoadedPack(loader) } : {}),
      // A key set in the meantime is never replaced through a setup link.
      ...(present ? { present } : {}),
    });
  }

  // The vendor's authorization server sends the browser back here after a
  // sign-in to an OAuth mount. The single-use state authorizes the request.
  if (mounts && deps.mountOAuth) {
    deps.mountOAuth.setRedirectUrl(() => `${origin.base()}${OAUTH_CALLBACK_PATH}`);
    mountOAuthCallback(app, {
      finish: (params) => mounts.oauthFinish(params),
      mountName: async (id) => (await mounts.listMounts()).find((m) => m.id === id)?.name ?? null,
      logger,
      ...(deps.scrub ? { redact: deps.scrub } : {}),
    });
  }

  // ---- /api: the admin token or a dashboard session first (never the access
  // key: that is what agents hold), then each module's CSRF rule and parser.
  // /api/session is the one route that answers without a credential.
  admin.mountSession(app, origin);
  app.use("/api", admin.require);
  if (deps.onShutdown) {
    const onShutdown = deps.onShutdown;
    app.post("/api/admin/shutdown", csrfGuard(origin), (_req, res) => {
      logger.info({}, "shutdown requested over /api/admin/shutdown");
      res.once("finish", () => setImmediate(onShutdown));
      res.status(202).json({ ok: true });
    });
  }
  const agents = new RecentAgents();
  mountInfoApi(app, {
    agents,
    origin,
    version: SERVER_INFO.version,
    bindHost: cfg.bindHost,
    port: port ?? (() => cfg.port),
    authRequired: !!cfg.accessKey,
    ...(deps.home ? { home: deps.home } : {}),
    ...(deps.store ? { secretsBackend: deps.store.backendKind, secrets: deps.store } : {}),
  });
  let events: EventStreams | undefined;
  if (jobs) {
    events = mountEventsApi(app, {
      logger,
      jobs,
      ...(loader ? { packs: loader } : {}),
      ...(deps.policy ? { approvals: deps.policy.approvals } : {}),
      ...(decorate ? { decorate } : {}),
      ...(deps.eventIntervalMs !== undefined ? { intervalMs: deps.eventIntervalMs } : {}),
    });
    mountDataApi(app, {
      origin,
      logger,
      usage,
      jobs,
      library,
      artifactUrl,
      ...(decorate ? { decorate } : {}),
    });
  }
  if (deps.home) mountPreferencesApi(app, { origin, logger, home: deps.home });
  if (deps.policy && deps.home) {
    mountPolicyApi(app, {
      origin,
      logger,
      home: deps.home,
      gate: deps.policy,
      changed: () => events?.poke(),
    });
  }
  if (profiles) {
    mountProfilesApi(app, {
      profiles,
      registry,
      jobs: tasks !== undefined,
      origin,
      ...(deps.scrub ? { scrub: deps.scrub } : {}),
    });
  }
  // Smart mount reads and changes profiles for its profile suggestions.
  if (deps.smartMounts && profiles) deps.smartMounts.attachProfiles(profiles);
  if (loader && mounts && deps.capabilities && deps.store && deps.home) {
    mountAdminApi(app, {
      origin,
      logger,
      home: deps.home,
      loader,
      mounts,
      capabilities: deps.capabilities,
      secrets: deps.store,
      ...(deps.smartMounts ? { smart: deps.smartMounts } : {}),
      ...(deps.scrub ? { scrub: deps.scrub } : {}),
      changed: () => events?.poke(),
    });
  }
  const triggers: MountedTriggers | undefined = triggerKit?.mountApi(app);
  if (deps.installer && deps.advisor) {
    mountSoftwareApi(app, {
      origin,
      logger,
      installer: deps.installer,
      advisor: deps.advisor,
      changed: () => events?.poke(),
    });
  }
  mountToolsApi(app, {
    origin,
    logger,
    registry,
    scopeFor,
    ...(tasks ? { tasks } : {}),
    ...(hasSecret ? { hasSecret } : {}),
    ...(decorate ? { decorate } : {}),
  });

  app.use("/mcp", protect);
  app.use("/p", protect);
  const mcp = mountMcp(app, registry, logger, {
    ...(profiles ? { profiles } : {}),
    ...(tasks ? { tasks } : {}),
    scopeFor,
    ...(setup ? { setup } : {}),
    baseUrl: () => origin.base(),
    agents,
    ...(hasSecret ? { hasSecret } : {}),
    ...(secretInfo ? { secretInfo } : {}),
    ...(decorate ? { decorateResult: decorate } : {}),
    ...(store ? { redact: (text: string) => store.redactor.redact(text) } : {}),
    library,
    ...(deps.policy ? { chatApprovals: chatApprovalsFor(deps.policy) } : {}),
    ...(deps.smartMounts
      ? {
          dormant: {
            list: (p: Profile) => deps.smartMounts?.dormantTools(p) ?? [],
            wake: async (p: Profile, name: string) =>
              (await deps.smartMounts?.wake(p, name)) ?? { status: "none" as const },
          },
        }
      : {}),
  });

  // The dashboard: public static files and the client-side routes. After
  // every daemon route, so a path the daemon owns never gets the app.
  mountDashboard(app, deps.webDir ? { dir: deps.webDir } : {});

  // Everything that matched no route, including PUT /mcp.
  app.use((_req: Request, res: Response) => {
    res.status(404).json({ ok: false, error: { code: "NOT_FOUND", message: "not found" } });
  });

  // Last: every error becomes a small JSON body. Never a stack, never a path.
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    const raw = (err as { status?: unknown; statusCode?: unknown } | null) ?? {};
    const given = typeof raw.status === "number" ? raw.status : raw.statusCode;
    const status = typeof given === "number" && given >= 400 && given < 500 ? given : 500;
    if (status === 500) {
      logger.error(
        { method: req.method, path: req.path, err: errorName(err) },
        "unhandled http error",
      );
    }
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const tooLarge = status === 413;
    if (isMcpPath(req.path)) {
      const error =
        status === 400
          ? { code: -32700, message: "Parse error" }
          : tooLarge
            ? { code: -32600, message: "Request body too large" }
            : status < 500
              ? { code: -32600, message: "Invalid request" }
              : { code: -32603, message: "Internal error" };
      res.status(status).json({ jsonrpc: "2.0", id: null, error });
      return;
    }
    const body =
      status === 400
        ? { code: "INVALID_REQUEST", message: "the request body could not be read" }
        : tooLarge
          ? { code: "INVALID_REQUEST", message: "request body too large" }
          : status < 500
            ? { code: "INVALID_REQUEST", message: "the request was refused" }
            : { code: "INTERNAL", message: "internal error" };
    res.status(status).json({ ok: false, error: body });
  });

  return {
    app,
    mcp,
    origin,
    artifactSigner,
    close: () => {
      setup?.close();
      events?.close();
      admin.close();
      void triggers?.close();
    },
  };
}

/** The class of an error, for logs: its message could quote a path or a value. */
function errorName(err: unknown): string {
  if (err instanceof Error) return err.name;
  return typeof err;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

export interface HttpServerLimits {
  /** Time to receive the request line and headers. */
  headersTimeoutMs?: number;
  /** Time to receive the whole request, body included. Responses are not bounded. */
  requestTimeoutMs?: number;
  /** Idle time before a keep-alive connection is closed. */
  keepAliveTimeoutMs?: number;
  /** How often the two timeouts above are enforced. */
  checkIntervalMs?: number;
}

export const DEFAULT_HTTP_LIMITS: Required<HttpServerLimits> = {
  headersTimeoutMs: 15_000,
  requestTimeoutMs: 60_000,
  keepAliveTimeoutMs: 5_000,
  checkIntervalMs: 5_000,
};

/**
 * The HTTP server for an app, with the timeouts that stop a client from
 * holding a socket open by sending its request one byte at a time. A
 * long-running response (a tool call, an event stream) is not affected.
 */
export function createHttpServer(app: Express, limits: HttpServerLimits = {}): HttpServer {
  const l = { ...DEFAULT_HTTP_LIMITS, ...limits };
  const server = createServer(
    {
      headersTimeout: l.headersTimeoutMs,
      requestTimeout: l.requestTimeoutMs,
      keepAliveTimeout: l.keepAliveTimeoutMs,
      connectionsCheckingInterval: l.checkIntervalMs,
    },
    app,
  );
  server.maxHeadersCount = 100;
  return server;
}
