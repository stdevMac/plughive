import { request as httpRequest } from "node:http";
import { Client, ProtocolError, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
// End-to-end: boot the real createApp() on an ephemeral loopback port and talk
// to /mcp with a real v2 MCP Client, plus a raw-fetch 2025-era legacy client.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type FullHarness, apiHeaders, bootFull } from "./full-harness.js";

/**
 * The tool surface of a default install (no keys, no user packs, no mounts),
 * by owning pack. A change here is a change to what clients see: update it on
 * purpose.
 */
const DEFAULT_TOOL_SURFACE: Record<string, string[]> = {
  browser: [
    "browserbase_close_session",
    "browserbase_create_session",
    "browserbase_fetch",
    "browserbase_get_session",
    "steel_create_session",
    "steel_navigate",
    "steel_release_session",
    "steel_screenshot",
  ],
  calendar: [
    "calcom_cancel_booking",
    "calcom_create_booking",
    "calcom_get_availability",
    "calcom_list_event_types",
  ],
  core: [
    "batch_run",
    "gateway_status",
    "get_job_status",
    "import_artifact",
    "list_artifacts",
    "usage_report",
  ],
  dub: ["dub_shorten_url"],
  email: [
    "agentmail_get_message",
    "agentmail_list_inboxes",
    "agentmail_list_messages",
    "agentmail_reply",
    "resend_send_email",
  ],
  "finance-data": [
    "alphavantage_daily",
    "alphavantage_quote",
    "polygon_aggregates",
    "polygon_previous_close",
  ],
  growth: [
    "apollo_bulk_enrich_people",
    "apollo_enrich_company",
    "apollo_enrich_person",
    "apollo_health_check",
    "apollo_search_companies",
    "apollo_search_people",
    "craft_icp",
    "draft_cold_email",
    "enrich_company",
    "enrich_people",
    "enrich_person",
    "find_companies",
    "find_people",
    "get_sender_profile",
    "leads_provider_status",
    "list_drafts",
    "mark_contacted",
    "personalize_outreach",
    "pipeline_run",
    "query_companies",
    "query_leads",
    "research_prospect",
    "score_lead",
    "set_sender_profile",
  ],
  maps: [
    "google_directions",
    "google_geocode",
    "google_places_search",
    "mapbox_directions",
    "mapbox_geocode",
  ],
  media: [
    "chat",
    "clone_voice",
    "convert_document",
    "edit_image",
    "embed_text",
    "fetch_web",
    "generate_3d",
    "generate_image",
    "generate_music",
    "generate_sound_effect",
    "generate_speech",
    "generate_video",
    "get_media_transcript",
    "lipsync_video",
    "list_media_providers",
    "parse_document",
    "remove_background",
    "rerank_text",
    "search_web",
    "separate_stems",
    "transcribe_audio",
    "translate_text",
    "upscale_image",
    "upscale_video",
  ],
  memory: ["forget", "list_memories", "list_memory_collections", "recall", "remember"],
  pdf: ["md_to_pdf"],
  phone: ["twilio_list_messages", "twilio_send_sms", "vapi_create_call", "vapi_get_call"],
  seo: ["seo_backlinks", "seo_keyword_volume", "seo_keywords_for_site", "seo_onpage", "seo_serp"],
  share: ["share_artifact", "share_unshare"],
  social: ["ayrshare_delete_post", "ayrshare_history", "ayrshare_post"],
  stock: ["freesound_search", "pexels_search", "stock_download", "unsplash_search"],
  system: [
    "add_mount",
    "connect_mount",
    "disable_mount",
    "enable_mount",
    "install_software",
    "list_installable",
    "list_mounts",
    "optimize_mounts",
    "remove_mount",
    "setup_plan",
    "software_status",
    "uninstall_software",
  ],
  telegram: ["send_telegram"],
  web: [
    "firecrawl_crawl",
    "firecrawl_map",
    "firecrawl_scrape",
    "firecrawl_search",
    "screenshot_url",
  ],
  workflows: [
    "wf_brand_kit_from_url",
    "wf_dub_localize",
    "wf_issue_triage",
    "wf_podcast_produce",
    "wf_video_launch_film_16x9",
    "wf_video_narrated_ad",
    "wf_video_short_9x16",
  ],
};
/** Bundled but switched off until the user enables them (remote command execution). */
const OFF_BY_DEFAULT: Record<string, string[]> = {
  machines: [
    "machine_add",
    "machine_add_repo",
    "machine_get_file",
    "machine_put_file",
    "machine_remove",
    "machine_remove_repo",
    "machine_run",
    "machine_status",
    "machine_update_repo",
    "machines_list",
  ],
  sandbox: [
    "docker_run",
    "sandbox_create",
    "sandbox_destroy",
    "sandbox_read_file",
    "sandbox_run_code",
    "sandbox_run_command",
    "sandbox_write_file",
  ],
  x402: ["x402_fetch", "x402_quote", "x402_wallet"],
};
/**
 * Provider packs publish a catalog that follows the provider (curated model
 * tools come and go), so their surface is pinned by rule: every tool carries
 * the pack's prefix, and these entry points exist.
 */
const PROVIDER_PACKS: Record<string, string[]> = {
  elevenlabs: ["elevenlabs_text_to_speech", "elevenlabs_list_voices"],
  fal: ["fal_search_models", "fal_describe_model", "fal_run"],
  gemini: ["gemini_generate_image", "gemini_list_models"],
  local: ["local_status", "local_media_convert", "local_audio_mix"],
  openrouter: ["openrouter_search_models", "openrouter_describe_model", "openrouter_run"],
  replicate: ["replicate_search_models", "replicate_describe_model", "replicate_run"],
};
/** Served by the MCP layer itself (the fallback for clients without Tasks). */
const PROTOCOL_TOOLS = ["cancel_job", "wait_for_job"];
/** Names earlier versions served that are gone; none may come back by accident. */
const REMOVED_TOOL_NAMES = [
  "convert_media",
  "mix_audio",
  "generate_audio",
  "list_voices",
  "sample_voices",
  "list_video_models",
  "media_backend_status",
  "reconcile_video_job",
  "list_catalog",
  "route_capability",
  "gateway_reload",
];

type Harness = FullHarness;
const boot = (accessKey: string | null) => bootFull({ accessKey, profiles: false });

function modernClient(base: string, headers?: Record<string, string>) {
  const client = new Client(
    { name: "mcp-e2e-test", version: "1.0.0" },
    { versionNegotiation: { mode: "auto" } },
  );
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: headers ? { headers } : undefined,
  });
  return { client, transport };
}

function parseToolText(result: unknown): { ok: boolean; result?: unknown; error?: unknown } {
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  expect(content[0]?.type).toBe("text");
  return JSON.parse(content[0]!.text);
}

/** Raw request with an arbitrary Host header (fetch forbids overriding Host). */
function rawPost(
  port: number,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/mcp", method: "POST", headers },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Parse a JSON-RPC response that may arrive as JSON or as an SSE stream. */
async function readJsonRpc(res: Response): Promise<Record<string, unknown>> {
  const type = res.headers.get("content-type") ?? "";
  const text = await res.text();
  if (type.includes("text/event-stream")) {
    const messages = text
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => JSON.parse(line.slice(5).trim()) as Record<string, unknown>);
    const reply = messages.find((m) => "result" in m || "error" in m);
    if (!reply) throw new Error(`no JSON-RPC reply in SSE body: ${text}`);
    return reply;
  }
  return JSON.parse(text) as Record<string, unknown>;
}

const INIT_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "legacy-raw", version: "0.0.1" },
  },
});

describe("MCP e2e over createApp (no access key)", () => {
  let h: Harness;

  beforeEach(async () => {
    h = await boot(null);
  });

  afterEach(async () => {
    await h?.close();
  });

  it("a bundled pack that ships off serves nothing until it is enabled, with no review step", async () => {
    const listed = async () => {
      const res = await fetch(`${h.base}/api/packs`, { headers: apiHeaders() });
      const body = (await res.json()) as { packs: Array<Record<string, unknown>> };
      return body.packs;
    };
    for (const [pack, tools] of Object.entries(OFF_BY_DEFAULT)) {
      expect(
        (await listed()).find((p) => p.id === pack),
        pack,
      ).toMatchObject({
        source: "builtin",
        enabled: false,
        state: "disabled",
      });
      for (const name of tools) expect(h.runtime.registry.get(name), name).toBeUndefined();

      const res = await fetch(`${h.base}/api/packs/${pack}/enable`, {
        method: "POST",
        headers: apiHeaders(),
        body: "{}",
      });
      expect(res.status, pack).toBe(200);
      expect(
        h.runtime.registry
          .list()
          .filter((t) => t.packId === pack)
          .map((t) => t.name)
          .sort(),
        pack,
      ).toEqual(tools);
    }
  });

  it("modern client: lists tools, calls a keyless tool, maps errors", async () => {
    const { client, transport } = modernClient(h.base);
    await client.connect(transport);
    try {
      expect(client.getProtocolEra()).toBe("modern");
      expect(client.getNegotiatedProtocolVersion()).toBe("2026-07-28");

      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      const byPack: Record<string, string[]> = {};
      for (const t of h.runtime.registry.list()) (byPack[t.packId] ??= []).push(t.name);
      for (const list of Object.values(byPack)) list.sort();
      expect(Object.keys(byPack).sort()).toEqual(
        [...Object.keys(DEFAULT_TOOL_SURFACE), ...Object.keys(PROVIDER_PACKS)].sort(),
      );
      for (const [pack, expected] of Object.entries(DEFAULT_TOOL_SURFACE)) {
        expect(byPack[pack], pack).toEqual(expected);
      }
      for (const [pack, entryPoints] of Object.entries(PROVIDER_PACKS)) {
        expect(byPack[pack], pack).toEqual(expect.arrayContaining(entryPoints));
        expect(
          byPack[pack]!.filter((n) => !n.startsWith(`${pack}_`)),
          pack,
        ).toEqual([]);
      }
      // What a client lists is exactly the registry plus the protocol tools.
      expect([...names].sort()).toEqual(
        [...Object.values(byPack).flat(), ...PROTOCOL_TOOLS].sort(),
      );
      for (const gone of REMOVED_TOOL_NAMES) expect(names, gone).not.toContain(gone);
      expect(new Set(names).size).toBe(names.length);
      const gs = tools.find((t) => t.name === "usage_report")!;
      expect(gs.inputSchema.type).toBe("object");
      expect(gs.inputSchema).not.toHaveProperty("$schema");
      expect(
        (gs.inputSchema.properties as Record<string, { default?: unknown }>).include_events
          ?.default,
      ).toBe(false);

      const ok = parseToolText(await client.callTool({ name: "gateway_status", arguments: {} }));
      expect(ok.ok).toBe(true);

      const listed = parseToolText(
        await client.callTool({ name: "list_artifacts", arguments: { limit: 5 } }),
      );
      expect(listed.ok).toBe(true);

      // send_telegram now comes from packs/telegram; no token configured here.
      const missing = parseToolText(
        await client.callTool({ name: "send_telegram", arguments: { text: "hi", chat_id: "1" } }),
      );
      expect(missing.ok).toBe(false);
      expect(missing.error).toMatchObject({
        code: "MISSING_SECRET",
        pack: "telegram",
        secret: "TELEGRAM_BOT_TOKEN",
        label: "Telegram bot token",
      });

      const unknown = await client.callTool({ name: "no_such_tool", arguments: {} }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(unknown).toBeInstanceOf(ProtocolError);
      expect((unknown as ProtocolError).code).toBe(-32602);
      expect(String((unknown as Error).message)).toContain("unknown tool: no_such_tool");

      const invalid = await client
        .callTool({ name: "gateway_status", arguments: { probe_mounts: "yes" } })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(invalid).toBeInstanceOf(ProtocolError);
      expect((invalid as ProtocolError).code).toBe(-32602);
      expect(String((invalid as Error).message)).toContain("invalid arguments for gateway_status");
    } finally {
      await client.close();
    }
  });

  it("legacy 2025-03-26 client over raw fetch: initialize then tools/list", async () => {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const initRes = await fetch(`${h.base}/mcp`, { method: "POST", headers, body: INIT_BODY });
    expect(initRes.status).toBe(200);
    // legacy: 'stateless' -> no session is minted.
    expect(initRes.headers.get("mcp-session-id")).toBeNull();
    const init = await readJsonRpc(initRes);
    const initResult = init.result as { protocolVersion: string; capabilities: unknown };
    expect(initResult.protocolVersion).toBe("2025-03-26");
    expect(initResult.capabilities).toHaveProperty("tools");

    const legacyHeaders = { ...headers, "mcp-protocol-version": initResult.protocolVersion };
    const sessionId = initRes.headers.get("mcp-session-id");
    if (sessionId) Object.assign(legacyHeaders, { "mcp-session-id": sessionId });

    const notified = await fetch(`${h.base}/mcp`, {
      method: "POST",
      headers: legacyHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notified.status).toBeLessThan(300);

    const listRes = await fetch(`${h.base}/mcp`, {
      method: "POST",
      headers: legacyHeaders,
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(listRes.status).toBe(200);
    const list = await readJsonRpc(listRes);
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toContain("gateway_status");

    // No standalone SSE stream / session teardown under legacy: 'stateless'.
    const get = await fetch(`${h.base}/mcp`, {
      method: "GET",
      headers: { accept: "text/event-stream", "mcp-protocol-version": "2025-03-26" },
    });
    expect(get.status).toBe(405);
    await get.body?.cancel();
  });

  it("rejects a non-loopback Host header with 403", async () => {
    const res = await rawPost(
      h.port,
      {
        host: `evil.example:${h.port}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      INIT_BODY,
    );
    expect(res.status).toBe(403);
  });

  it("rejects a cross-site Origin with 403 and accepts no Origin", async () => {
    const headers = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    const evil = await fetch(`${h.base}/mcp`, {
      method: "POST",
      headers: { ...headers, origin: "https://evil.example" },
      body: INIT_BODY,
    });
    expect(evil.status).toBe(403);
    expect(await evil.json()).toMatchObject({ ok: false, error: { code: "FORBIDDEN_ORIGIN" } });

    const local = await fetch(`${h.base}/mcp`, {
      method: "POST",
      headers: { ...headers, origin: `http://127.0.0.1:${h.port}` },
      body: INIT_BODY,
    });
    expect(local.status).toBe(200);

    const none = await fetch(`${h.base}/health`);
    expect(none.status).toBe(200);
    expect(await none.json()).toEqual({ ok: true, version: expect.any(String) });
    const admin = await fetch(`${h.base}/health`, { headers: apiHeaders() });
    expect(admin.status).toBe(200);
    const health = (await admin.json()) as {
      packs: { failed: number; loaded: number };
      core_tools: number;
    };
    expect(health).toMatchObject({ ok: true, auth_required: false });
    expect(health.packs).toMatchObject({ failed: 0 });
    expect(health.packs.loaded).toBeGreaterThanOrEqual(2);
    expect(health.core_tools).toBe(6);
    expect(health).not.toHaveProperty("vendors");
  });
});

describe("MCP e2e over createApp (access key configured)", () => {
  const KEY = "e2e-test-access-key";
  let h: Harness;

  beforeEach(async () => {
    h = await boot(KEY);
  });

  afterEach(async () => {
    await h?.close();
  });

  it("returns 401 without the key and works with a Bearer key", async () => {
    const raw = await fetch(`${h.base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: INIT_BODY,
    });
    expect(raw.status).toBe(401);
    expect(await raw.json()).toMatchObject({ ok: false, error: { code: "UNAUTHORIZED" } });

    const anon = modernClient(h.base);
    await expect(anon.client.connect(anon.transport)).rejects.toThrow();
    await anon.client.close().catch(() => {});

    const { client, transport } = modernClient(h.base, { authorization: `Bearer ${KEY}` });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      const ok = parseToolText(await client.callTool({ name: "gateway_status", arguments: {} }));
      expect(ok.ok).toBe(true);
    } finally {
      await client.close();
    }
  });
});
