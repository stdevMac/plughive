// MCP resources (library artifacts) and prompts (workflows), scoped by profile.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  MAX_RESOURCE_BYTES,
  RESOURCE_PAGE_SIZE,
  artifactIdOf,
  getPrompt,
  listPrompts,
  listResources,
  readResource,
} from "../../../src/core/mcp/resources.js";
import { buildMcpServer } from "../../../src/core/mcp/server.js";
import { type Profile, ProfileSchema, resolveExposure } from "../../../src/core/profiles.js";
import { ToolRegistry, toolInputJsonSchema } from "../../../src/core/tools/registry.js";
import { Library } from "../../../src/lib/library.js";
import { mockTool } from "../../http/harness.js";
import { canSymlink, itSymlink } from "../../support/platform.js";

function workflowTool() {
  const input = z.object({
    topic: z.string().describe("What the film is about"),
    shots: z.number().int().optional(),
    dry_run: z.boolean().optional(),
  });
  return mockTool("wf_demo", async () => ({ ran: true }), {
    packId: "workflows",
    origin: "workflow",
    longRunning: true,
    description: "Make a demo film.\n\nWorkflow (runs as a job).",
    annotations: { title: "Demo film" },
    input,
    inputSchema: toolInputJsonSchema(input),
  });
}

function setup(home: string) {
  const library = new Library({ root: home, baseUrl: "http://127.0.0.1:7777" });
  const registry = new ToolRegistry();
  registry.registerPack("core", [mockTool("list_artifacts", async () => [])]);
  registry.registerPack("workflows", [workflowTool()]);
  registry.registerPack("demo", [mockTool("echo", async (i) => i)]);
  const profiles: Record<string, Profile> = {
    default: ProfileSchema.parse({ id: "default", name: "Default", mode: "list" }),
    narrow: ProfileSchema.parse({
      id: "narrow",
      name: "Narrow",
      mode: "list",
      include: ["pack:demo"],
    }),
  };
  return { library, registry, profiles };
}

async function connect(
  env: ReturnType<typeof setup>,
  profileId: string,
  extra: Record<string, unknown> = {},
) {
  const server = buildMcpServer(
    {
      registry: env.registry,
      profile: (id) => env.profiles[id],
      library: env.library,
      ...extra,
    },
    "legacy",
    { profileId },
  );
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "t", version: "1" });
  await client.connect(b);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mcp-res-"));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("resources", () => {
  it("lists and reads library artifacts as artifact:// (text and blob)", async () => {
    const env = setup(home);
    const doc = env.library.save({
      kind: "document",
      mime: "text/markdown",
      bytes: Buffer.from("# hi"),
      tool: "t",
    });
    const img = env.library.save({
      kind: "image",
      mime: "image/png",
      bytes: Buffer.from([1, 2, 3]),
      tool: "t",
    });
    const { client, close } = await connect(env, "default");
    try {
      expect(client.getServerCapabilities()).toHaveProperty("resources");
      const list = await client.listResources();
      expect(list.resources.map((r) => r.uri).sort()).toEqual(
        [`artifact://${doc.id}`, `artifact://${img.id}`].sort(),
      );
      const text = await client.readResource({ uri: `artifact://${doc.id}` });
      expect(text.contents[0]).toMatchObject({ mimeType: "text/markdown", text: "# hi" });
      const blob = await client.readResource({ uri: `artifact://${img.id}` });
      expect(blob.contents[0]).toMatchObject({
        mimeType: "image/png",
        blob: Buffer.from([1, 2, 3]).toString("base64"),
      });
      const templates = await client.listResourceTemplates();
      expect(templates.resourceTemplates[0]?.uriTemplate).toBe("artifact://{id}");
      // Paths never leave the daemon.
      expect(JSON.stringify(list)).not.toContain(home);
    } finally {
      await close();
      env.library.close();
    }
  });

  it("redacts stored secret values in resources/read, like tool results", async () => {
    const env = setup(home);
    const SECRET = "super-secret-value-12345";
    const doc = env.library.save({
      kind: "document",
      mime: "text/plain",
      bytes: Buffer.from(`the key is ${SECRET}`),
      tool: "t",
    });
    const bin = env.library.save({
      kind: "data",
      mime: "application/octet-stream",
      bytes: Buffer.from(SECRET),
      tool: "t",
    });
    const b64 = Buffer.from(SECRET).toString("base64");
    // A valid base64 replacement, so the SDK still accepts the blob field.
    const redactedB64 = Buffer.from("REDACTED").toString("base64");
    const redact = (s: string) => s.split(SECRET).join("[redacted]").split(b64).join(redactedB64);
    const { client, close } = await connect(env, "default", { redact });
    try {
      const text = await client.readResource({ uri: `artifact://${doc.id}` });
      expect(text.contents[0]).toMatchObject({ text: "the key is [redacted]" });
      expect(JSON.stringify(text)).not.toContain(SECRET);
      const blob = await client.readResource({ uri: `artifact://${bin.id}` });
      expect(JSON.stringify(blob)).not.toContain(SECRET);
      expect(JSON.stringify(blob)).not.toContain(b64);
      expect(blob.contents[0]).toMatchObject({ blob: redactedB64 });
    } finally {
      await close();
      env.library.close();
    }
  });

  // R2-L1: the artifact prompt shown in resources/list is redacted too, before it is cut.
  it("redacts stored secret values in the prompts resources/list shows", async () => {
    const env = setup(home);
    const SECRET = "super-secret-value-12345";
    const pad = "p".repeat(150);
    env.library.save({
      kind: "image",
      mime: "image/png",
      bytes: Buffer.from([1]),
      tool: "t",
      prompt: `use the key ${SECRET} please`,
    });
    env.library.save({
      kind: "image",
      mime: "image/png",
      bytes: Buffer.from([2]),
      tool: "t",
      prompt: `${pad}${SECRET}`,
    });
    const redact = (s: string) => s.split(SECRET).join("[redacted]");
    const { client, close } = await connect(env, "default", { redact });
    try {
      const list = JSON.stringify(await client.listResources());
      expect(list).toContain("use the key [redacted] please");
      expect(list).not.toContain(SECRET.slice(0, 8));
    } finally {
      await close();
      env.library.close();
    }
  });

  it("is empty for a profile that does not expose list_artifacts, and refuses reads", async () => {
    const env = setup(home);
    const doc = env.library.save({
      kind: "data",
      mime: "application/json",
      bytes: Buffer.from("{}"),
      tool: "t",
    });
    const { client, close } = await connect(env, "narrow");
    try {
      expect((await client.listResources()).resources).toEqual([]);
      await expect(client.readResource({ uri: `artifact://${doc.id}` })).rejects.toThrow();
    } finally {
      await close();
      env.library.close();
    }
  });

  itSymlink("refuses ids that are not in the library and files outside it", () => {
    const env = setup(home);
    const outside = join(home, "secret.txt");
    writeFileSync(outside, "do not read");
    const fake = {
      rootValue: home,
      get: (id: string) =>
        id === "doc_evil" ? { id, mime: "text/plain", path: outside, bytes: 11 } : null,
      list: () => [],
    };
    expect(() => readResource(fake, "artifact://doc_evil")).toThrow(/not found/i);
    expect(() => readResource(env.library, "artifact://doc_01ARZ3NDEKTSV4RRFFQ69G5FAV")).toThrow(
      /not found/i,
    );
    expect(() => readResource(env.library, "artifact://../../etc/passwd")).toThrow(/not found/i);
    expect(() => readResource(env.library, "file:///etc/passwd")).toThrow(/not found/i);
    expect(artifactIdOf("artifact://a/b")).toBeNull();
    env.library.close();
  });

  it.skipIf(!canSymlink())(
    "refuses an artifact row whose file is a symlink out of the library",
    () => {
      const env = setup(home);
      const ref = env.library.save({
        kind: "document",
        mime: "text/plain",
        bytes: Buffer.from("ok"),
        tool: "t",
      });
      const outside = join(home, "outside.txt");
      writeFileSync(outside, "secret");
      rmSync(ref.path);
      symlinkSync(outside, ref.path);
      expect(() => readResource(env.library, `artifact://${ref.id}`)).toThrow(/not found/i);
      env.library.close();
    },
  );

  it("pages with an opaque cursor and rejects a forged one", () => {
    const rows = Array.from({ length: RESOURCE_PAGE_SIZE + 3 }, (_, i) => ({
      id: `doc_${i}`,
      mime: "text/plain",
      path: "/x",
      bytes: 1,
    }));
    const lib = {
      rootValue: home,
      get: () => null,
      list: (_f: unknown, limit: number, offset: number) => rows.slice(offset, offset + limit),
    };
    const first = listResources(lib, undefined);
    expect(first.resources).toHaveLength(RESOURCE_PAGE_SIZE);
    expect(first.nextCursor).toBeTypeOf("string");
    const second = listResources(lib, first.nextCursor);
    expect(second.resources).toHaveLength(3);
    expect(second.nextCursor).toBeUndefined();
    expect(() => listResources(lib, "bm9wZQ")).toThrow(/cursor/);
  });

  it("refuses a file over the size limit", () => {
    const lib = {
      rootValue: home,
      get: (id: string) => ({
        id,
        mime: "text/plain",
        path: join(home, "artifacts", "big.txt"),
        bytes: 0,
      }),
      list: () => [],
    };
    const env = setup(home);
    writeFileSync(join(home, "artifacts", "big.txt"), Buffer.alloc(MAX_RESOURCE_BYTES + 1));
    expect(() => readResource(lib, "artifact://doc_big")).toThrow(/limit/);
    env.library.close();
  });
});

describe("prompts", () => {
  it("lists workflows as prompts with their arguments, scoped by profile", async () => {
    const env = setup(home);
    const { client, close } = await connect(env, "default");
    try {
      const { prompts } = await client.listPrompts();
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toMatchObject({
        name: "wf_demo",
        title: "Demo film",
        description: "Make a demo film.",
      });
      expect(prompts[0]?.arguments).toEqual([
        { name: "topic", description: "What the film is about", required: true },
        { name: "shots", description: "(integer, as JSON)" },
      ]);
      const got = await client.getPrompt({
        name: "wf_demo",
        arguments: { topic: "cats", shots: "3" },
      });
      const text = (got.messages[0]?.content as { text: string }).text;
      expect(text).toContain("wf_demo");
      expect(text).toContain('"dry_run": true');
      expect(text).toContain('"shots": 3');
      await expect(client.getPrompt({ name: "wf_demo", arguments: {} })).rejects.toThrow(/topic/);
    } finally {
      await close();
    }
    const narrow = await connect(env, "narrow");
    try {
      expect((await narrow.client.listPrompts()).prompts).toEqual([]);
      await expect(
        narrow.client.getPrompt({ name: "wf_demo", arguments: { topic: "x" } }),
      ).rejects.toThrow(/unknown prompt/);
    } finally {
      await narrow.close();
      env.library.close();
    }
  });

  it("pure helpers agree with the exposure", () => {
    const env = setup(home);
    const exposure = resolveExposure(env.profiles.default as Profile, env.registry);
    expect(listPrompts(exposure).prompts.map((p) => p.name)).toEqual(["wf_demo"]);
    expect(() => getPrompt(exposure, "wf_demo", { topic: "x", nope: "1" })).toThrow(
      /unknown argument/,
    );
    env.library.close();
  });
});
