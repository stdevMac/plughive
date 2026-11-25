import { toNodeHandler } from "@modelcontextprotocol/node";
import { type McpHttpHandler, createMcpHandler } from "@modelcontextprotocol/server";
// src/http/mcp.ts
//
// MCP over Streamable HTTP via the SDK v2 stateless entry. A fresh low-level
// `Server` is built per request (and per era): modern 2026-07-28 clients are
// served per request, and 2025-era clients that open with `initialize` are
// served by the SDK's stateless legacy fallback (no Mcp-Session-Id is minted;
// legacy GET/DELETE answer 405).
//
//   /mcp          the default exposure profile
//   /p/<id>/mcp   the profile <id> (404 when it does not exist)
//
// What the server does per request lives in core/mcp/server.ts.
import express, { type Express, type Request, type Response } from "express";
import type { RecentAgents } from "../core/mcp/agents.js";
import { type RequestScope, requestScope } from "../core/mcp/scope.js";
import { type McpLogger, type McpServerDeps, buildMcpServer } from "../core/mcp/server.js";
import type { SetupTokens } from "../core/mcp/setup-token.js";
import type { TaskEngine } from "../core/mcp/tasks.js";
import { DEFAULT_PROFILE_ID, PROFILE_ID_PATTERN, type ProfileStore } from "../core/profiles.js";
import { type ToolRegistry, toolInputJsonSchema } from "../core/tools/registry.js";

export { toolInputJsonSchema };

/**
 * Largest MCP request body. Tool arguments are JSON; files travel as artifact
 * ids or local paths, never inline, so 4 MB leaves room for a long prompt or a
 * small inline image without letting one request hold tens of megabytes.
 */
export const MCP_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

export interface McpOptions {
  /** Exposure profiles. Absent: every tool is listed on /mcp and /p/<id>/mcp answers 404. */
  profiles?: Pick<ProfileStore, "get">;
  /** Job-backed tasks for long-running tools. */
  tasks?: TaskEngine;
  /** Tokens for the missing-key setup page. */
  setup?: SetupTokens;
  /**
   * The daemon's own origin, for the links it hands out. From configuration,
   * never from the request. Absent: no setup links are offered.
   */
  baseUrl?: () => string;
  hasSecret?: McpServerDeps["hasSecret"];
  scopeFor?: McpServerDeps["scopeFor"];
  secretInfo?: McpServerDeps["secretInfo"];
  decorateResult?: McpServerDeps["decorateResult"];
  /** Redacts stored secret values in resources/read contents. */
  redact?: McpServerDeps["redact"];
  /** Remembers which clients connected, for the dashboard. */
  agents?: RecentAgents;
  /** Served as `artifact://` resources. */
  library?: McpServerDeps["library"];
  /** In-chat approvals (the policy's approve_in_chat rule). */
  chatApprovals?: McpServerDeps["chatApprovals"];
  /** Smart mount's parked and hidden tools (search finds them, a call wakes them). */
  dormant?: McpServerDeps["dormant"];
}

const silent: McpLogger = { warn() {}, error() {} };

/** Web-standard MCP handler for the registry's tools (one Server per request). */
export function createMcpHttpHandler(
  registry: ToolRegistry,
  logger?: McpLogger,
  opts: McpOptions = {},
): McpHttpHandler {
  const log = logger ?? silent;
  const deps: McpServerDeps = {
    registry,
    ...(opts.profiles ? { profile: (id: string) => opts.profiles?.get(id) } : {}),
    ...(opts.tasks ? { tasks: opts.tasks } : {}),
    ...(opts.scopeFor ? { scopeFor: opts.scopeFor } : {}),
    ...(opts.setup ? { setup: opts.setup } : {}),
    ...(opts.hasSecret ? { hasSecret: opts.hasSecret } : {}),
    ...(opts.secretInfo ? { secretInfo: opts.secretInfo } : {}),
    ...(opts.decorateResult ? { decorateResult: opts.decorateResult } : {}),
    ...(opts.redact ? { redact: opts.redact } : {}),
    ...(opts.library ? { library: opts.library } : {}),
    ...(opts.chatApprovals ? { chatApprovals: opts.chatApprovals } : {}),
    ...(opts.dormant ? { dormant: opts.dormant } : {}),
  };
  // The HTTP request's scope reaches the per-request server factory through
  // the same AsyncLocalStorage the tools read.
  return createMcpHandler(({ era }) => buildMcpServer(deps, era, requestScope.getStore() ?? {}), {
    legacy: "stateless",
    maxRequestBodySize: MCP_BODY_LIMIT_BYTES,
    onerror: (err) => log.warn({ err: registry.safeMessage(err) }, "mcp handler error"),
  });
}

/**
 * Mount POST/GET/DELETE on /mcp and /p/:profile/mcp of an express app. The
 * caller mounts authentication on those paths first: the JSON body is parsed
 * here, per route, so an unauthenticated request never gets a body read.
 */
export function mountMcp(
  app: Express,
  registry: ToolRegistry,
  logger?: McpLogger,
  opts: McpOptions = {},
): McpHttpHandler {
  const resolved = { registry, logger: logger ?? silent };
  const handler = createMcpHttpHandler(resolved.registry, resolved.logger, opts);
  const node = toNodeHandler(handler, {
    maxRequestBodySize: MCP_BODY_LIMIT_BYTES,
    onerror: (err) =>
      resolved.logger.error({ err: resolved.registry.safeMessage(err) }, "mcp adapter error"),
  });
  const json = express.json({ limit: MCP_BODY_LIMIT_BYTES });

  const serve = (req: Request, res: Response, profileId: string) => {
    const baseUrl = opts.baseUrl?.();
    const scope: RequestScope = { profileId, ...(baseUrl ? { baseUrl } : {}) };
    if (req.method === "POST") opts.agents?.note(req.body, profileId);
    requestScope.run(
      scope,
      () => void node(req, res, req.method === "POST" ? req.body : undefined),
    );
  };
  const handleDefault = (req: Request, res: Response) => serve(req, res, DEFAULT_PROFILE_ID);
  const handleProfile = (req: Request, res: Response) => {
    const id = String(req.params.profile ?? "");
    if (!PROFILE_ID_PATTERN.test(id) || !opts.profiles?.get(id)) {
      res
        .status(404)
        .json({ ok: false, error: { code: "UNKNOWN_PROFILE", message: "no such profile" } });
      return;
    }
    serve(req, res, id);
  };

  app.post("/mcp", json, handleDefault);
  app.post("/p/:profile/mcp", json, handleProfile);
  for (const method of ["get", "delete"] as const) {
    app[method]("/mcp", handleDefault);
    app[method]("/p/:profile/mcp", handleProfile);
  }
  return handler;
}

/** True for the paths that speak JSON-RPC (used to shape error replies). */
export function isMcpPath(path: string): boolean {
  return path === "/mcp" || /^\/p\/[^/]+\/mcp$/.test(path);
}
