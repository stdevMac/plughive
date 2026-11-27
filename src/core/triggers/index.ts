// src/core/triggers/index.ts
//
// Triggers: cron schedules and inbound webhooks that start workflows as
// background jobs, with an optional job-done callback. See docs/triggers.md.
import type Database from "better-sqlite3";
import type { Express } from "express";
import type { ApiLogger } from "../http/api-common.js";
import type { OriginPolicy } from "../http/origin.js";
import type { RequestScope } from "../mcp/scope.js";
import type { TaskEngine } from "../mcp/tasks.js";
import { createSafeFetch } from "../net/safe-fetch.js";
import type { ToolRegistry } from "../tools/registry.js";
import { mountHooks, mountTriggerApi } from "./http.js";
import { TriggerService } from "./service.js";
import { TriggerStore } from "./store.js";

export { parseCron, nextRun, CronError } from "./cron.js";
export { TriggerService, sign } from "./service.js";
export { TriggerStore } from "./store.js";
export { HOOK_PATH, verifyHook } from "./http.js";

export interface TriggerOptions {
  /** The database the trigger tables live in (the daemon's jobs.db). */
  db: Database.Database;
  /** Inbound requests per minute per hook. Default 30. */
  hookRatePerMinute?: number;
  /** Scheduler tick. Default 15 s. */
  tickMs?: number;
  /** fetch for webhook callbacks. Default: the SSRF-guarded fetch (public hosts only). */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  /** Clock, for tests. */
  now?: () => number;
  /** Sees every webhook secret (start-up, create, rotate), e.g. to register it with the redactor. */
  onSecret?: (secret: string) => void;
}

export interface MountedTriggers {
  service: TriggerService;
  close(): Promise<void>;
}

/**
 * The webhook route (call before the /api guard) and a function that mounts
 * /api/triggers (call after it). The scheduler starts when the API is mounted.
 */
export function createTriggers(
  opts: TriggerOptions,
  deps: {
    registry: ToolRegistry;
    tasks: TaskEngine;
    logger: ApiLogger;
    origin: OriginPolicy;
    scopeFor?: (profileId: string | undefined) => RequestScope;
    profileExists?: (id: string) => boolean;
  },
) {
  const store = new TriggerStore(opts.db, opts.onSecret);
  const safe = opts.fetch ?? createSafeFetch({ allowHosts: ["*"], maxRedirects: 0 });
  const service = new TriggerService({
    store,
    registry: deps.registry,
    tasks: deps.tasks,
    logger: deps.logger,
    fetch: (url, init) => safe(url, init),
    ...(deps.scopeFor ? { scopeFor: deps.scopeFor } : {}),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.tickMs !== undefined ? { tickMs: opts.tickMs } : {}),
  });
  const http = {
    service,
    origin: deps.origin,
    logger: deps.logger,
    ...(opts.hookRatePerMinute !== undefined ? { hookRatePerMinute: opts.hookRatePerMinute } : {}),
    ...(opts.now ? { now: opts.now } : {}),
  };
  return {
    service,
    mountHooks: (app: Express) => mountHooks(app, http),
    mountApi: (app: Express): MountedTriggers => {
      mountTriggerApi(app, {
        ...http,
        baseUrl: () => deps.origin.base(),
        ...(deps.profileExists ? { profileExists: deps.profileExists } : {}),
      });
      service.start();
      return { service, close: () => service.stop() };
    },
  };
}
