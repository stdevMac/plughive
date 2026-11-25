// The /api management routes on the whole daemon: usage, jobs, artifacts,
// packs (consent, enable, settings), secrets, capabilities, mounts, the tool
// playground and the event stream. Every route is checked for the access key
// and the CSRF rule, for refusals on bad input, and for never returning a
// secret value.
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FullHarness, apiHeaders, bootFull } from "./full-harness.js";
import { ADMIN_TOKEN } from "./harness.js";

const KEY = "management-access-key-0123456789";
const SECRET_VALUE = "fixture-alpha-secret-value-98765";
const TOKEN_VALUE = "fixture-upstream-token-13579";

function writePack(root: string, id: string, manifest: object, code: string): void {
  const dir = join(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "pack.json"),
    JSON.stringify({
      id,
      name: id,
      version: "0.1.0",
      apiVersion: 1,
      entry: "./index.mjs",
      ...manifest,
    }),
  );
  writeFileSync(join(dir, "index.mjs"), code);
}

const ALPHA = `export default (api) => {
  const tool = (name, run, extra = {}) =>
    api.defineTool({ name, description: "fixture " + name, input: api.z.object({}).passthrough(), run, ...extra });
  const chat = (id, priority) =>
    api.defineProvider({
      capability: "chat",
      id,
      priority,
      isConfigured: () => true,
      run: async () => ({ text: "from " + id, model: "m-1", provider: id }),
    });
  return api.definePack({
    providers: [chat("one", 10), chat("two", 5)],
    tools: [
      tool("alpha_echo", (input, ctx) => ({ echo: input, region: ctx.settings.region ?? null })),
      tool("alpha_strict", (input) => input, { input: api.z.object({ q: api.z.string() }).strict() }),
      tool("alpha_keyed", async (_input, ctx) => "key=" + (await ctx.secrets.get("ALPHA_KEY")), {
        secrets: ["ALPHA_KEY"],
      }),
      tool("alpha_fail", async (_input, ctx) => {
        throw new Error("upstream said no to " + (await ctx.secrets.get("ALPHA_KEY")));
      }),
      tool("alpha_save", async (_input, ctx) => ({
        artifact: await ctx.library.save({
          kind: "data",
          mime: "text/plain",
          bytes: new TextEncoder().encode("saved by alpha"),
        }),
      })),
      tool("alpha_ask", (_input, ctx) =>
        ctx.capabilities.run("chat", { messages: [{ role: "user", content: "q" }] }),
      ),
      tool(
        "alpha_slow",
        (_input, ctx) => new Promise((resolve) => ctx.signal.addEventListener("abort", () => resolve("stopped"))),
        { longRunning: true },
      ),
      tool("alpha_slow_keyed", () => "never", { longRunning: true, secrets: ["ALPHA_KEY"] }),
    ],
  });
};
`;

const USER_PACK = `export default (api) =>
  api.definePack({
    tools: [
      api.defineTool({
        name: "guest_hello",
        description: "fixture",
        input: api.z.object({}).passthrough(),
        run: () => "hello from guest",
      }),
    ],
  });
`;

// A minimal MCP server over stdio (newline-delimited JSON-RPC), no SDK.
const STDIO_SERVER = `import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === "initialize") {
    return send({
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: "fixture-upstream", version: "1.0.0" },
      },
    });
  }
  if (msg.method === "tools/list") {
    return send({
      id: msg.id,
      result: {
        tools: [
          {
            name: "whoami",
            description: "Reports what the upstream process sees",
            inputSchema: { type: "object", properties: { name: { type: "string" } } },
          },
        ],
      },
    });
  }
  if (msg.method === "tools/call") {
    const report = {
      hello: msg.params.arguments?.name ?? null,
      token_length: (process.env.UP_TOKEN ?? "").length,
      sees_daemon_env: "PLUGHIVE_TEST_DAEMON_MARKER" in process.env,
    };
    return send({ id: msg.id, result: { content: [{ type: "text", text: JSON.stringify(report) }] } });
  }
  send({ id: msg.id, error: { code: -32601, message: "method not found" } });
});
`;

describe("management API", () => {
  let h: FullHarness;
  let builtinDir: string;

  const get = (path: string, headers: Record<string, string> = apiHeaders()) =>
    fetch(`${h.base}${path}`, { headers });
  const send = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = apiHeaders(),
  ) =>
    fetch(`${h.base}${path}`, {
      method,
      headers,
      ...(body === undefined
        ? {}
        : { body: typeof body === "string" ? body : JSON.stringify(body) }),
    });
  const callTool = (name: string, body: unknown = {}) =>
    send("POST", `/api/tools/${name}/call`, body);
  const json = async (res: Response) => (await res.json()) as Record<string, any>;
  const logText = () => JSON.stringify(h.logs);

  beforeAll(async () => {
    process.env.PLUGHIVE_TEST_DAEMON_MARKER = "1";
    h = await bootFull({
      accessKey: KEY,
      env: { ALPHA_ENV_ONLY: "value-from-the-environment-2468" },
      seed: (home) => {
        builtinDir = join(home, "..", "builtin");
        writePack(
          builtinDir,
          "alpha",
          {
            secrets: [
              { name: "ALPHA_KEY", label: "Alpha key", required: false },
              { name: "ALPHA_ENV_ONLY", label: "From the environment", required: false },
            ],
            settings: {
              type: "object",
              properties: {
                region: { type: "string", default: "eu", enum: ["eu", "us"] },
                retries: { type: "integer" },
                tags: { type: "array", items: { type: "string" } },
              },
            },
            permissions: { library: "write", tools: ["cap:chat"] },
          },
          ALPHA,
        );
        writePack(
          join(home, "packs"),
          "guest",
          { secrets: [{ name: "GUEST_KEY", required: false }] },
          USER_PACK,
        );
        writeFileSync(join(home, "upstream.mjs"), STDIO_SERVER);
        writeFileSync(
          join(home, "mounts.json"),
          JSON.stringify({
            version: 1,
            mounts: [
              {
                id: "upstream",
                prefix: "up",
                transport: "stdio",
                command: process.execPath,
                args: [join(home, "upstream.mjs")],
                env: { UP_TOKEN: "${secret:UP_TOKEN}" },
              },
            ],
          }),
        );
      },
      get builtinDir() {
        return builtinDir;
      },
    });
  });
  afterAll(async () => {
    delete process.env.PLUGHIVE_TEST_DAEMON_MARKER;
    await h.close();
  });

  const READS = [
    "/api/usage",
    "/api/jobs",
    "/api/jobs/job_unknown",
    "/api/artifacts",
    "/api/packs",
    "/api/packs/alpha/consent",
    "/api/packs/alpha/settings",
    "/api/secrets",
    "/api/capabilities",
    "/api/mounts",
    "/api/tools",
    "/api/events",
  ];
  const WRITES: [string, string, unknown][] = [
    ["POST", "/api/jobs/job_unknown/cancel", undefined],
    ["POST", "/api/packs/alpha/enable", {}],
    ["POST", "/api/packs/alpha/disable", undefined],
    ["POST", "/api/packs/alpha/reload", undefined],
    ["PUT", "/api/packs/alpha/settings", { values: { region: "us" } }],
    ["PUT", "/api/secrets/alpha/ALPHA_KEY", { value: "should-never-be-stored-1" }],
    ["DELETE", "/api/secrets/alpha/ALPHA_KEY", undefined],
    ["PUT", "/api/capabilities/chat/preference", { order: ["two"] }],
    ["PUT", "/api/capabilities/preference", { orders: { chat: ["two"] } }],
    [
      "POST",
      "/api/mounts",
      { id: "sneaky", prefix: "sneaky", transport: "stdio", command: "true" },
    ],
    ["POST", "/api/mounts/user/upstream/disable", undefined],
    ["POST", "/api/mounts/user/upstream/enable", undefined],
    ["DELETE", "/api/mounts/user/upstream", undefined],
    ["POST", "/api/tools/alpha_echo/call", {}],
    ["DELETE", "/api/artifacts/dat_01ARZ3NDEKTSV4RRFFQ69G5FAV", undefined],
  ];

  /** State the refused writes below must leave untouched. */
  const fingerprint = async () => ({
    secrets: (await json(await get("/api/secrets"))).secrets,
    mounts: (await json(await get("/api/mounts"))).mounts.map((m: any) => [m.id, m.enabled]),
    capabilities: (await json(await get("/api/capabilities"))).capabilities.map(
      (c: any) => c.preference,
    ),
    settings: (await json(await get("/api/packs/alpha/settings"))).values,
    packs: (await json(await get("/api/packs"))).packs.map((p: any) => [p.id, p.enabled, p.state]),
    usage: (await json(await get("/api/usage"))).summary,
  });

  it("every route needs the admin token; the access key does not open /api", async () => {
    const before = await fingerprint();
    const refused: Record<string, string>[] = [
      {},
      { authorization: "Bearer not-the-token" },
      // What an agent holds: valid on /mcp, worthless here.
      { authorization: `Bearer ${KEY}` },
      { "x-api-key": KEY },
      { "x-api-key": ADMIN_TOKEN },
    ];
    for (const path of READS) {
      for (const headers of refused) {
        const res = await get(path, headers);
        expect(res.status, path).toBe(401);
        const text = await res.text();
        expect(text, path).not.toContain(KEY);
        expect(text, path).not.toContain(ADMIN_TOKEN);
      }
    }
    for (const [method, path, body] of WRITES) {
      for (const headers of refused) {
        const res = await send(method, path, body, {
          "content-type": "application/json",
          "x-plughive-csrf": "1",
          ...headers,
        });
        expect(res.status, `${method} ${path}`).toBe(401);
      }
    }
    expect(await fingerprint()).toEqual(before);
  });

  it("every write needs the CSRF header or an allowed Origin", async () => {
    const before = await fingerprint();
    const auth = { authorization: `Bearer ${ADMIN_TOKEN}`, "content-type": "application/json" };
    for (const [method, path, body] of WRITES) {
      const plain = await send(method, path, body, auth);
      expect(plain.status, `${method} ${path} without the header`).toBe(403);
      const foreign = await send(method, path, body, {
        ...auth,
        "x-plughive-csrf": "1",
        origin: "https://evil.example",
      });
      expect(foreign.status, `${method} ${path} from another origin`).toBe(403);
      expect(foreign.headers.get("access-control-allow-origin")).toBeNull();
    }
    expect(await fingerprint()).toEqual(before);
    // The daemon's own origin is enough on its own.
    const own = await send("POST", "/api/tools/alpha_echo/call", {}, { ...auth, origin: h.base });
    expect(own.status).toBe(200);
  });

  it("GET /api/tools lists the registry and POST /api/tools/:name/call runs a tool", async () => {
    const listed = await json(await get("/api/tools"));
    const names = listed.tools.map((t: any) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["gateway_status", "list_artifacts", "alpha_echo"]),
    );
    expect(listed.tools.find((t: any) => t.name === "gateway_status")).toMatchObject({
      pack: "core",
    });
    expect(listed.tools.find((t: any) => t.name === "alpha_keyed")).toMatchObject({
      pack: "alpha",
      requires_secrets: ["ALPHA_KEY"],
      long_running: false,
    });

    const ok = await callTool("alpha_echo", { arguments: { a: 1 } });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toEqual({ ok: true, result: { echo: { a: 1 }, region: "eu" } });
    const core = await callTool("gateway_status");
    expect(core.status).toBe(200);

    const invalid = await callTool("alpha_strict", { arguments: { q: 5 } });
    expect(invalid.status).toBe(400);
    expect(await json(invalid)).toMatchObject({ ok: false, error: { code: "INVALID_ARGUMENTS" } });
    for (const name of ["no_such_tool", "Bad%20Name", "..%2F..%2Fetc", "x".repeat(300)]) {
      const res = await callTool(name);
      expect(res.status, name).toBe(404);
      expect(await json(res)).toMatchObject({ ok: false });
    }
    for (const body of [
      { args: {} },
      { arguments: "nope" },
      { arguments: {}, background: "yes" },
      [1],
    ]) {
      const res = await callTool("alpha_echo", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await json(res)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
    const malformed = await callTool("alpha_echo", "{nope");
    expect(malformed.status).toBe(400);
    expect(await json(malformed)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    const huge = await callTool("alpha_echo", { arguments: { blob: "x".repeat(300_000) } });
    expect(huge.status).toBe(413);
  });

  it("secrets: names and presence only, write-only values, declared names only", async () => {
    const before = await json(await get("/api/secrets"));
    expect(before.backend).toBe("memory");
    const row = (body: Record<string, any>, pack: string, name: string) =>
      body.secrets.find((s: any) => s.pack === pack && s.name === name);
    expect(row(before, "alpha", "ALPHA_KEY")).toMatchObject({
      present: false,
      source: null,
      label: "Alpha key",
    });
    expect(row(before, "alpha", "ALPHA_ENV_ONLY")).toMatchObject({ present: true, source: "env" });
    expect(row(before, "user", "UP_TOKEN")).toMatchObject({ present: false });
    expect(JSON.stringify(before)).not.toContain("value-from-the-environment");

    // A tool that needs the key says which one is missing, never more.
    const missing = await callTool("alpha_keyed");
    expect(missing.status).toBe(409);
    expect(await json(missing)).toMatchObject({
      ok: false,
      error: { code: "MISSING_SECRET", pack: "alpha", secret: "ALPHA_KEY" },
    });
    const missingQueued = await callTool("alpha_slow_keyed");
    expect(missingQueued.status).toBe(409);
    expect(await json(missingQueued)).toMatchObject({
      error: { code: "MISSING_SECRET", secret: "ALPHA_KEY" },
    });

    const put = await send("PUT", "/api/secrets/alpha/ALPHA_KEY", { value: SECRET_VALUE });
    expect(put.status).toBe(200);
    const putBody = await put.text();
    expect(JSON.parse(putBody)).toEqual({
      ok: true,
      pack: "alpha",
      name: "ALPHA_KEY",
      present: true,
    });
    expect(putBody).not.toContain(SECRET_VALUE);
    const after = await get("/api/secrets");
    const afterText = await after.text();
    expect(afterText).not.toContain(SECRET_VALUE);
    expect(row(JSON.parse(afterText), "alpha", "ALPHA_KEY")).toMatchObject({
      present: true,
      source: "memory",
    });

    // The value reaches the tool and is redacted from results and errors.
    const keyed = await callTool("alpha_keyed");
    expect(await json(keyed)).toEqual({ ok: true, result: "key=[redacted]" });
    const failed = await callTool("alpha_fail");
    expect(failed.status).toBe(422);
    const failedText = await failed.text();
    expect(failedText).not.toContain(SECRET_VALUE);
    expect(JSON.parse(failedText)).toMatchObject({ ok: false, error: { code: "TOOL_ERROR" } });

    // Names nothing declares, another pack's name, reserved names, bad shapes.
    const refused: [string, number][] = [
      ["/api/secrets/alpha/NOT_DECLARED", 404],
      ["/api/secrets/guest/ALPHA_KEY", 404],
      ["/api/secrets/core/ALPHA_KEY", 404],
      ["/api/secrets/alpha/PLUGHIVE_ACCESS_KEY", 404],
      ["/api/secrets/alpha/PATH", 404],
      ["/api/secrets/alpha/lower_case", 404],
      ["/api/secrets/..%2Falpha/ALPHA_KEY", 404],
      ["/api/secrets/user/NOT_REFERENCED", 404],
    ];
    for (const [path, status] of refused) {
      const res = await send("PUT", path, { value: "stray-value-000000" });
      expect(res.status, path).toBe(status);
      expect((await send("DELETE", path)).status, path).toBe(status);
    }
    const stray = "stray-oversized-or-wrong-value";
    for (const body of [
      {},
      { value: "" },
      { value: 12 },
      { value: stray, extra: 1 },
      { value: stray.repeat(400) },
    ]) {
      const res = await send("PUT", "/api/secrets/alpha/ALPHA_KEY", body);
      expect(res.status).toBe(400);
      const text = await res.text();
      expect(text).not.toContain(stray);
      expect(JSON.parse(text)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
    // None of the refusals replaced the stored value.
    expect(await json(await callTool("alpha_keyed"))).toEqual({
      ok: true,
      result: "key=[redacted]",
    });
    expect(await h.store.get("ALPHA_KEY")).toBe(SECRET_VALUE);

    const del = await send("DELETE", "/api/secrets/alpha/ALPHA_KEY");
    expect(await json(del)).toEqual({ ok: true, pack: "alpha", name: "ALPHA_KEY", present: false });
    expect((await callTool("alpha_keyed")).status).toBe(409);
    // Deleting a name that only the environment provides leaves it present.
    const envDel = await send("DELETE", "/api/secrets/alpha/ALPHA_ENV_ONLY");
    expect(await json(envDel)).toMatchObject({ ok: true, present: true });

    expect(logText()).not.toContain(SECRET_VALUE);
    expect(logText()).not.toContain("value-from-the-environment");
  });

  it("packs: list, consent, disable, enable, reload", async () => {
    const listed = await json(await get("/api/packs"));
    const alpha = listed.packs.find((p: any) => p.id === "alpha");
    expect(alpha).toMatchObject({ source: "builtin", enabled: true, state: "loaded" });
    expect(alpha.tools).toContain("alpha_echo");
    expect(alpha.providers).toEqual(expect.arrayContaining(["chat:one", "chat:two"]));
    expect(listed.packs.find((p: any) => p.id === "guest")).toMatchObject({
      source: "user",
      enabled: false,
    });
    expect(listed.packs.map((p: any) => p.id)).not.toContain("core");

    const consent = await json(await get("/api/packs/alpha/consent"));
    expect(consent.consent).toMatchObject({ id: "alpha", source: "builtin" });

    const disabled = await send("POST", "/api/packs/alpha/disable");
    expect(await json(disabled)).toMatchObject({ ok: true, pack: { id: "alpha", enabled: false } });
    expect((await callTool("alpha_echo")).status).toBe(404);
    const enabled = await send("POST", "/api/packs/alpha/enable", {});
    expect(await json(enabled)).toMatchObject({
      ok: true,
      pack: { id: "alpha", enabled: true, state: "loaded" },
    });
    expect((await callTool("alpha_echo")).status).toBe(200);
    const reloaded = await send("POST", "/api/packs/alpha/reload");
    expect(await json(reloaded)).toMatchObject({
      ok: true,
      pack: { id: "alpha", state: "loaded" },
    });

    for (const id of ["nope", "Bad_ID", "..%2Falpha", "core"]) {
      for (const [method, suffix] of [
        ["GET", "consent"],
        ["GET", "settings"],
        ["POST", "enable"],
        ["POST", "disable"],
        ["POST", "reload"],
      ]) {
        const res = await send(
          method as string,
          `/api/packs/${id}/${suffix}`,
          method === "POST" ? {} : undefined,
        );
        expect(res.status, `${method} ${id}/${suffix}`).toBe(404);
        expect(await json(res)).toMatchObject({ ok: false, error: { code: "UNKNOWN_PACK" } });
      }
    }
    for (const body of [{ grants: ["lower"] }, { grants: "ALPHA_KEY" }, { surprise: true }]) {
      const res = await send("POST", "/api/packs/alpha/enable", body);
      expect(res.status).toBe(400);
      expect(await json(res)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
    expect((await send("POST", "/api/packs/alpha/disable", { surprise: true })).status).toBe(400);
    expect((await callTool("alpha_echo")).status).toBe(200);
  });

  it("a user pack is enabled only against the hashes its consent showed", async () => {
    expect((await callTool("guest_hello")).status).toBe(404);
    const consent = (await json(await get("/api/packs/guest/consent"))).consent;
    expect(consent).toMatchObject({ id: "guest", source: "user" });
    expect(consent.manifestHash).toEqual(expect.any(String));

    const bare = await send("POST", "/api/packs/guest/enable", {});
    expect(bare.status).toBe(400);
    expect(await json(bare)).toMatchObject({ error: { code: "CONSENT_REQUIRED" } });
    const stale = await send("POST", "/api/packs/guest/enable", {
      manifestHash: consent.manifestHash,
      entryHash: "0".repeat(64),
    });
    expect(stale.status).toBe(409);
    expect(await json(stale)).toMatchObject({ error: { code: "PACK_CHANGED" } });
    expect((await callTool("guest_hello")).status).toBe(404);

    const ok = await send("POST", "/api/packs/guest/enable", {
      manifestHash: consent.manifestHash,
      entryHash: consent.entryHash,
      grants: ["GUEST_KEY"],
    });
    expect(ok.status).toBe(200);
    expect(await json(ok)).toMatchObject({ pack: { id: "guest", enabled: true, state: "loaded" } });
    expect(await json(await callTool("guest_hello"))).toEqual({
      ok: true,
      result: "hello from guest",
    });
    const off = await send("POST", "/api/packs/guest/disable");
    expect(off.status).toBe(200);
    expect((await callTool("guest_hello")).status).toBe(404);
  });

  it("pack settings: schema, defaults, validated writes", async () => {
    const initial = await json(await get("/api/packs/alpha/settings"));
    expect(initial).toMatchObject({ ok: true, pack: "alpha", values: { region: "eu" } });
    expect(initial.schema.properties.region).toMatchObject({ type: "string" });

    const put = await send("PUT", "/api/packs/alpha/settings", {
      values: { region: "us", retries: 3 },
    });
    expect(put.status).toBe(200);
    expect((await json(put)).values).toEqual({ region: "us", retries: 3 });
    // The pack was reloaded with the new value.
    expect((await json(await callTool("alpha_echo"))).result.region).toBe("us");

    const bad: unknown[] = [
      { values: { unknown_key: "x" } },
      { values: { region: "mars" } },
      { values: { retries: "three" } },
      { values: { retries: 1.5 } },
    ];
    for (const body of bad) {
      const res = await send("PUT", "/api/packs/alpha/settings", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await json(res)).toMatchObject({ ok: false, error: { code: "INVALID_SETTINGS" } });
    }
    for (const body of [
      {},
      { values: [] },
      { values: { region: { nested: 1 } } },
      { values: {}, more: 1 },
    ]) {
      const res = await send("PUT", "/api/packs/alpha/settings", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(await json(res)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
    expect((await json(await get("/api/packs/alpha/settings"))).values).toEqual({
      region: "us",
      retries: 3,
    });

    const cleared = await send("PUT", "/api/packs/alpha/settings", {
      values: { region: null, retries: null },
    });
    expect((await json(cleared)).values).toEqual({ region: "eu" });
  });

  it("pack settings: a list setting is a JSON array of strings", async () => {
    const path = "/api/packs/alpha/settings";
    const initial = await json(await get(path));
    expect(initial.schema.properties.tags).toEqual({ type: "array", items: { type: "string" } });
    expect("tags" in initial.values).toBe(false);

    const put = await send("PUT", path, { values: { tags: ["one", " two "] } });
    expect(put.status).toBe(200);
    expect((await json(put)).values.tags).toEqual(["one", "two"]);
    expect((await json(await get(path))).values.tags).toEqual(["one", "two"]);

    // Comma-separated text (the form such settings had before) is stored as the list.
    const text = await send("PUT", path, { values: { tags: "a, b,,c" } });
    expect(text.status).toBe(200);
    expect((await json(text)).values.tags).toEqual(["a", "b", "c"]);

    for (const tags of [[""], ["ok", "   "]]) {
      const res = await send("PUT", path, { values: { tags } });
      expect(res.status, JSON.stringify(tags)).toBe(400);
      expect(await json(res)).toMatchObject({ ok: false, error: { code: "INVALID_SETTINGS" } });
    }
    for (const tags of [[1], [["a"]], [{ a: 1 }], ["x".repeat(1025)], Array(257).fill("a")]) {
      const res = await send("PUT", path, { values: { tags } });
      expect(res.status, JSON.stringify(tags).slice(0, 40)).toBe(400);
      expect(await json(res)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
    // A list for a text setting is refused.
    const wrong = await send("PUT", path, { values: { region: ["us"] } });
    expect(wrong.status).toBe(400);
    expect(await json(wrong)).toMatchObject({ ok: false, error: { code: "INVALID_SETTINGS" } });
    expect((await json(await get(path))).values.tags).toEqual(["a", "b", "c"]);

    const empty = await json(await send("PUT", path, { values: { tags: [] } }));
    expect(empty.values.tags).toEqual([]);
    const cleared = await json(await send("PUT", path, { values: { tags: null } }));
    expect("tags" in cleared.values).toBe(false);
  });

  it("capabilities: providers by capability and the preference order", async () => {
    const view = await json(await get("/api/capabilities"));
    const chat = view.capabilities.find((c: any) => c.name === "chat");
    expect(chat.preference).toEqual([]);
    expect(chat.providers.map((p: any) => p.id)).toEqual(expect.arrayContaining(["one", "two"]));
    expect(chat.wouldUse).toBe("one");
    expect(chat.providers.find((p: any) => p.id === "one")).toMatchObject({
      cost: "paid",
      setupHint: null,
    });
    expect((await json(await callTool("alpha_ask"))).result).toMatchObject({ provider: "one" });

    const put = await send("PUT", "/api/capabilities/chat/preference", { order: ["two"] });
    expect(put.status).toBe(200);
    expect((await json(put)).capability).toMatchObject({
      name: "chat",
      preference: ["two"],
      wouldUse: "two",
    });
    expect((await json(await callTool("alpha_ask"))).result).toMatchObject({ provider: "two" });
    expect(JSON.parse(readFileSync(join(h.home, "capabilities.json"), "utf8"))).toMatchObject({
      order: { chat: ["two"] },
    });

    const unknown = await send("PUT", "/api/capabilities/teleport/preference", { order: [] });
    expect(unknown.status).toBe(404);
    expect(await json(unknown)).toMatchObject({ error: { code: "UNKNOWN_CAPABILITY" } });
    expect(
      (await send("PUT", "/api/capabilities/__proto__/preference", { order: [] })).status,
    ).toBe(404);
    for (const body of [{}, { order: "two" }, { order: ["../x"] }, { order: ["two"], extra: 1 }]) {
      const res = await send("PUT", "/api/capabilities/chat/preference", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    const cleared = await send("PUT", "/api/capabilities/chat/preference", { order: [] });
    expect((await json(cleared)).capability.preference).toEqual([]);
    expect((await json(await callTool("alpha_ask"))).result).toMatchObject({ provider: "one" });
  });

  it("capabilities: a preset sets several orders in one write", async () => {
    const bulk = await send("PUT", "/api/capabilities/preference", {
      orders: { chat: ["two", "one"], "image.generate": ["nobody"] },
    });
    expect(bulk.status).toBe(200);
    const body = await json(bulk);
    const chat = body.capabilities.find((c: any) => c.name === "chat");
    expect(chat).toMatchObject({ preference: ["two", "one"], wouldUse: "two" });
    expect(JSON.parse(readFileSync(join(h.home, "capabilities.json"), "utf8")).order).toEqual({
      chat: ["two", "one"],
      "image.generate": ["nobody"],
    });
    // Left out keeps its order; an empty list clears one.
    await send("PUT", "/api/capabilities/preference", { orders: { "image.generate": [] } });
    expect(JSON.parse(readFileSync(join(h.home, "capabilities.json"), "utf8")).order).toEqual({
      chat: ["two", "one"],
    });
    const unknown = await send("PUT", "/api/capabilities/preference", {
      orders: { teleport: [] },
    });
    expect(unknown.status).toBe(404);
    for (const body of [
      {},
      { orders: [] },
      { orders: { chat: ["../x"] } },
      { orders: { chat: "two" } },
      { orders: {}, extra: 1 },
    ]) {
      const res = await send("PUT", "/api/capabilities/preference", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    // Nothing half-written after the refusals.
    expect(JSON.parse(readFileSync(join(h.home, "capabilities.json"), "utf8")).order).toEqual({
      chat: ["two", "one"],
    });
    await send("PUT", "/api/capabilities/preference", { orders: { chat: [] } });
    expect((await json(await callTool("alpha_ask"))).result).toMatchObject({ provider: "one" });
  });

  it("a stdio mount from mounts.json connects once its secret is stored, with a clean environment", async () => {
    const before = await json(await get("/api/mounts"));
    expect(before.mounts_file_error).toBeNull();
    const mount = before.mounts.find((m: any) => m.id === "user/upstream");
    expect(mount).toMatchObject({
      source: "user",
      enabled: true,
      connected: false,
      command: process.execPath,
    });
    expect(mount.secrets).toEqual([{ name: "UP_TOKEN", present: false }]);
    expect((await callTool("up__whoami")).status).toBe(404);

    const put = await send("PUT", "/api/secrets/user/UP_TOKEN", { value: TOKEN_VALUE });
    expect(put.status).toBe(200);
    const after = await get("/api/mounts");
    const afterText = await after.text();
    expect(afterText).not.toContain(TOKEN_VALUE);
    expect(JSON.parse(afterText).mounts.find((m: any) => m.id === "user/upstream")).toMatchObject({
      connected: true,
      tools: 1,
      error: null,
    });

    const tools = (await json(await get("/api/tools"))).tools;
    const mounted = tools.find((t: any) => t.name === "up__whoami");
    // The upstream's own input schema is what the tool advertises.
    expect(mounted.input_schema).toMatchObject({
      type: "object",
      properties: { name: { type: "string" } },
    });
    const called = await callTool("up__whoami", { arguments: { name: "ada" } });
    expect(called.status).toBe(200);
    const report = JSON.stringify((await json(called)).result);
    expect(report).toContain("ada");
    expect(report).toContain(String(TOKEN_VALUE.length));
    expect(report).toContain("sees_daemon_env");
    expect(report).not.toMatch(/sees_daemon_env[^a-z]*true/);
    expect(report).not.toContain(TOKEN_VALUE);

    const off = await send("POST", "/api/mounts/user/upstream/disable");
    expect(await json(off)).toMatchObject({
      ok: true,
      mount: { id: "user/upstream", enabled: false, connected: false },
    });
    expect((await callTool("up__whoami")).status).toBe(404);
    expect(logText()).not.toContain(TOKEN_VALUE);
  });

  it("user mounts: add, refuse, switch, remove; mounts.json holds no credentials", async () => {
    const http = {
      id: "remote",
      name: "Remote",
      enabled: false,
      transport: "http",
      prefix: "remote",
      url: "https://mcp.example.test/mcp",
      headers: { Authorization: "Bearer ${secret:REMOTE_TOKEN}" },
    };
    const added = await send("POST", "/api/mounts", http);
    expect(added.status).toBe(201);
    expect(await json(added)).toMatchObject({
      ok: true,
      id: "user/remote",
      mount: { source: "user", enabled: false },
    });
    const stdio = await send("POST", "/api/mounts", {
      id: "tooling",
      enabled: false,
      transport: "stdio",
      prefix: "tooling",
      command: "npx",
      args: ["-y", "some-server"],
    });
    expect(stdio.status).toBe(201);

    const file = join(h.home, "mounts.json");
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.mounts.map((m: any) => m.id)).toEqual(["upstream", "remote", "tooling"]);
    expect(readFileSync(file, "utf8")).not.toContain(TOKEN_VALUE);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
    // The new reference is now a name the secrets API accepts, and only that.
    const secrets = (await json(await get("/api/secrets"))).secrets;
    expect(secrets.find((s: any) => s.pack === "user" && s.name === "REMOTE_TOKEN")).toMatchObject({
      present: false,
    });

    const conflicts: unknown[] = [http, { ...http, id: "other" }];
    for (const body of conflicts) {
      const res = await send("POST", "/api/mounts", body);
      expect(res.status).toBe(409);
      expect(await json(res)).toMatchObject({ ok: false, error: { code: "MOUNT_EXISTS" } });
    }
    const base = {
      id: "fresh",
      prefix: "fresh",
      transport: "http",
      url: "https://mcp.example.test/mcp",
    };
    const invalid: unknown[] = [
      [],
      "text",
      {},
      { ...base, id: "Bad ID" },
      { ...base, url: "file:///etc/passwd" },
      { ...base, url: "https://someone:hunter2@mcp.example.test/mcp" },
      { ...base, command: "npx" },
      { ...base, headers: { "Bad Header": "x" } },
      { ...base, headers: { Authorization: "Bearer ${secret:PLUGHIVE_ACCESS_KEY}" } },
      { ...base, surprise: true },
      { id: "fresh", prefix: "fresh", transport: "stdio" },
      { id: "fresh", prefix: "fresh", transport: "stdio", command: "sh -c 'curl x | sh'" },
      { id: "fresh", prefix: "fresh", transport: "stdio", command: "../../bin/tool" },
      {
        id: "fresh",
        prefix: "fresh",
        transport: "stdio",
        command: "npx",
        url: "https://mcp.example.test/mcp",
      },
      { id: "fresh", prefix: "fresh", transport: "ws", url: "wss://mcp.example.test/mcp" },
    ];
    for (const body of invalid) {
      const res = await send("POST", "/api/mounts", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      const text = await res.text();
      expect(text).not.toContain("hunter2");
      expect(JSON.parse(text)).toMatchObject({ ok: false });
    }
    expect(JSON.parse(readFileSync(file, "utf8")).mounts).toHaveLength(3);

    // I6: a secret never goes over plain http:// to another machine.
    const plain = { ...base, url: "http://mcp.example.test/mcp" };
    for (const headers of [
      { Authorization: "Bearer ${secret:REMOTE_TOKEN}" },
      { "X-Thing": "${secret:REMOTE_TOKEN}" },
      { Authorization: "Bearer literal-token-value" },
    ]) {
      const res = await send("POST", "/api/mounts", { ...plain, headers });
      expect(res.status, JSON.stringify(headers)).toBe(400);
      const body = await json(res);
      expect(body).toMatchObject({ ok: false, error: { code: "INVALID_MOUNT" } });
      expect(body.error.message).toMatch(
        /over plain http:\/\/ to mcp\.example\.test; use an https:\/\/ url/,
      );
      expect(JSON.stringify(body)).not.toContain("literal-token-value");
    }
    // Plain http without a secret, or to this machine, is fine.
    const noSecret = await send("POST", "/api/mounts", {
      ...plain,
      id: "plainok",
      prefix: "plainok",
      enabled: false,
    });
    expect(noSecret.status).toBe(201);
    const loop = await send("POST", "/api/mounts", {
      ...base,
      id: "loopok",
      prefix: "loopok",
      enabled: false,
      url: "http://127.0.0.1:9/mcp",
      headers: { Authorization: "Bearer ${secret:REMOTE_TOKEN}" },
    });
    expect(loop.status).toBe(201);
    expect((await send("DELETE", "/api/mounts/user/plainok")).status).toBe(200);
    expect((await send("DELETE", "/api/mounts/user/loopok")).status).toBe(200);
    expect(JSON.parse(readFileSync(file, "utf8")).mounts).toHaveLength(3);

    // Switched on without its secret: listed, not connected, nothing fetched.
    const on = await send("POST", "/api/mounts/user/remote/enable");
    expect(await json(on)).toMatchObject({
      ok: true,
      mount: { id: "user/remote", enabled: true, connected: false },
    });
    for (const path of [
      "/api/mounts/user/nope/enable",
      "/api/mounts/alpha/nope/disable",
      "/api/mounts/Bad_Owner/x1/enable",
    ]) {
      const res = await send("POST", path);
      expect(res.status, path).toBe(404);
      expect(await json(res)).toMatchObject({ error: { code: "UNKNOWN_MOUNT" } });
    }

    for (const id of ["remote", "tooling"]) {
      const res = await send("DELETE", `/api/mounts/user/${id}`);
      expect(await json(res)).toEqual({ ok: true, removed: `user/${id}` });
    }
    expect((await send("DELETE", "/api/mounts/user/remote")).status).toBe(404);
    expect((await send("DELETE", "/api/mounts/user/Bad_ID")).status).toBe(404);
    // Only user mounts can be removed: there is no such route for a pack's.
    expect((await send("DELETE", "/api/mounts/alpha/remote")).status).toBe(404);
    expect(JSON.parse(readFileSync(file, "utf8")).mounts.map((m: any) => m.id)).toEqual([
      "upstream",
    ]);
  });

  it("no MCP tool adds a mount, stores a secret or enables a pack", async () => {
    const names: string[] = (await json(await get("/api/tools"))).tools.map((t: any) => t.name);
    const core = (await json(await get("/api/tools"))).tools
      .filter((t: any) => t.pack === "core")
      .map((t: any) => t.name)
      .sort();
    expect(core).toEqual([
      "batch_run",
      "gateway_status",
      "get_job_status",
      "import_artifact",
      "list_artifacts",
      "usage_report",
    ]);
    // The system pack installs software into tools/ (a gated, large or
    // package-manager install waits for the user's approval on the dashboard)
    // and manages mounts (add_mount always waits for the user's approval);
    // nothing else installs, deletes or removes.
    const system = new Set([
      "list_installable",
      "install_software",
      "uninstall_software",
      "list_mounts",
      "add_mount",
      "enable_mount",
      "disable_mount",
      "connect_mount",
      "remove_mount",
      "optimize_mounts",
    ]);
    expect(
      names.filter(
        (n) => !system.has(n) && /mount|secret|enable_pack|install|delete|remove/.test(n),
      ),
    ).toEqual([]);
    // gateway_status reports mounts and secrets by name; it changes nothing and shows no value.
    const status = await callTool("gateway_status");
    expect(await status.text()).not.toContain(TOKEN_VALUE);
  });

  it("artifacts: the library with signed download links", async () => {
    const saved = await json(await callTool("alpha_save"));
    const ref = saved.result.artifact;
    expect(ref.url).toMatch(/\/artifacts\/[^?]+\?exp=\d+&sig=/);

    const listed = await json(await get("/api/artifacts?kind=data&limit=5"));
    expect(listed).toMatchObject({ ok: true, limit: 5, offset: 0 });
    expect(listed.total).toBeGreaterThanOrEqual(1);
    const row = listed.artifacts.find((a: any) => a.id === ref.id);
    expect(row).toMatchObject({ kind: "data", mime: "text/plain" });
    // L4: a file name, never where the library lives.
    expect(row.path).toBeUndefined();
    expect(row.name).toMatch(/^[\w.-]+$/);
    expect(JSON.stringify(listed)).not.toContain(h.home);
    // The link works on its own; the bare path needs the key.
    const download = await fetch(row.url);
    expect(download.status).toBe(200);
    expect(await download.text()).toBe("saved by alpha");
    expect((await fetch(`${h.base}/artifacts/${ref.id}`)).status).toBe(401);
    expect((await json(await get("/api/artifacts?kind=image"))).artifacts).toEqual([]);

    for (const query of [
      "kind=nope",
      "limit=0",
      "limit=201",
      "limit=abc",
      "offset=-1",
      "surprise=1",
    ]) {
      const res = await get(`/api/artifacts?${query}`);
      expect(res.status, query).toBe(400);
      expect(await json(res)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
  });

  it("artifacts: DELETE removes the row and the file; a job that made it still reads", async () => {
    // Made by a background job, so a job result refers to it.
    const queued = await callTool("alpha_save", { background: true });
    expect(queued.status).toBe(202);
    const { job_id: jobId } = await json(queued);
    let job: any;
    for (const deadline = Date.now() + 5000; Date.now() < deadline; ) {
      job = (await json(await get(`/api/jobs/${jobId}`))).job;
      if (job.status === "succeeded") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(job.status).toBe("succeeded");
    const ref = job.result.artifact;
    expect(ref.id).toMatch(/^dat_/);
    const files = (await json(await get("/api/artifacts?kind=data&limit=200"))).artifacts;
    const row = files.find((a: any) => a.id === ref.id);
    expect(row).toBeDefined();
    expect((await fetch(row.url)).status).toBe(200);

    const removed = await send("DELETE", `/api/artifacts/${ref.id}`);
    expect(removed.status).toBe(200);
    expect(await json(removed)).toEqual({ ok: true, id: ref.id, file_removed: true });
    expect(
      h.logs.some((l: any) => l.msg === "artifact deleted" && l.obj?.artifact === ref.id),
    ).toBe(true);
    const after = (await json(await get("/api/artifacts?kind=data&limit=200"))).artifacts;
    expect(after.map((a: any) => a.id)).not.toContain(ref.id);
    expect((await fetch(row.url)).status).toBe(404);
    // Unknown now: a second delete is a 404, not an error.
    const again = await send("DELETE", `/api/artifacts/${ref.id}`);
    expect(again.status).toBe(404);
    expect(await json(again)).toMatchObject({ ok: false, error: { code: "UNKNOWN_ARTIFACT" } });
    // The job that made it still reads, and its link now just 404s.
    const still = await get(`/api/jobs/${jobId}`);
    expect(still.status).toBe(200);
    expect((await json(still)).job.result.artifact.id).toBe(ref.id);
    // list_artifacts keeps working.
    expect((await callTool("list_artifacts", { arguments: {} })).status).toBe(200);

    // Only ids this library could have issued; nothing path-like reaches it.
    for (const id of [
      "nope",
      "img_short",
      "xyz_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "dat_01arz3ndektsv4rrffq69g5fav",
      "dat_01ARZ3NDEKTSV4RRFFQ69G5FAVX",
      "..%2F..%2Fetc%2Fpasswd",
      "dat_01ARZ3NDEKTSV4RRFFQ69G5FA%2F",
      "x".repeat(300),
    ]) {
      const res = await send("DELETE", `/api/artifacts/${id}`);
      expect([400, 404], id).toContain(res.status);
      if (res.status === 400) {
        expect(await json(res)).toMatchObject({
          ok: false,
          error: { code: "INVALID_ARTIFACT_ID" },
        });
      }
    }
    expect((await send("DELETE", "/api/artifacts/nope")).status).toBe(400);
    expect((await send("DELETE", "/api/artifacts/dat_01ARZ3NDEKTSV4RRFFQ69G5FAV")).status).toBe(
      404,
    );
  });

  it("jobs and events: queue, watch, read, cancel", async () => {
    const abort = new AbortController();
    const stream = await fetch(`${h.base}/api/events`, {
      headers: apiHeaders(),
      signal: abort.signal,
    });
    expect(stream.status).toBe(200);
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let seen = "";
    const until = async (needle: RegExp) => {
      const deadline = Date.now() + 5000;
      while (!needle.test(seen)) {
        if (Date.now() > deadline) throw new Error(`event stream never matched ${needle}`);
        const { value, done } = await reader.read();
        if (done) throw new Error("event stream ended");
        seen += decoder.decode(value, { stream: true });
      }
    };
    await until(/event: hello/);

    const queued = await callTool("alpha_slow", {
      arguments: { marker: "argument-that-stays-private" },
    });
    expect(queued.status).toBe(202);
    const { job_id: jobId } = await json(queued);
    expect(jobId).toEqual(expect.any(String));
    await until(new RegExp(`event: job\\ndata: [^\\n]*${jobId}`));
    expect(seen).not.toContain("argument-that-stays-private");

    const one = await get(`/api/jobs/${jobId}`);
    const oneText = await one.text();
    expect(JSON.parse(oneText)).toMatchObject({
      ok: true,
      job: { job_id: jobId, tool: "alpha_slow" },
    });
    expect(oneText).not.toContain("argument-that-stays-private");
    const listed = await get("/api/jobs?limit=10");
    const listedText = await listed.text();
    expect(JSON.parse(listedText).jobs.map((j: any) => j.job_id)).toContain(jobId);
    expect(JSON.parse(listedText).counts).toEqual(expect.any(Object));
    expect(listedText).not.toContain("argument-that-stays-private");

    const cancelled = await send("POST", `/api/jobs/${jobId}/cancel`);
    expect(cancelled.status).toBe(200);
    await until(/"status":"cancelled"/);
    const again = await send("POST", `/api/jobs/${jobId}/cancel`);
    expect(again.status).toBe(409);
    expect(await json(again)).toMatchObject({ error: { code: "JOB_FINISHED" } });
    expect(
      (await json(await get("/api/jobs?status=cancelled"))).jobs.map((j: any) => j.job_id),
    ).toContain(jobId);

    for (const id of ["job_unknown", "..%2F..%2Fjobs", "x".repeat(200)]) {
      expect((await get(`/api/jobs/${id}`)).status, id).toBe(404);
      expect((await send("POST", `/api/jobs/${id}/cancel`)).status, id).toBe(404);
    }
    for (const query of ["status=nope", "limit=0", "limit=1000", "offset=x", "surprise=1"]) {
      expect((await get(`/api/jobs?${query}`)).status, query).toBe(400);
    }
    // A background call of an ordinary tool is queued too.
    const background = await callTool("alpha_echo", { arguments: { n: 1 }, background: true });
    expect(background.status).toBe(202);

    abort.abort();
    await reader.cancel().catch(() => undefined);
  });

  it("usage: calls and cost by pack, tool and provider", async () => {
    const usage = await json(await get("/api/usage"));
    expect(usage).toMatchObject({ ok: true, since: null });
    expect(usage.summary).toEqual(expect.any(Object));
    expect(Array.isArray(usage.by_provider_day)).toBe(true);
    expect(JSON.stringify(usage)).toContain("alpha_echo");
    expect(JSON.stringify(usage)).not.toContain(SECRET_VALUE);

    const future = await json(await get("/api/usage?since=2999-01-01"));
    expect(future.since).toBe("2999-01-01");
    expect(JSON.stringify(future)).not.toContain("alpha_echo");
    for (const query of [
      "since=yesterday",
      "since=2999-99-99",
      "limit=0",
      "limit=5000",
      "surprise=1",
    ]) {
      const res = await get(`/api/usage?${query}`);
      expect(res.status, query).toBe(400);
      expect(await json(res)).toMatchObject({ ok: false, error: { code: "INVALID_REQUEST" } });
    }
  });

  it("errors are JSON without stacks or local paths", async () => {
    const res = await get("/api/nope");
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/json");
    const failed = await callTool("alpha_fail");
    const text = await failed.text();
    expect(text).not.toContain(h.dir);
    expect(text).not.toMatch(/\n\s+at /);
  });
});
