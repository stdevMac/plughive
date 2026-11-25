// src/core/http/info-api.ts
//
//   GET /api/info   what the dashboard's Settings and Connect screens show:
//                   version, the URL agents connect to, the bind address,
//                   whether an access key is required, the data directory and
//                   the secrets backend and where secrets are stored
//                   (Keychain, encrypted file, plain file, memory), and
//                   the MCP clients seen since start (name, version, profile).
//                   Never a secret, never the key itself.
//
// Behind the access key like every /api route; read-only, so no CSRF rule.
import express, { type Express } from "express";
import type { SeenAgent } from "../mcp/agents.js";
import type { OriginPolicy } from "./origin.js";

export interface InfoApiDeps {
  origin: OriginPolicy;
  version: string;
  bindHost: string;
  port: () => number;
  authRequired: boolean;
  /** $PLUGHIVE_HOME, when the daemon has one. */
  home?: string;
  /** "keychain", "file", "memory" ...: the secret store's backend. */
  secretsBackend?: string;
  /** The secret store, for where secrets live (wins over secretsBackend). */
  secrets?: {
    readonly backendKind: string;
    readonly keychainService: string | null;
    storage(): "keychain" | "keyring" | "file-encrypted" | "file-plain" | "memory";
  };
  /** MCP clients seen since the daemon started (names are the clients' own, cleaned). */
  agents?: { list(): SeenAgent[] };
}

export function mountInfoApi(app: Express, deps: InfoApiDeps): void {
  const router = express.Router();
  router.get("/", (_req, res) => {
    const base = deps.origin.base();
    res.json({
      ok: true,
      version: deps.version,
      base_url: base,
      mcp_url: `${base}/mcp`,
      profile_url_template: `${base}/p/{profile}/mcp`,
      bind_host: deps.bindHost,
      port: deps.port(),
      auth_required: deps.authRequired,
      data_dir: deps.home ?? null,
      secrets_backend: deps.secrets?.backendKind ?? deps.secretsBackend ?? null,
      // "keychain" | "keyring" | "file-encrypted" | "file-plain" | "memory"; read per
      // request, because the file's state changes when a passphrase is added.
      secrets_storage: deps.secrets?.storage() ?? null,
      secrets_keychain_service: deps.secrets?.keychainService ?? null,
      node_version: process.version,
      platform: process.platform,
      uptime_s: Math.round(process.uptime()),
      // Clients that have called /mcp or /p/<id>/mcp since start, newest first.
      agents: deps.agents?.list() ?? [],
    });
  });
  app.use("/api/info", router);
}
