import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AnyToolDefinition, PackContext } from "plughive/pack";
import {
  type CreateTestContextOptions,
  type TestContext,
  createTestContext,
} from "plughive/pack/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import telegramPack from "../../../packs/telegram/index.js";
import { PackLoader } from "../../../src/core/packs/loader.js";
import { parseManifest } from "../../../src/core/packs/manifest.js";
import { createSecretStore } from "../../../src/core/secrets/index.js";
import { ToolRegistry } from "../../../src/core/tools/registry.js";

const FAKE_TOKEN = "fake-bot-token";
const silent = { debug() {}, info() {}, warn() {}, error() {} };

function sendTelegram(): AnyToolDefinition {
  const tools = telegramPack.tools;
  if (!Array.isArray(tools)) throw new Error("expected a static tool list");
  const tool = tools.find((t) => t.name === "send_telegram");
  if (!tool) throw new Error("send_telegram missing");
  return tool;
}

const packDir = fileURLToPath(new URL("../../../packs/telegram", import.meta.url));
const harnesses: TestContext[] = [];

/**
 * The real scoped context (same permission checks as the daemon); only the
 * network and the secret values are fakes. An image saved by another tool is
 * seeded as "a1": the pack reads it through its declared `library: "read-all"`.
 */
function fakeCtx(opts: {
  fetch: NonNullable<CreateTestContextOptions["fetch"]>;
  settings?: Record<string, unknown>;
}): PackContext {
  const t = createTestContext({
    packDir,
    secrets: { TELEGRAM_BOT_TOKEN: FAKE_TOKEN },
    fetch: opts.fetch,
    ...(opts.settings ? { settings: opts.settings } : {}),
  });
  harnesses.push(t);
  t.library?.seed({
    id: "a1",
    kind: "image",
    mime: "image/png",
    bytes: new Uint8Array([1, 2, 3]),
    tool: "generate_image",
  });
  return t.forTool("send_telegram");
}

/** The user listed chat 42 (most tests send there). */
const ALLOW_42 = { allowedChatIds: ["42"] };

const okResponse = (id: number) =>
  new Response(JSON.stringify({ ok: true, result: { message_id: id, chat: { id: 42 } } }), {
    headers: { "content-type": "application/json" },
  });

describe("telegram pack: send_telegram", () => {
  it("is marked destructive, so ask-before-destructive covers it", () => {
    const ann = sendTelegram().annotations;
    expect(ann?.destructiveHint).toBe(true);
    expect(ann?.readOnlyHint).not.toBe(true);
    expect(ann?.idempotentHint).toBe(false);
  });

  let dir: string | null = null;
  afterEach(async () => {
    for (const t of harnesses.splice(0)) await t.dispose();
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = null;
  });

  it("sends a text message", async () => {
    const fetch = vi.fn(async () => okResponse(7));
    const tool = sendTelegram();
    const input = tool.input.parse({ text: "hello", chat_id: "42", parse_mode: "HTML" });
    const out = await tool.run(input, fakeCtx({ fetch, settings: ALLOW_42 }));
    expect(out).toEqual({ message_id: 7, chat_id: "42" });
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    expect(JSON.parse(String(init.body))).toEqual({
      chat_id: "42",
      text: "hello",
      parse_mode: "HTML",
    });
  });

  it("sends an image artifact as a photo and falls back to the default chat setting", async () => {
    // The upload streams from a materialized copy that is removed once the
    // request finishes, so read the body while the request is in flight.
    let uploaded: number[] = [];
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const file = (init?.body as FormData).get("photo") as File;
      uploaded = [...new Uint8Array(await file.arrayBuffer())];
      return okResponse(8);
    });
    const tool = sendTelegram();
    const out = await tool.run(
      tool.input.parse({ text: "a cat", artifact_id: "a1" }),
      fakeCtx({ fetch, settings: { defaultChatId: "99" } }),
    );
    expect(out).toEqual({ message_id: 8, chat_id: "42" });
    expect(uploaded).toEqual([1, 2, 3]);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendPhoto`);
    const form = init.body as FormData;
    expect(form.get("chat_id")).toBe("99");
    expect(form.get("caption")).toBe("a cat");
    // Packs never see library paths: the upload is named from the id and mime.
    const photo = form.get("photo") as File;
    expect(photo.name).toBe("a1.png");
    expect(photo.type).toBe("image/png");
    // The copy is gone after the send.
    await expect(photo.arrayBuffer()).rejects.toThrow();
  });

  it("applies parse_mode to an artifact caption (L8)", async () => {
    let parseMode: ReturnType<FormData["get"]> = null;
    const fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      parseMode = (init?.body as FormData).get("parse_mode");
      return okResponse(9);
    });
    const tool = sendTelegram();
    await tool.run(
      tool.input.parse({
        text: "<b>a cat</b>",
        chat_id: "42",
        artifact_id: "a1",
        parse_mode: "HTML",
      }),
      fakeCtx({ fetch, settings: ALLOW_42 }),
    );
    expect(parseMode).toBe("HTML");
  });

  it("refuses chats outside allowedChatIds when the setting is set (L8)", async () => {
    const fetch = vi.fn(async () => okResponse(1));
    const tool = sendTelegram();
    const settings = { allowedChatIds: " 42, 43 ", defaultChatId: "99" };
    await expect(
      tool.run(
        tool.input.parse({ text: "x", chat_id: "666", artifact_id: "a1" }),
        fakeCtx({ fetch, settings }),
      ),
    ).rejects.toThrow(/chat 666 is not in this pack's allowedChatIds/);
    expect(fetch).not.toHaveBeenCalled();
    // Listed chats and the default chat still work.
    await tool.run(tool.input.parse({ text: "x", chat_id: "43" }), fakeCtx({ fetch, settings }));
    await tool.run(tool.input.parse({ text: "x" }), fakeCtx({ fetch, settings }));
    expect(fetch).toHaveBeenCalledTimes(2);
    // An empty list means the default chat only (M1).
    await expect(
      tool.run(
        tool.input.parse({ text: "x", chat_id: "666" }),
        fakeCtx({ fetch, settings: { allowedChatIds: "", defaultChatId: "99" } }),
      ),
    ).rejects.toThrow(
      /chat 666 is not in this pack's allowedChatIds setting and is not the default chat/,
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("allowedChatIds as a list limits sends the same way (L8)", async () => {
    const fetch = vi.fn(async () => okResponse(1));
    const tool = sendTelegram();
    const settings = { allowedChatIds: ["42", " 43 "], defaultChatId: "99" };
    await expect(
      tool.run(
        tool.input.parse({ text: "x", chat_id: "666", artifact_id: "a1" }),
        fakeCtx({ fetch, settings }),
      ),
    ).rejects.toThrow(/chat 666 is not in this pack's allowedChatIds/);
    // "4" is not allowed because "42" is: ids are compared whole.
    await expect(
      tool.run(tool.input.parse({ text: "x", chat_id: "4" }), fakeCtx({ fetch, settings })),
    ).rejects.toThrow(/chat 4 is not in/);
    expect(fetch).not.toHaveBeenCalled();
    await tool.run(tool.input.parse({ text: "x", chat_id: "43" }), fakeCtx({ fetch, settings }));
    await tool.run(tool.input.parse({ text: "x" }), fakeCtx({ fetch, settings }));
    expect(fetch).toHaveBeenCalledTimes(2);
    // An empty list means the default chat only, as the empty string does (M1).
    await expect(
      tool.run(
        tool.input.parse({ text: "x", chat_id: "666" }),
        fakeCtx({ fetch, settings: { allowedChatIds: [], defaultChatId: "99" } }),
      ),
    ).rejects.toThrow(
      /chat 666 is not in this pack's allowedChatIds setting and is not the default chat/,
    );
    await tool.run(
      tool.input.parse({ text: "x", chat_id: "99" }),
      fakeCtx({ fetch, settings: { allowedChatIds: [], defaultChatId: "99" } }),
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("with no default chat and no list, an agent-supplied chat_id reaches nothing (M1)", async () => {
    const fetch = vi.fn(async () => okResponse(1));
    const tool = sendTelegram();
    for (const settings of [
      undefined,
      { allowedChatIds: [] },
      { allowedChatIds: "", defaultChatId: "" },
    ]) {
      for (const chat_id of ["42", "-1001234567890", "@somechannel"]) {
        await expect(
          tool.run(
            tool.input.parse({ text: "x", chat_id, artifact_id: "a1" }),
            fakeCtx({ fetch, ...(settings ? { settings } : {}) }),
          ),
        ).rejects.toThrow(
          /no chat is allowed yet: set defaultChatId or add chat ids to allowedChatIds in the dashboard/,
        );
      }
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validates chat_id, text and artifact_id at the schema (M1, L6)", () => {
    const tool = sendTelegram();
    for (const chat_id of ["42", "-1001234567890", "@my_channel"]) {
      expect(tool.input.safeParse({ text: "x", chat_id }).success).toBe(true);
    }
    for (const chat_id of [
      "",
      "42 ",
      "4x2",
      "@ab",
      "@has-dash",
      "https://t.me/x",
      "1".repeat(21),
      `@${"a".repeat(40)}`,
    ]) {
      expect([chat_id, tool.input.safeParse({ text: "x", chat_id }).success]).toEqual([
        chat_id,
        false,
      ]);
    }
    expect(tool.input.safeParse({ text: "a".repeat(4096) }).success).toBe(true);
    expect(tool.input.safeParse({ text: "a".repeat(4097) }).success).toBe(false);
    expect(tool.input.safeParse({ text: "x", artifact_id: "a".repeat(129) }).success).toBe(false);
  });

  it("limits a caption to 1024 characters before uploading", async () => {
    const fetch = vi.fn(async () => okResponse(1));
    const tool = sendTelegram();
    await expect(
      tool.run(
        tool.input.parse({ text: "a".repeat(1025), chat_id: "42", artifact_id: "a1" }),
        fakeCtx({ fetch, settings: ALLOW_42 }),
      ),
    ).rejects.toThrow(/limited to 1024/);
    expect(fetch).not.toHaveBeenCalled();
    await tool.run(
      tool.input.parse({ text: "a".repeat(1025), chat_id: "42" }),
      fakeCtx({ fetch, settings: ALLOW_42 }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a malformed allowedChatIds refuses to send rather than allow every chat", async () => {
    const fetch = vi.fn(async () => okResponse(1));
    const tool = sendTelegram();
    for (const allowedChatIds of [42, { a: 1 }, ["42", 43], true]) {
      await expect(
        tool.run(
          tool.input.parse({ text: "x", chat_id: "42" }),
          fakeCtx({ fetch, settings: { allowedChatIds } }),
        ),
      ).rejects.toThrow(/allowedChatIds setting is not a list/);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the manifest declares allowedChatIds as a list of strings", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../../packs/telegram/pack.json", import.meta.url), "utf8"),
    ) as { settings: { properties: Record<string, unknown> } };
    expect(manifest.settings.properties.allowedChatIds).toMatchObject({
      type: "array",
      items: { type: "string" },
      default: [],
    });
    expect(() => parseManifest(manifest, { folderName: "telegram" })).not.toThrow();
  });

  it("needs a chat id and an existing artifact", async () => {
    const fetch = vi.fn(async () => okResponse(1));
    const tool = sendTelegram();
    await expect(tool.run(tool.input.parse({ text: "x" }), fakeCtx({ fetch }))).rejects.toThrow(
      "chat_id required",
    );
    await expect(
      tool.run(
        tool.input.parse({ text: "x", chat_id: "1", artifact_id: "missing" }),
        fakeCtx({ fetch, settings: { defaultChatId: "1" } }),
      ),
    ).rejects.toThrow("artifact missing not found");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("surfaces Telegram API errors", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify({ ok: false, description: "chat not found" })),
    );
    const tool = sendTelegram();
    await expect(
      tool.run(
        tool.input.parse({ text: "x", chat_id: "1" }),
        fakeCtx({ fetch, settings: { defaultChatId: "1" } }),
      ),
    ).rejects.toThrow("telegram sendMessage -> chat not found");
  });

  it("runs under the real permission checks: undeclared hosts and secrets are refused", async () => {
    const fetch = vi.fn(async () => okResponse(1));
    const ctx = fakeCtx({ fetch });
    await expect(ctx.fetch("https://example.com/")).rejects.toThrow(/example\.com/);
    await expect(ctx.secrets.get("OPENROUTER_API_KEY")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    // After dispose every capability throws.
    const t = harnesses[harnesses.length - 1]!;
    await t.dispose();
    await expect(ctx.secrets.get("TELEGRAM_BOT_TOKEN")).rejects.toThrow();
  });

  it("returns MISSING_SECRET through the loader when the token is not set", async () => {
    dir = mkdtempSync(join(tmpdir(), "plughive-tg-"));
    const registry = new ToolRegistry();
    const store = createSecretStore({ home: dir, env: {}, backend: "memory" });
    const loader = new PackLoader({
      home: dir,
      registry,
      host: { store, logger: silent },
      userDir: join(dir, "packs"),
      settingsOverrides: { telegram: { defaultChatId: "1" } },
    });
    await loader.loadAll();
    const res = await registry.call("send_telegram", { text: "hi", chat_id: "1" });
    expect(res).toMatchObject({
      ok: false,
      error: {
        code: "MISSING_SECRET",
        pack: "telegram",
        secret: "TELEGRAM_BOT_TOKEN",
        label: "Telegram bot token",
        helpUrl: "https://core.telegram.org/bots#how-do-i-create-a-bot",
      },
    });
    await loader.close();
  });
});
