// src/core/runtime.ts
//
// Builds what the daemon serves: the tool registry with the core built-in
// tools, the packs under packs/ and $PLUGHIVE_HOME/packs, the capability
// router their providers register with, and the upstream MCP servers that are
// mounted (pack mounts and the user's mounts.json).
import { existsSync } from "node:fs";
import type { AppConfig } from "../lib/config.js";
import type { JobQueue } from "../lib/jobs.js";
import type { Library } from "../lib/library.js";
import type { UsageLedger } from "../lib/usage.js";
import { SetupAdvisor } from "./advisor/plan.js";
import { PAID_CACHE_ENV, PaidCallCache } from "./capabilities/paid-cache.js";
import { CapabilityRouter } from "./capabilities/router.js";
import { Installer } from "./installer/installer.js";
import { currentScopeAllows } from "./mcp/scope.js";
import { SERVER_INFO } from "./mcp/server.js";
import { MountManager } from "./mounts/manager.js";
import { MountOAuth } from "./mounts/oauth.js";
import { SmartMounts } from "./mounts/smart.js";
import { UserMountStore } from "./mounts/user-mounts.js";
import type { HostLibrary, HostLogger, PackHost } from "./packs/context.js";
import { PackLoader } from "./packs/loader.js";
import { PackMounts } from "./packs/mounts.js";
import type { PolicyGate } from "./policy/gate.js";
import type { LayeredSecretStore } from "./secrets/index.js";
import { CORE_PACK_ID, METERING_EXEMPT, coreTools } from "./tools/builtin/index.js";
import { mountTools } from "./tools/builtin/mounts.js";
import { SYSTEM_PACK_ID, systemTools } from "./tools/builtin/system.js";
import { type CallContext, ToolRegistry } from "./tools/registry.js";

export { METERING_EXEMPT };

export interface PackRuntimeOptions {
  config: Pick<AppConfig, "port" | "importRoots" | "bindHost" | "accessKey"> & {
    /** Register run_tool_script (PLUGHIVE_CODE_MODE). Default off. */
    codeMode?: boolean;
  };
  logger: HostLogger;
  library: Library;
  jobs: JobQueue;
  usage: UsageLedger;
  store: LayeredSecretStore;
  /** $PLUGHIVE_HOME. */
  home: string;
  /**
   * Download URL of an artifact. The composition root passes one that is
   * signed when the daemon needs an access key. Default: the library's base
   * URL plus /artifacts/<id>.
   */
  artifactUrl?: (id: string) => string;
  fetchPolicy?: PackHost["fetchPolicy"];
  builtinDir?: string;
  userDir?: string;
  settingsOverrides?: Record<string, Record<string, unknown>>;
  /** Ports the daemon listens on (no pack reaches them). Default: [config.port]. */
  daemonPorts?: readonly number[];
  /** Deadline for one pack's load. Default 10000 ms. */
  loadTimeoutMs?: number;
  /** Spend caps and approvals (docs/spend-and-approvals.md). Absent: no gate. */
  policy?: PolicyGate;
}

export interface PackRuntime {
  registry: ToolRegistry;
  loader: PackLoader;
  /** Capability router (pack providers). */
  capabilities: CapabilityRouter;
  /** Connections to the mounted upstream servers; `stop()` it on shutdown. */
  packMounts: PackMounts;
  /** Pack mounts and user mounts behind one surface. */
  mounts: MountManager;
  /** Sign-ins to OAuth mounts (the HTTP layer sets the redirect URL). */
  mountOAuth: MountOAuth;
  /** Software installs into $PLUGHIVE_HOME/tools (the system pack). */
  installer: Installer;
  /** setup_plan: what a goal still needs. */
  advisor: SetupAdvisor;
  /** Smart mount: idle and costly mounts; `start()` its sweep, `stop()` it on shutdown. */
  smartMounts: SmartMounts;
}

/** A mounted tool is `<prefix>__<name>`: the prefix is its vendor in the ledger. */
export function vendorOf(toolName: string): string | null {
  const at = toolName.indexOf("__");
  return at > 0 ? toolName.slice(0, at) : null;
}

/** The daemon library as packs reach it: absolute download URLs, no extra surface. */
function hostLibrary(lib: Library, urlFor: (id: string) => string): HostLibrary {
  return {
    get: (id) => lib.get(id),
    list: (filter, limit) => lib.list(filter, limit),
    save: (input) => lib.save(input),
    importHandle: (input, handle, maxBytes) => lib.importHandle(input, handle, maxBytes),
    urlFor,
  };
}

/** Registry + core tools + packs + mounts. */
export async function createPackRuntime(opts: PackRuntimeOptions): Promise<PackRuntime> {
  const { config, logger, library, jobs, usage, store } = opts;
  const urlFor = opts.artifactUrl ?? ((id: string) => `${library.baseUrlValue}/artifacts/${id}`);
  const registry = new ToolRegistry({
    logger,
    redactor: store.redactor,
    usage,
    vendorOf,
    meteringExempt: METERING_EXEMPT,
    ...(opts.policy ? { gate: opts.policy } : {}),
  });
  const redact = (s: string) => store.redactor.redact(s);
  // PLUGHIVE_PAID_CACHE=0 turns the paid-call cache off.
  const paidCache =
    process.env[PAID_CACHE_ENV] === "0"
      ? undefined
      : new PaidCallCache({
          home: opts.home,
          artifactExists: (id) => {
            const a = library.get(id);
            return a !== null && existsSync(a.path);
          },
        });
  const capabilities = new CapabilityRouter({
    home: opts.home,
    logger,
    usage,
    redact,
    ...(opts.policy ? { gate: opts.policy } : {}),
    ...(paidCache ? { paidCache } : {}),
  });
  // PackMounts asks MountOAuth for a mount's tokens; MountOAuth talks to the
  // authorization server through PackMounts' confined fetch.
  const oauthRef: { current: MountOAuth | null } = { current: null };
  const packMounts = new PackMounts({
    logger,
    redact,
    daemonPorts: opts.daemonPorts ?? [config.port],
    ...(opts.fetchPolicy?.lookup ? { lookup: opts.fetchPolicy.lookup } : {}),
    oauth: {
      provider: (m) => (oauthRef.current as MountOAuth).provider(m),
      signedIn: async (m) => (oauthRef.current ? oauthRef.current.signedIn(m) : false),
    },
  });
  const mountOAuth = new MountOAuth({
    store,
    fetchFor: (m) => packMounts.oauthFetch(m),
    logger,
    redirectUrl: () => `http://127.0.0.1:${config.port}/oauth/callback`,
    daemonPorts: opts.daemonPorts ?? [config.port],
  });
  oauthRef.current = mountOAuth;
  const installer = new Installer({ home: opts.home, logger, jobs });
  const host: PackHost = {
    trustedTools: installer.trustedTools(),
    ...(opts.policy ? { policy: opts.policy } : {}),
    capabilities,
    store,
    logger,
    library: hostLibrary(library, urlFor),
    tools: {
      // A pack calling another tool stays inside the exposure profile of the
      // request (or job) it is running for.
      call: (name, args, callCtx) => {
        if (!currentScopeAllows(name)) {
          return Promise.resolve({
            ok: false as const,
            error: {
              code: "TOOL_ERROR" as const,
              message: "that tool is not available in this profile",
              retryable: false,
            },
          });
        }
        return registry.call(name, args, callCtx);
      },
      get: (name) => registry.get(name),
      // `cap:` lookups for capabilities without a routed provider: by tool
      // name, so the answer does not depend on which pack loaded first.
      resolveCapability: (capability) =>
        registry
          .list()
          .filter((t) => t.capability === capability)
          .map((t) => t.name)
          .sort()[0],
    },
    usage,
    daemonPorts: opts.daemonPorts ?? [config.port],
    ...(opts.fetchPolicy ? { fetchPolicy: opts.fetchPolicy } : {}),
  };
  const mountsRef: { current: MountManager | null } = { current: null };
  const loader = new PackLoader({
    home: opts.home,
    registry,
    host,
    ...(opts.builtinDir ? { builtinDir: opts.builtinDir } : {}),
    ...(opts.userDir ? { userDir: opts.userDir } : {}),
    ...(opts.settingsOverrides ? { settingsOverrides: opts.settingsOverrides } : {}),
    ...(opts.loadTimeoutMs !== undefined ? { loadTimeoutMs: opts.loadTimeoutMs } : {}),
    capabilities,
    onMountsChanged: async () => {
      await mountsRef.current?.sync();
    },
  });
  const mounts = new MountManager({
    loader,
    user: new UserMountStore(opts.home),
    connections: packMounts,
    secrets: store,
    logger,
    redact,
    oauth: mountOAuth,
  });
  mountsRef.current = mounts;

  // Core tools first: a pack can never take one of their names.
  registry.registerPack(
    CORE_PACK_ID,
    coreTools({
      library,
      importRoots: config.importRoots,
      urlFor,
      jobs,
      usage,
      packs: loader,
      mounts,
      capabilities: { list: () => capabilities.list() },
      tools: () => registry.list(),
      // Batch items take the same scoped path as a pack's ctx.tools.call.
      batch: {
        call: (name, args, callCtx) =>
          (host.tools as NonNullable<PackHost["tools"]>).call(name, args, callCtx ?? {}),
        tools: () => registry.list(),
      },
      ...(config.codeMode
        ? {
            script: {
              call: (name: string, args: unknown, callCtx?: CallContext) =>
                (host.tools as NonNullable<PackHost["tools"]>).call(name, args, callCtx ?? {}),
            },
          }
        : {}),
      daemon: {
        version: SERVER_INFO.version,
        bindHost: config.bindHost,
        authRequired: !!config.accessKey,
        importRoots: config.importRoots.length,
      },
    }),
  );

  const advisor = new SetupAdvisor({
    software: () => installer.status(),
    packs: () => loader.listPacks(),
    mounts: () => mounts.listMounts(),
    capabilities: () => capabilities.list(),
  });
  // The system pack (software installs, setup_plan, mounts): reserved, never a user pack.
  // Mount tools join it: an agent proposes a mount, the user approves it.
  const gate = opts.policy ? { gate: opts.policy } : {};
  const smartMounts = new SmartMounts({
    home: opts.home,
    mounts,
    usage,
    tools: () => registry.list(),
    logger,
  });
  registry.registerPack(SYSTEM_PACK_ID, [
    ...systemTools({ installer, advisor, ...gate }),
    ...mountTools({ mounts, secrets: store, smart: smartMounts, ...gate }),
  ]);

  await loader.loadAll();
  await mounts.sync();
  registry.attachMounts(packMounts);
  return {
    registry,
    loader,
    capabilities,
    packMounts,
    mounts,
    mountOAuth,
    installer,
    advisor,
    smartMounts,
  };
}
