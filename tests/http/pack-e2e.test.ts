// End to end through the public paths only: the real app on an ephemeral
// loopback port with a temp home, the media pack (copied from packs/media) and
// a small provider pack loaded from a temp packs directory, the provider's API
// played by a local HTTP server, and the official MCP client over Streamable
// HTTP. Covers list mode and search mode, search -> describe -> execute, the
// artifact a tool hands back, and a long-running tool both as a task and
// through the wait_for_job fallback.
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type FullHarness, apiHeaders, bootFull } from "./full-harness.js";
import { TASK_CAPS, legacyClient, modernClient, rawModern, toolJson, until } from "./harness.js";

const KEY = "pack-e2e-access-key-0123456789ab";
const PROVIDER_KEY = "fixture-pixel-provider-key-24680";
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
const MP3 = Buffer.concat([Buffer.from("ID3"), Buffer.alloc(32, 7)]);
const MEDIA_DIR = fileURLToPath(new URL("../../packs/media", import.meta.url));
const AUTH = { authorization: `Bearer ${KEY}` };

// The provider pack: two capability providers that call the mocked API with
// the pack's stored key and save what comes back to the library.
const PIXEL = `export default (api) => {
  const call = async (ctx, path, body) => {
    const key = await ctx.secrets.get("PIXEL_API_KEY");
    const res = await ctx.fetch(ctx.settings.base_url + path, {
      method: "POST",
      headers: { authorization: "Bearer " + key, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error("pixel api answered " + res.status);
    return new Uint8Array(await res.arrayBuffer());
  };
  const provider = (capability, path, kind, mime, model) =>
    api.defineProvider({
      capability,
      id: "pixel",
      priority: 50,
      setupHint: "Store PIXEL_API_KEY",
      isConfigured: async (ctx) => (await ctx.secrets.get("PIXEL_API_KEY").catch(() => null)) != null,
      models: () => [model],
      run: async (input, ctx) => {
        const bytes = await call(ctx, path, input);
        const ref = await ctx.library.save({ kind, mime, bytes, model, prompt: input.prompt ?? input.text });
        return {
          artifacts: [{ id: ref.id, url: ref.url, mime: ref.mime }],
          model,
          provider: "pixel",
          cost_usd: 0.02,
          cost_estimated: true,
        };
      },
    });
  return api.definePack({
    providers: [
      provider("image.generate", "/v1/images", "image", "image/png", "pixel-image-1"),
      provider("speech.generate", "/v1/speech", "audio", "audio/mpeg", "pixel-voice-1"),
    ],
    tools: [],
  });
};
`;

describe("packs end to end over MCP", () => {
  let h: FullHarness;
  let mock: Server;
  const seen: Array<{ path: string; auth: string | undefined; body: Record<string, unknown> }> = [];

  const client = (
    era: "modern" | "legacy",
    path = "/mcp",
    capabilities?: Record<string, unknown>,
  ) =>
    (era === "legacy" ? legacyClient : modernClient)(h.base, {
      path,
      headers: AUTH,
      ...(capabilities ? { capabilities } : {}),
    });

  beforeAll(async () => {
    mock = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
        seen.push({ path: req.url ?? "", auth: req.headers.authorization, body });
        if (req.headers.authorization !== `Bearer ${PROVIDER_KEY}`) {
          res.writeHead(401).end();
          return;
        }
        const image = req.url === "/v1/images";
        setTimeout(
          () =>
            res
              .writeHead(200, { "content-type": image ? "image/png" : "audio/mpeg" })
              .end(image ? PNG : MP3),
          image ? 150 : 0,
        );
      });
    });
    await new Promise<void>((resolve) => mock.listen(0, "127.0.0.1", resolve));
    const address = mock.address();
    if (!address || typeof address === "string") throw new Error("no mock address");
    const mockPort = address.port;

    let builtinDir = "";
    h = await bootFull({
      accessKey: KEY,
      get builtinDir() {
        return builtinDir;
      },
      seed: (home) => {
        builtinDir = join(home, "..", "builtin");
        mkdirSync(join(builtinDir, "pixel"), { recursive: true });
        cpSync(MEDIA_DIR, join(builtinDir, "media"), { recursive: true });
        writeFileSync(
          join(builtinDir, "pixel", "pack.json"),
          JSON.stringify({
            id: "pixel",
            name: "Pixel",
            version: "0.1.0",
            apiVersion: 1,
            entry: "./index.mjs",
            secrets: [{ name: "PIXEL_API_KEY", label: "Pixel key", required: false }],
            settings: { type: "object", properties: { base_url: { type: "string" } } },
            permissions: { library: "write", localNetwork: [`127.0.0.1:${mockPort}`] },
          }),
        );
        writeFileSync(join(builtinDir, "pixel", "index.mjs"), PIXEL);
      },
    });
    const headers = apiHeaders();
    const put = async (path: string, body: unknown) => {
      const res = await fetch(`${h.base}${path}`, {
        method: "PUT",
        headers,
        body: JSON.stringify(body),
      });
      expect(res.status, path).toBeLessThan(300);
    };
    await put("/api/secrets/pixel/PIXEL_API_KEY", { value: PROVIDER_KEY });
    await put("/api/packs/pixel/settings", {
      values: { base_url: `http://127.0.0.1:${mockPort}` },
    });
    await put("/api/profiles/finder", { name: "Finder", mode: "search" });
    await put("/api/profiles/lister", { name: "Lister", mode: "list" });
  });

  afterAll(async () => {
    await h?.close();
    mock?.closeAllConnections();
    await new Promise((resolve) => mock.close(resolve));
  });

  it.each([["modern"], ["legacy"]] as const)(
    "list mode lists the pack and core tools (%s client)",
    async (era) => {
      const c = await client(era, "/p/lister/mcp");
      try {
        const names = (await c.listTools()).tools.map((t) => t.name);
        expect(names).toEqual(
          expect.arrayContaining([
            "generate_image",
            "generate_speech",
            "list_media_providers",
            "list_artifacts",
            "get_job_status",
            "usage_report",
            "gateway_status",
            "wait_for_job",
            "cancel_job",
          ]),
        );
        expect(names).not.toContain("search_tools");
        // Importing is off without an import root and nothing manages secrets.
        // Mounts are managed only by the system pack's tools, and add_mount
        // writes only after the user approves it (tests/core/tools/mount-tools.test.ts).
        expect(names.filter((n) => /secret/.test(n))).toEqual([]);
        expect(names.filter((n) => /mount/.test(n)).sort()).toEqual([
          "add_mount",
          "connect_mount",
          "disable_mount",
          "enable_mount",
          "list_mounts",
          "optimize_mounts",
          "remove_mount",
        ]);
      } finally {
        await c.close();
      }
    },
  );

  it.each([["modern"], ["legacy"]] as const)(
    "search mode: search -> describe -> execute hands back a fetchable artifact (%s client)",
    async (era) => {
      const c = await client(era, "/p/finder/mcp");
      try {
        const listed = (await c.listTools()).tools.map((t) => t.name);
        expect(listed.slice(0, 3)).toEqual(["search_tools", "describe_tool", "execute_tool"]);
        expect(listed).not.toContain("generate_speech");

        const found = toolJson(
          await c.callTool({ name: "search_tools", arguments: { query: "generate speech" } }),
        );
        expect(found.ok).toBe(true);
        expect(found.result.tools.map((t: { name: string }) => t.name)).toContain(
          "generate_speech",
        );

        const described = toolJson(
          await c.callTool({ name: "describe_tool", arguments: { name: "generate_speech" } }),
        );
        expect(described.result.tools[0]).toMatchObject({
          name: "generate_speech",
          pack: "media",
          long_running: false,
          inputSchema: { type: "object", required: ["text"] },
        });

        const before = seen.length;
        const ran = toolJson(
          await c.callTool({
            name: "execute_tool",
            arguments: {
              name: "generate_speech",
              // A fresh call: an earlier test already made this one, and the
              // paid-call cache would answer it without reaching the provider.
              arguments: { text: "hello there", provider: "pixel", cache: false },
            },
          }),
        );
        expect(ran).toMatchObject({
          ok: true,
          result: {
            provider: "pixel",
            model: "pixel-voice-1",
            artifacts: [{ mime: "audio/mpeg" }],
          },
        });
        // The provider was reached with the stored key; the key is not in the result.
        expect(seen.slice(before)).toEqual([
          {
            path: "/v1/speech",
            auth: `Bearer ${PROVIDER_KEY}`,
            body: expect.objectContaining({ text: "hello there" }),
          },
        ]);
        expect(JSON.stringify(ran)).not.toContain(PROVIDER_KEY);

        const artifact = ran.result.artifacts[0] as { id: string; url: string };
        expect(artifact.url.startsWith(`${h.base}/artifacts/${artifact.id}?`)).toBe(true);
        const file = await fetch(artifact.url);
        expect(file.status).toBe(200);
        expect(file.headers.get("content-type")).toContain("audio/mpeg");
        expect(Buffer.from(await file.arrayBuffer()).equals(MP3)).toBe(true);
        // The bare path needs the access key.
        expect((await fetch(`${h.base}/artifacts/${artifact.id}`)).status).toBe(401);
        expect((await fetch(`${h.base}/artifacts/${artifact.id}`, { headers: AUTH })).status).toBe(
          200,
        );

        // Bad arguments are refused by the pack tool's own schema.
        const bad = await c
          .callTool({
            name: "execute_tool",
            arguments: { name: "generate_speech", arguments: { text: "" } },
          })
          .catch((e: unknown) => e);
        expect(String((bad as Error).message)).toContain("invalid arguments for generate_speech");
      } finally {
        await c.close();
      }
    },
  );

  it("a long-running tool runs as a task for a client that declares the tasks extension", async () => {
    const created = await rawModern(
      h.base,
      "tools/call",
      { name: "generate_image", arguments: { prompt: "a red square" } },
      { capabilities: TASK_CAPS, headers: AUTH },
    );
    expect(created.status).toBe(200);
    expect(created.result).toMatchObject({ resultType: "task", status: "working" });
    const taskId: string = created.result?.taskId;
    const done = await until(async () => {
      const reply = await rawModern(
        h.base,
        "tasks/get",
        { taskId },
        { capabilities: TASK_CAPS, headers: AUTH },
      );
      return reply.result?.status === "completed" ? reply.result : undefined;
    }, 10_000);
    const payload = JSON.parse(done.result.content[0].text);
    expect(payload).toMatchObject({
      ok: true,
      result: { provider: "pixel", model: "pixel-image-1", artifacts: [{ mime: "image/png" }] },
    });
    const file = await fetch(payload.result.artifacts[0].url);
    expect(file.status).toBe(200);
    expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);
    expect(JSON.stringify(done)).not.toContain(PROVIDER_KEY);
  });

  it.each([["modern"], ["legacy"]] as const)(
    "a long-running tool falls back to a job and wait_for_job (%s client)",
    async (era) => {
      const c = await client(era);
      try {
        const started = toolJson(
          await c.callTool({
            name: "generate_image",
            arguments: { prompt: "a blue circle", aspect_ratio: "1:1" },
          }),
        );
        expect(started).toMatchObject({
          ok: true,
          result: {
            job_id: expect.any(String),
            wait_with: "wait_for_job",
            cancel_with: "cancel_job",
          },
        });
        const jobId: string = started.result.job_id;
        const waited = await until(async () => {
          const reply = toolJson(
            await c.callTool({ name: "wait_for_job", arguments: { job_id: jobId, timeout_s: 5 } }),
          );
          return reply.result?.done ? reply : undefined;
        }, 15_000);
        expect(waited.result).toMatchObject({
          job_id: jobId,
          status: "succeeded",
          done: true,
          result: { provider: "pixel", artifacts: [{ mime: "image/png" }] },
        });
        const artifact = waited.result.result.artifacts[0] as { id: string; url: string };
        const file = await fetch(artifact.url);
        expect(file.status).toBe(200);
        expect(Buffer.from(await file.arrayBuffer()).equals(PNG)).toBe(true);

        const status = toolJson(
          await c.callTool({ name: "get_job_status", arguments: { job_id: jobId } }),
        );
        expect(status.result).toMatchObject({
          job_id: jobId,
          tool: "generate_image",
          status: "succeeded",
        });
        expect(JSON.stringify(status)).not.toContain("a blue circle");

        const listedArtifacts = toolJson(
          await c.callTool({ name: "list_artifacts", arguments: { limit: 50 } }),
        );
        expect(listedArtifacts.result.artifacts.map((a: { id: string }) => a.id)).toContain(
          artifact.id,
        );
      } finally {
        await c.close();
      }
    },
  );

  it("the metered calls are in the usage ledger and no key is in the logs", async () => {
    const report = (await (
      await fetch(`${h.base}/api/usage`, { headers: apiHeaders() })
    ).json()) as { ok: boolean };
    expect(report.ok).toBe(true);
    const text = JSON.stringify(report);
    expect(text).toContain("generate_speech");
    expect(text).toContain("generate_image");
    expect(JSON.stringify(h.logs)).not.toContain(PROVIDER_KEY);
    expect(text).not.toContain(PROVIDER_KEY);
  });
});
