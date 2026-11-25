// Shared harness for the protocol-layer tests: the real createApp() on an
// ephemeral loopback port, serving a small registry of mock tools.
import { mkdtempSync, rmSync } from "node:fs";
import type { Server as HttpServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import Database from "better-sqlite3";
import { z } from "zod";
import { type AppDeps, createApp } from "../../src/app.js";
import { ApprovalStore } from "../../src/core/policy/approvals.js";
import { PolicyGate } from "../../src/core/policy/gate.js";
import { ProfileStore } from "../../src/core/profiles.js";
import { MissingSecretError } from "../../src/core/secrets/index.js";
import {
  type CallContext,
  type RegisteredTool,
  ToolRegistry,
  toolInputJsonSchema,
} from "../../src/core/tools/registry.js";
import { JobQueue } from "../../src/lib/jobs.js";
import type { Library } from "../../src/lib/library.js";
import type { UsageLedger } from "../../src/lib/usage.js";

export const TASKS_EXT = "io.modelcontextprotocol/tasks";

/** The admin token every test daemon is started with (the credential of /api). */
export const ADMIN_TOKEN = "test-admin-token-0123456789abcdefghij";
export const ADMIN_AUTH = { authorization: `Bearer ${ADMIN_TOKEN}` };

/**
 * fetch for tests of the management API: a request to /api that carries no
 * credential of its own is sent with the admin token. Tests of the
 * authentication itself use the global fetch.
 */
export const adminFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let path = "";
  try {
    path = new URL(url).pathname;
  } catch {
    path = "";
  }
  if (!path.startsWith("/api/") && path !== "/api") return fetch(input, init);
  const headers = new Headers(init?.headers);
  if (!headers.has("authorization") && !headers.has("cookie")) {
    headers.set("authorization", ADMIN_AUTH.authorization);
  }
  return fetch(input, { ...init, headers });
};

export function mockTool(
  name: string,
  run: (input: Record<string, unknown>, ctx: CallContext) => Promise<unknown>,
  extra: Partial<RegisteredTool> = {},
): RegisteredTool {
  const input = extra.input ?? z.object({ n: z.number().default(1) });
  return {
    name,
    packId: "demo",
    origin: "native",
    description: `${name}: a mock tool.`,
    inputSchema: toolInputJsonSchema(input),
    tags: [],
    requiresSecrets: [],
    longRunning: false,
    input,
    run: run as RegisteredTool["run"],
    ...extra,
  };
}

export interface LogLine {
  level: string;
  obj: unknown;
  msg: string;
}

export interface LiteHarness {
  base: string;
  port: number;
  home: string;
  registry: ToolRegistry;
  profiles: ProfileStore;
  jobs: JobQueue;
  /** The spend gate, when `policy` was asked for. */
  policy?: PolicyGate;
  /** Values stored through the setup page. */
  secrets: Map<string, string>;
  logs: LogLine[];
  /** Mints signed artifact links exactly as the daemon does. */
  signArtifact(id: string): string;
  close(): Promise<void>;
}

export interface LiteOptions {
  accessKey?: string | null;
  /** tools by pack id */
  packs: Record<string, RegisteredTool[]>;
  /** false: build the app without a profile store. */
  profiles?: boolean;
  /** Extra AppConfig fields (publicUrl, allowedOrigins, bindHost). */
  config?: Record<string, unknown>;
  /** Artifact rows served by /artifacts/:id. */
  artifacts?: Record<string, { id: string; path: string; mime: string; bytes: number }>;
  /** The library root the fake artifact paths must lie under (default: the harness home). */
  artifactsRoot?: string;
  hasSecret?: (name: string) => boolean | Promise<boolean>;
  secretInfo?: (pack: string, secret: string) => { label?: string; helpUrl?: string } | undefined;
  /** JobQueue options (limits, grace period). */
  queue?: Record<string, unknown>;
  /** The built dashboard directory served at `/`. Default: a directory that does not exist. */
  webDir?: string;
  /** Passed to createApp: enables POST /api/admin/shutdown. */
  onShutdown?: () => void;
  /** Passed to createApp with the harness's jobs.db: enables triggers and /hooks. */
  triggers?: Record<string, unknown>;
  /** Passed to createApp: serves /api/software and /api/advisor. */
  software?: Pick<AppDeps, "installer" | "advisor">;
  /** Spend policy gate on the registry and the app; `spent` is what the ledger reports. */
  policy?: { spent?: () => number };
}

export async function bootLite(opts: LiteOptions): Promise<LiteHarness> {
  const home = mkdtempSync(join(tmpdir(), "mcp-proto-"));
  const logs: LogLine[] = [];
  const logAt = (level: string) => (obj: unknown, msg: string) =>
    void logs.push({ level, obj, msg });
  const logger = {
    info: logAt("info"),
    warn: logAt("warn"),
    error: logAt("error"),
    debug: logAt("debug"),
  };

  const db = new Database(join(home, "jobs.db"));
  // The app's port is known after listen(); the gate reads it through the request scope.
  let listening = 0;
  const policy = opts.policy
    ? new PolicyGate({
        home,
        approvals: new ApprovalStore({ db }),
        spend: { spent: opts.policy.spent ?? (() => 0) },
        baseUrl: "http://127.0.0.1",
      })
    : undefined;
  const registry = new ToolRegistry({ logger, ...(policy ? { gate: policy } : {}) });
  for (const [pack, tools] of Object.entries(opts.packs)) registry.registerPack(pack, tools);

  const jobs = new JobQueue({ db, concurrency: 2, ...(opts.queue ?? {}) });
  const secrets = new Map<string, string>();
  const profiles = new ProfileStore({ home, logger });

  const rows = () => Object.values(opts.artifacts ?? {});
  const library = {
    get: (id: string) => opts.artifacts?.[id] ?? null,
    list: (_filter: unknown, limit = 50, offset = 0) => rows().slice(offset, offset + limit),
    count: () => rows().length,
    rootValue: opts.artifactsRoot ?? home,
  } as unknown as Library;
  const usage = {
    listRateLimits: () => [],
    summarize: () => ({}),
    byProviderAndDay: () => [],
  } as unknown as UsageLedger;

  const created = createApp({
    config: {
      port: 0,
      bindHost: "127.0.0.1",
      accessKey: opts.accessKey ?? null,
      publicUrl: null,
      allowedOrigins: [],
      ...(opts.config ?? {}),
    },
    logger,
    library,
    usage,
    jobs,
    registry,
    adminToken: ADMIN_TOKEN,
    eventIntervalMs: 25,
    webDir: opts.webDir ?? join(home, "no-web-dist"),
    ...(opts.profiles === false ? {} : { profiles }),
    secrets: { set: async (name, value) => void secrets.set(name, value) },
    port: () => listening,
    ...(opts.hasSecret ? { hasSecret: opts.hasSecret } : {}),
    ...(opts.secretInfo ? { secretInfo: opts.secretInfo } : {}),
    ...(opts.onShutdown ? { onShutdown: opts.onShutdown } : {}),
    ...(opts.triggers ? { triggers: { db, ...opts.triggers } } : {}),
    ...(opts.software ?? {}),
    ...(policy ? { policy, home } : {}),
  });
  const { app, mcp } = created;
  jobs.startWorker({ intervalMs: 20 });
  const server: HttpServer = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no server address");
  listening = address.port;

  return {
    port: address.port,
    base: `http://127.0.0.1:${address.port}`,
    home,
    registry,
    profiles,
    jobs,
    ...(policy ? { policy } : {}),
    secrets,
    logs,
    signArtifact: (id) => created.artifactSigner.url(created.origin.base(), id),
    async close() {
      jobs.stopWorker();
      created.close();
      // Let in-flight jobs settle before the database closes under them.
      const inFlight = () => (jobs as unknown as { running: number }).running;
      for (let i = 0; i < 80 && inFlight() > 0; i++)
        await new Promise((resolve) => setTimeout(resolve, 25));
      await mcp.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/** A tool that fails with MISSING_SECRET until `secrets` holds the value. */
export function needsSecretTool(name: string, secrets: () => Map<string, string>): RegisteredTool {
  return mockTool(name, async () => {
    if (!secrets().has("DEMO_API_KEY")) {
      throw new MissingSecretError({
        pack: "demo",
        name: "DEMO_API_KEY",
        label: "Demo API key",
        helpUrl: "https://example.com/keys",
      });
    }
    return { used_key: true };
  });
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

export interface ClientOpts {
  path?: string;
  headers?: Record<string, string>;
  capabilities?: Record<string, unknown>;
}

/** SDK client on the 2026-07-28 revision. */
export async function modernClient(base: string, opts: ClientOpts = {}): Promise<Client> {
  const client = new Client(
    { name: "proto-test", version: "1.0.0" },
    {
      versionNegotiation: { mode: "auto" },
      ...(opts.capabilities ? { capabilities: opts.capabilities as never } : {}),
    },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}${opts.path ?? "/mcp"}`), {
      requestInit: opts.headers ? { headers: opts.headers } : undefined,
    }),
  );
  return client;
}

/** SDK client that opens with `initialize` (2025-era). */
export async function legacyClient(base: string, opts: ClientOpts = {}): Promise<Client> {
  const client = new Client(
    { name: "proto-test-legacy", version: "1.0.0" },
    opts.capabilities ? { capabilities: opts.capabilities as never } : {},
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${base}${opts.path ?? "/mcp"}`), {
      requestInit: opts.headers ? { headers: opts.headers } : undefined,
    }),
  );
  return client;
}

/**
 * A JSON object read from an HTTP response. `Response.json()` is `unknown`
 * here; the tests assert on the fields they read, so the shape stays open.
 */
export type JsonBody = Record<string, any>;

export async function jsonBody(res: Response): Promise<JsonBody> {
  const body: unknown = await res.json();
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new Error(`expected a JSON object, got ${JSON.stringify(body)?.slice(0, 200)}`);
  }
  return body as JsonBody;
}

export function toolJson(result: unknown, index = 0): Record<string, any> {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[index]!.text);
}

export interface RawReply {
  status: number;
  result?: Record<string, any>;
  error?: { code: number; message: string; data?: unknown };
  notifications: Array<Record<string, any>>;
}

/**
 * One raw 2026-07-28 request. The SDK client (2.4.0) rejects task results, so
 * a tasks-capable client is spoken by hand.
 */
export async function rawModern(
  base: string,
  method: string,
  params: Record<string, unknown>,
  opts: {
    path?: string;
    capabilities?: Record<string, unknown>;
    progressToken?: string;
    name?: string;
    headers?: Record<string, string>;
    /** Extra `_meta` entries of the request. */
    meta?: Record<string, unknown>;
  } = {},
): Promise<RawReply> {
  const meta: Record<string, unknown> = {
    "io.modelcontextprotocol/protocolVersion": "2026-07-28",
    "io.modelcontextprotocol/clientInfo": { name: "raw-test", version: "1.0.0" },
    "io.modelcontextprotocol/clientCapabilities": opts.capabilities ?? {},
    ...(opts.progressToken ? { progressToken: opts.progressToken } : {}),
    ...(opts.meta ?? {}),
  };
  const name =
    opts.name ?? (params.name as string | undefined) ?? (params.taskId as string | undefined);
  const res = await fetch(`${base}${opts.path ?? "/mcp"}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": method,
      ...(name ? { "mcp-name": name } : {}),
      ...(opts.headers ?? {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: meta } }),
  });
  const text = await res.text();
  const messages: Array<Record<string, any>> = (res.headers.get("content-type") ?? "").includes(
    "text/event-stream",
  )
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5).trim()))
    : text
      ? [JSON.parse(text)]
      : [];
  const reply = messages.find((m) => "result" in m || "error" in m);
  return {
    status: res.status,
    ...(reply?.result ? { result: reply.result } : {}),
    ...(reply?.error ? { error: reply.error } : {}),
    notifications: messages.filter((m) => "method" in m),
  };
}

export const TASK_CAPS = { extensions: { [TASKS_EXT]: {} } };

export async function until<T>(
  fn: () => Promise<T | undefined | false> | T | undefined | false,
  ms = 5000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
