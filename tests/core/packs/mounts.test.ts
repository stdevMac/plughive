import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityRouter } from "../../../src/core/capabilities/router.js";
import type { PackHost } from "../../../src/core/packs/context.js";
import { PackLoader } from "../../../src/core/packs/loader.js";
import { ManifestError, parseManifest } from "../../../src/core/packs/manifest.js";
import {
  MOUNT_MAX_DESCRIPTION,
  MOUNT_MAX_TOOLS,
  combineMountSources,
  confinedFetch,
  sanitizeUpstreamTools,
} from "../../../src/core/packs/mounts.js";
import { createSecretStore } from "../../../src/core/secrets/index.js";
import { ToolRegistry } from "../../../src/core/tools/registry.js";

const silent = { debug() {}, info() {}, warn() {}, error() {} };
const base = { id: "demo", name: "Demo", version: "0.1.0", apiVersion: 1 };

function issuesOf(raw: unknown): string[] {
  try {
    parseManifest(raw);
  } catch (e) {
    expect(e).toBeInstanceOf(ManifestError);
    return (e as ManifestError).issues;
  }
  throw new Error("expected the manifest to be rejected");
}

describe("mount declarations (manifest)", () => {
  const mount = {
    id: "svc",
    name: "Svc",
    transport: "http",
    url: "https://mcp.example.com/mcp",
    prefix: "svc",
    auth: "header",
  };

  it("M7: a ${secret:} reference must name a secret the pack declares", () => {
    const issues = issuesOf({
      ...base,
      secrets: [{ name: "OWN_KEY" }],
      mounts: [{ ...mount, headers: { Authorization: "Bearer ${secret:OTHER_KEY}" } }],
    });
    expect(issues.join("\n")).toMatch(/OTHER_KEY/);
    const inUrl = issuesOf({
      ...base,
      mounts: [{ ...mount, auth: "query", url: "https://mcp.example.com/mcp?k=${secret:NOPE}" }],
    });
    expect(inUrl.join("\n")).toMatch(/NOPE/);
    // Declared: accepted.
    const ok = parseManifest({
      ...base,
      secrets: [{ name: "OWN_KEY" }],
      mounts: [{ ...mount, headers: { Authorization: "Bearer ${secret:OWN_KEY}" } }],
    });
    expect(ok.mounts[0]?.headers).toEqual({ Authorization: "Bearer ${secret:OWN_KEY}" });
  });

  it("refuses CR, LF or NUL in a mount header", () => {
    for (const headers of [
      { "X-Key": "a\r\nX-Injected: 1" },
      { "X-Key": "a\nb" },
      { "X-Key": "a\0b" },
      { "X-Key\r\nX-Injected": "1" },
    ]) {
      expect(issuesOf({ ...base, mounts: [{ ...mount, headers }] }).join("\n")).toMatch(/headers/);
    }
  });

  it("refuses an OAuth-only mount that is on by default", () => {
    const issues = issuesOf({
      ...base,
      mounts: [{ ...mount, auth: "oauth", enabledByDefault: true }],
    });
    expect(issues.length).toBeGreaterThan(0);
  });

  it("needs no entry when a pack only declares mounts", () => {
    const m = parseManifest({ ...base, mounts: [mount] });
    expect(m.entry).toBeUndefined();
    expect(m.mounts[0]?.enabledByDefault).toBe(false);
  });
});

describe("built-in media and mounts packs", () => {
  let tmp: string;
  let home: string;
  let userDir: string;
  let registry: ToolRegistry;
  let host: PackHost;
  let capabilities: CapabilityRouter;

  const makeLoader = (extra: Partial<ConstructorParameters<typeof PackLoader>[0]> = {}) =>
    new PackLoader({ home, registry, host, userDir, capabilities, ...extra });

  beforeEach(() => {
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "plughive-mounts-")));
    home = join(tmp, "home");
    userDir = join(home, "packs");
    mkdirSync(userDir, { recursive: true });
    registry = new ToolRegistry();
    host = {
      store: createSecretStore({
        home,
        env: {
          EXA_API_KEY: "fixture-exa",
          BROWSERBASE_API_KEY: "a b&c=d",
          OUTSIDE_KEY: "fixture-out",
        },
        backend: "memory",
      }),
      logger: silent,
    };
    capabilities = new CapabilityRouter({ home, logger: silent });
  });

  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it("loads the media pack with its tools and the entry-less mounts pack", async () => {
    const loader = makeLoader();
    await loader.loadAll();
    const packs = await loader.listPacks();
    const media = packs.find((p) => p.id === "media");
    expect(media).toMatchObject({ source: "builtin", state: "loaded" });
    expect([...(media?.tools ?? [])].sort()).toEqual(
      [
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
      ].sort(),
    );
    expect(packs.find((p) => p.id === "mounts")).toMatchObject({
      source: "builtin",
      state: "loaded",
      tools: [],
    });
    expect(registry.get("generate_image")?.packId).toBe("media");
    // Built-in providers registered with the router.
    const ids = new Set((await capabilities.list()).map((r) => r.pack));
    expect(ids.has("gemini")).toBe(true);
    expect(ids.has("elevenlabs")).toBe(true);
    expect(ids.has("local")).toBe(true);
    await loader.close();
  });

  it("lists every mount switched off; OAuth servers are mountable after a sign-in", async () => {
    const loader = makeLoader();
    await loader.loadAll();
    const mounts = (await loader.listMounts()).filter((m) => m.pack === "mounts");
    expect(mounts).toHaveLength(24);
    expect(mounts.every((m) => m.enabled === false)).toBe(true);
    expect(
      mounts.every((m) => typeof m.docsUrl === "string" && m.docsUrl.startsWith("https://")),
    ).toBe(true);
    const oauth = mounts.filter((m) => m.auth === "oauth");
    expect(oauth.map((m) => m.mountId).sort()).toEqual(
      [
        "atlassian",
        "cloudflare",
        "cloudflare-browser",
        "composio",
        "context-dev",
        "linear-oauth",
        "notion",
        "pipedream",
        "sentry",
        "stripe",
        "zapier",
      ].sort(),
    );
    for (const m of oauth) {
      expect(m.mountable).toBe(true);
      expect(m.transport).toBe("http");
      expect(m.url?.startsWith("https://")).toBe(true);
      expect(m.secrets).toEqual([]);
      expect(m.description).toMatch(/Sign in from the dashboard/);
    }
    const exa = mounts.find((m) => m.mountId === "exa");
    expect(exa).toMatchObject({
      mountable: true,
      secrets: [{ name: "EXA_API_KEY", present: true }],
    });
    const firecrawl = mounts.find((m) => m.mountId === "firecrawl");
    expect(firecrawl?.secrets).toEqual([{ name: "FIRECRAWL_API_KEY", present: false }]);
    // Nothing is resolved while everything is off.
    expect(await loader.resolvedMounts()).toEqual([]);
    await loader.close();
  });

  it("setMountEnabled persists and fills only the pack's own secrets", async () => {
    const changed = vi.fn();
    const loader = makeLoader({ onMountsChanged: changed });
    await loader.loadAll();
    await expect(loader.setMountEnabled("mounts/nope", true)).rejects.toThrow(/unknown mount/);
    await loader.setMountEnabled("mounts/exa", true);
    await loader.setMountEnabled("mounts/browserbase", true);
    await loader.setMountEnabled("mounts/firecrawl", true); // secret not set: skipped
    expect(changed).toHaveBeenCalledTimes(3);

    const state = JSON.parse(readFileSync(join(home, "packs.json"), "utf8"));
    expect(state.mounts).toMatchObject({
      "mounts/exa": true,
      "mounts/browserbase": true,
      "mounts/firecrawl": true,
    });
    await loader.close();

    // A fresh loader honours the switches.
    const loader2 = makeLoader({ registry: new ToolRegistry() });
    await loader2.loadAll();
    const resolved = (await loader2.resolvedMounts()).filter((m) => m.pack === "mounts");
    expect(resolved.map((m) => m.id).sort()).toEqual(["mounts/browserbase", "mounts/exa"]);
    const exa = resolved.find((m) => m.id === "mounts/exa");
    expect(exa).toEqual({
      id: "mounts/exa",
      pack: "mounts",
      prefix: "exa",
      url: "https://mcp.exa.ai/mcp",
      headers: { "x-api-key": "fixture-exa" },
    });
    // Query values are URL-encoded.
    const bb = resolved.find((m) => m.id === "mounts/browserbase");
    expect(bb?.url).toBe("https://mcp.browserbase.com/mcp?browserbaseApiKey=a%20b%26c%3Dd");
    // listMounts never carries secret values.
    expect(JSON.stringify(await loader2.listMounts())).not.toContain("fixture-exa");

    await loader2.setMountEnabled("mounts/exa", false);
    expect((await loader2.resolvedMounts()).map((m) => m.id)).toEqual(["mounts/browserbase"]);
    await loader2.close();
  });

  it("a user pack's mount only gets secrets granted to that pack", async () => {
    const dir = join(userDir, "umount");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "pack.json"),
      JSON.stringify({
        ...base,
        id: "umount",
        secrets: [{ name: "EXA_API_KEY" }],
        mounts: [
          {
            id: "uu",
            name: "U",
            transport: "http",
            url: "https://mcp.example.com/mcp",
            headers: { "x-api-key": "${secret:EXA_API_KEY}" },
            prefix: "umine",
            auth: "header",
            enabledByDefault: true,
          },
        ],
      }),
    );
    const loader = makeLoader();
    await loader.loadAll();
    expect((await loader.listPacks()).find((p) => p.id === "umount")).toMatchObject({
      source: "user",
      state: "disabled",
      error: null,
    });
    // A user pack's mount is forced off by default and the pack starts disabled.
    let mine = (await loader.listMounts()).find((m) => m.id === "umount/uu");
    expect(mine).toMatchObject({ enabled: false, mountable: false });

    // Enabled without the grant: the secret is not visible, the mount is skipped.
    await loader.enable("umount", { grants: [] });
    await loader.setMountEnabled("umount/uu", true);
    mine = (await loader.listMounts()).find((m) => m.id === "umount/uu");
    expect(mine?.secrets).toEqual([{ name: "EXA_API_KEY", present: false }]);
    expect((await loader.resolvedMounts()).map((m) => m.id)).not.toContain("umount/uu");

    // With the grant: filled.
    await loader.enable("umount", { grants: ["EXA_API_KEY"] });
    // M1: granted, but a user pack's mount is filled from the store, never the environment.
    expect((await loader.resolvedMounts()).map((m) => m.id)).not.toContain("umount/uu");
    await host.store.set("EXA_API_KEY", "fixture-exa");
    const resolved = (await loader.resolvedMounts()).find((m) => m.id === "umount/uu");
    expect(resolved?.headers).toEqual({ "x-api-key": "fixture-exa" });
    await loader.close();
  });
});

describe("pack mount transport helpers", () => {
  it("confinedFetch refuses another origin and turns off redirects", async () => {
    const base = vi.fn(async (_i: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      return new Response("ok");
    });
    const f = confinedFetch("https://mcp.example.com", base as unknown as typeof fetch);
    await expect(f("https://evil.example.net/mcp")).rejects.toThrow(/another origin/);
    await expect(f("http://mcp.example.com/mcp")).rejects.toThrow(/another origin/);
    expect(base).not.toHaveBeenCalled();
    const res = await f("https://mcp.example.com/mcp", { redirect: "follow" });
    expect(await res.text()).toBe("ok");
  });

  it("confinedFetch refuses an oversized declared response", async () => {
    const base = async () =>
      new Response("x", { headers: { "content-length": String(64 * 1024 * 1024) } });
    const f = confinedFetch("https://mcp.example.com", base as unknown as typeof fetch);
    await expect(f("https://mcp.example.com/mcp")).rejects.toThrow(/too large/);
  });

  it("sanitizeUpstreamTools namespaces, dedupes, drops bad names and caps", () => {
    const mount = { id: "mounts/x", prefix: "x" };
    const out = sanitizeUpstreamTools(mount, [
      { name: "search", description: "d".repeat(MOUNT_MAX_DESCRIPTION + 50) },
      { name: "search" },
      { name: "a__b" },
      { name: "bad name!" },
      { name: 42 },
      { name: "fetch" },
    ]);
    expect(out.map((t) => t.qualifiedName)).toEqual(["x__search", "x__fetch"]);
    expect(out[0]?.description.length).toBe(MOUNT_MAX_DESCRIPTION + 3);
    expect(out[0]).toMatchObject({ mountId: "mounts/x", prefix: "x", upstreamName: "search" });
    // Only boolean behaviour hints are kept from the untrusted annotations.
    const [hinted] = sanitizeUpstreamTools(mount, [
      {
        name: "s",
        annotations: {
          readOnlyHint: true,
          destructiveHint: "no",
          title: "Pwn",
          openWorldHint: false,
        },
      },
    ]);
    expect(hinted?.hints).toEqual({ readOnlyHint: true, openWorldHint: false });
    const many = Array.from({ length: MOUNT_MAX_TOOLS + 10 }, (_, i) => ({ name: `t${i}` }));
    expect(sanitizeUpstreamTools(mount, many)).toHaveLength(MOUNT_MAX_TOOLS);
  });

  // D-M2: an upstream description cannot hide or reorder text with control or bidi characters.
  it("sanitizeUpstreamTools strips control and bidi characters from descriptions", () => {
    const [t] = sanitizeUpstreamTools({ id: "mounts/x", prefix: "x" }, [
      {
        name: "s",
        description:
          "Read\u202e a file\u202c.\u2066x\u2069\u200b\u0007\u001b[2J\u0085\ufeff\nLine two\tok",
      },
    ]);
    expect(t?.description).toBe("Read a file.x[2J\nLine two\tok");
  });

  it("combineMountSources keeps the first of duplicate names and routes calls to the owner", async () => {
    const tool = (mountId: string, q: string) => ({
      qualifiedName: q,
      mountId,
      prefix: q.split("__")[0] as string,
      upstreamName: q.split("__")[1] as string,
      description: "",
    });
    const a = { list: () => [tool("a", "x__one")], call: vi.fn(async () => "from a") };
    const b = {
      list: () => [tool("b", "x__one"), tool("b", "y__two")],
      call: vi.fn(async () => "from b"),
    };
    const all = combineMountSources(a, null, b);
    expect(all.list().map((t) => `${t.mountId}:${t.qualifiedName}`)).toEqual([
      "a:x__one",
      "b:y__two",
    ]);
    expect(await all.call("b", "two", {})).toBe("from b");
    await expect(all.call("zzz", "two", {})).rejects.toThrow(/not connected/);
  });
});
