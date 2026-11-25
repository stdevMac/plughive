import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PackContext } from "plughive/pack";
import { describe, expect, it } from "vitest";
import { providers, translateInstructions } from "../../../packs/openrouter/capabilities.js";
import pack from "../../../packs/openrouter/index.js";
import { CAPABILITY_SCHEMAS } from "../../../src/core/capabilities/schemas.js";
import { memLibrary, packTools, routerFetch, tempDir } from "../provider-support.js";
import { fakeCtx, jsonResponse } from "../support.js";

type Cap = keyof typeof CAPABILITY_SCHEMAS;

const find = (cap: Cap) => {
  const p = providers.find((x) => x.capability === cap);
  if (!p) throw new Error(`no ${cap} provider`);
  return p as unknown as { run(input: unknown, ctx: PackContext): Promise<unknown> };
};

const KEY = "sk-or-test-not-real";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const IMAGES = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "images_models.json"), "utf8"),
);
const UNSUPPORTED = { name: "CapabilityError", retryable: true, code: "UNSUPPORTED_OPTION" };

const imagesCatalog = {
  match: /^GET https:\/\/openrouter\.ai\/api\/v1\/images\/models$/,
  reply: () => jsonResponse(IMAGES),
};

async function setup(fetch: PackContext["fetch"]) {
  const lib = memLibrary();
  lib.put("img1", "image/png", PNG);
  lib.put("img2", "image/png", PNG);
  const base = fakeCtx({
    packId: "openrouter",
    dataDir: tempDir("plughive-openrouter-tasks-"),
    secrets: { OPENROUTER_API_KEY: KEY },
    settings: { models: "" },
    fetch,
    library: lib.library,
  });
  const { ctx } = await packTools(pack, base);
  return { ctx: { ...ctx, fetch } as PackContext };
}

function posted(fetch: ReturnType<typeof routerFetch>) {
  const post = fetch.calls.find((c) => c.method === "POST");
  if (!post?.body) throw new Error("no POST");
  return JSON.parse(post.body);
}

async function call(cap: Cap, input: unknown, ctx: PackContext) {
  const out = await find(cap).run(CAPABILITY_SCHEMAS[cap].input.parse(input), ctx);
  return CAPABILITY_SCHEMAS[cap].output.parse(out) as Record<string, unknown>;
}

async function failure(cap: Cap, input: unknown, ctx: PackContext) {
  return (await find(cap)
    .run(CAPABILITY_SCHEMAS[cap].input.parse(input), ctx)
    .catch((e: unknown) => e)) as {
    name?: string;
    retryable?: boolean;
    code?: string;
    message?: string;
  };
}

describe("openrouter image.edit", () => {
  it("sends the source image first, then the references, as input_references", async () => {
    const fetch = routerFetch([
      imagesCatalog,
      {
        match: /^POST https:\/\/openrouter\.ai\/api\/v1\/images$/,
        reply: () =>
          jsonResponse({
            data: [{ b64_json: Buffer.from(PNG).toString("base64"), media_type: "image/png" }],
            usage: { cost: 0.03 },
          }),
      },
    ]);
    const { ctx } = await setup(fetch);
    const out = await call(
      "image.edit",
      { artifact_id: "img1", reference_ids: ["img2"], prompt: "make it blue", aspect_ratio: "1:1" },
      ctx,
    );
    const body = posted(fetch);
    expect(body).toMatchObject({
      model: "google/gemini-nano-banana-2.1",
      prompt: "make it blue",
      aspect_ratio: "1:1",
    });
    expect(body.input_references).toHaveLength(2);
    expect(JSON.stringify(body.input_references[0])).toContain("data:image/png;base64,");
    expect(out).toMatchObject({
      provider: "openrouter",
      model: "google/gemini-nano-banana-2.1",
      cost_usd: 0.03,
    });
    expect(out.artifacts).toHaveLength(1);
  });

  it("refuses a mask, a model without input images and n over the model's limit, before any POST", async () => {
    const fetch = routerFetch([imagesCatalog]);
    const { ctx } = await setup(fetch);
    expect(
      await failure("image.edit", { artifact_id: "img1", prompt: "x", mask_id: "img2" }, ctx),
    ).toMatchObject(UNSUPPORTED);
    expect(
      await failure("image.edit", { artifact_id: "img1", prompt: "x", n: 2 }, ctx),
    ).toMatchObject(UNSUPPORTED);
    expect(fetch.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("an accepted edit that returns no image is not retryable", async () => {
    const fetch = routerFetch([
      imagesCatalog,
      {
        match: /^POST https:\/\/openrouter\.ai\/api\/v1\/images$/,
        reply: () => jsonResponse({ data: [] }),
      },
    ]);
    const { ctx } = await setup(fetch);
    const err = await failure("image.edit", { artifact_id: "img1", prompt: "x" }, ctx);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe("CapabilityError");
    expect(err.retryable).not.toBe(true);
  });
});

describe("openrouter text.translate", () => {
  it("asks the chat model for the translation alone, at temperature 0", async () => {
    const fetch = routerFetch([
      {
        match: /^POST https:\/\/openrouter\.ai\/api\/v1\/chat\/completions$/,
        reply: () =>
          jsonResponse({
            model: "minimax/minimax-m2.7",
            choices: [{ message: { content: " Hallo Welt\n" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 20, completion_tokens: 3, cost: 0.00002 },
          }),
      },
    ]);
    const { ctx } = await setup(fetch);
    const out = await call(
      "text.translate",
      { text: "Hello world", target_language: "de", formality: "less" },
      ctx,
    );
    const body = posted(fetch);
    expect(body.temperature).toBe(0);
    expect(body.messages[0].role).toBe("system");
    expect(body.messages[0].content).toContain('"de"');
    expect(body.messages[0].content).toContain("informal register");
    expect(body.messages[1]).toEqual({ role: "user", content: "Hello world" });
    expect(out).toMatchObject({
      text: "Hallo Welt",
      provider: "openrouter",
      model: "minimax/minimax-m2.7",
      cost_usd: 0.00002,
    });
  });

  it("a rejected chat request is not retryable", async () => {
    const fetch = routerFetch([
      {
        match: /^POST https:\/\/openrouter\.ai\/api\/v1\/chat\/completions$/,
        reply: () => jsonResponse({ error: { message: "boom" } }, 500),
      },
    ]);
    const { ctx } = await setup(fetch);
    const err = await failure("text.translate", { text: "Hello", target_language: "fr" }, ctx);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe("CapabilityError");
    expect(err.retryable).not.toBe(true);
  });

  it("translateInstructions names the source language when given", () => {
    expect(translateInstructions({ target_language: "fr", source_language: "en" })).toContain(
      'from the language with code "en"',
    );
    expect(translateInstructions({ target_language: "fr" })).not.toContain("from the language");
  });
});

describe("openrouter text.embed", () => {
  const embedRoute = (reply: () => Response) => ({
    match: /^POST https:\/\/openrouter\.ai\/api\/v1\/embeddings$/,
    reply,
  });

  it("posts the texts to /embeddings and returns the vectors in input order", async () => {
    const fetch = routerFetch([
      embedRoute(() =>
        jsonResponse({
          object: "list",
          model: "openai/text-embedding-3-small",
          data: [
            { object: "embedding", index: 1, embedding: [0.4, 0.5, 0.6] },
            { object: "embedding", index: 0, embedding: [0.1, 0.2, 0.3] },
          ],
          usage: { prompt_tokens: 4, total_tokens: 4, cost: 0.000001 },
        }),
      ),
    ]);
    const { ctx } = await setup(fetch);
    const out = await call(
      "text.embed",
      { texts: ["a", "b"], dimensions: 256, input_type: "query" },
      ctx,
    );
    expect(posted(fetch)).toEqual({
      model: "openai/text-embedding-3-small",
      input: ["a", "b"],
      encoding_format: "float",
      dimensions: 256,
      input_type: "search_query",
    });
    expect(out).toEqual({
      embeddings: [
        [0.1, 0.2, 0.3],
        [0.4, 0.5, 0.6],
      ],
      model: "openai/text-embedding-3-small",
      dimensions: 3,
      provider: "openrouter",
      cost_usd: 0.000001,
    });
  });

  it("an answer with fewer vectors than texts is a non-retryable error", async () => {
    const fetch = routerFetch([
      embedRoute(() => jsonResponse({ data: [{ index: 0, embedding: [0.1] }] })),
    ]);
    const { ctx } = await setup(fetch);
    const err = await failure("text.embed", { texts: ["a", "b"] }, ctx);
    expect(err.message).toMatch(/1 usable embedding/);
    expect(err.name).not.toBe("CapabilityError");
    expect(err.retryable).not.toBe(true);
  });
});
