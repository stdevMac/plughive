import { fileURLToPath } from "node:url";
import type { CapabilityError } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it } from "vitest";
import mistralPack, { MAX_BYTES, provider } from "../../../packs/mistral/index.js";
import { type Route, failure, routerFetch } from "../provider-support.js";

const packDir = fileURLToPath(new URL("../../../packs/mistral", import.meta.url));
const KEY = "mistral-test-0123456789";
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const harnesses: TestContext[] = [];
afterEach(async () => {
  for (const t of harnesses.splice(0)) await t.dispose();
});

function setup(routes: Route[], secrets: Record<string, string> = { MISTRAL_API_KEY: KEY }) {
  const fetch = routerFetch(routes);
  const t = createTestContext({ packDir, secrets, fetch });
  harnesses.push(t);
  // Uploaded by the user: readable because the pack declares library "read-all".
  t.library?.seed({ id: "pdf1", mime: "application/pdf", bytes: "%PDF-1.7", tool: "user/upload" });
  t.library?.seed({
    id: "png1",
    kind: "image",
    mime: "image/png",
    bytes: "PNG",
    tool: "user/upload",
  });
  t.library?.seed({ id: "txt1", mime: "text/plain", bytes: "hi", tool: "user/upload" });
  return { ctx: t.forTool("parse_document"), fetch };
}

const ocr = () =>
  json({
    model: "mistral-ocr-2505",
    pages: [
      { index: 1, markdown: "page two" },
      { index: 0, markdown: "# Page one\n\n| a | b |" },
    ],
    usage_info: { pages_processed: 2, doc_size_bytes: 8 },
  });

describe("mistral pack", () => {
  it("exports one document.parse provider", () => {
    expect(mistralPack.providers).toEqual([provider]);
    expect(provider).toMatchObject({ id: "mistral", capability: "document.parse", priority: 50 });
  });

  it("isConfigured follows MISTRAL_API_KEY", async () => {
    expect(await provider.isConfigured(setup([]).ctx)).toBe(true);
    expect(await provider.isConfigured(setup([], {}).ctx)).toBe(false);
  });

  it("sends a PDF as a document_url data URL and joins pages in order", async () => {
    const { ctx, fetch } = setup([
      { match: /^POST https:\/\/api\.mistral\.ai\/v1\/ocr$/, reply: ocr },
    ]);
    const out = await provider.run({ artifact_id: "pdf1", language: "de" }, ctx);
    const call = fetch.calls[0];
    expect(call?.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      model: "mistral-ocr-latest",
      document: {
        type: "document_url",
        document_url: `data:application/pdf;base64,${Buffer.from("%PDF-1.7").toString("base64")}`,
      },
      include_image_base64: false,
    });
    expect(out).toEqual({
      provider: "mistral",
      text: "# Page one\n\n| a | b |\n\npage two",
      format: "markdown",
      pages: 2,
      model: "mistral-ocr-2505",
    });
  });

  it("sends an image as an image_url data URL", async () => {
    const { ctx, fetch } = setup([{ match: /mistral/, reply: ocr }]);
    await provider.run({ artifact_id: "png1", model: "mistral-ocr-2505" }, ctx);
    expect(JSON.parse(fetch.calls[0]?.body ?? "{}")).toMatchObject({
      model: "mistral-ocr-2505",
      document: { type: "image_url", image_url: `data:image/png;base64,${btoa("PNG")}` },
    });
  });

  it("refuses text format, other models, other file types and a missing key retryably", async () => {
    const a = setup([]);
    for (const input of [
      { artifact_id: "pdf1", format: "text" as const },
      { artifact_id: "pdf1", model: "pixtral-large" },
      { artifact_id: "txt1" },
    ]) {
      expect(await failure(provider.run(input, a.ctx))).toMatchObject({
        retryable: true,
        code: "UNSUPPORTED_OPTION",
      });
    }
    expect(a.fetch.calls).toHaveLength(0);
    expect(await failure(provider.run({ artifact_id: "pdf1" }, setup([], {}).ctx))).toMatchObject({
      retryable: true,
      code: "NOT_CONFIGURED",
    });
  });

  it("checks the size of the bytes it read, not only the size the record states", async () => {
    const a = setup([]);
    const big = new Uint8Array(MAX_BYTES + 1);
    const ctx = {
      ...a.ctx,
      library: { ...a.ctx.library, read: async () => big },
    } as typeof a.ctx;
    expect(await failure(provider.run({ artifact_id: "pdf1" }, ctx))).toMatchObject({
      code: "UNSUPPORTED_OPTION",
      message: expect.stringMatching(/files over 50 MB/),
    });
    expect(a.fetch.calls).toHaveLength(0);
  });

  it("a missing artifact is not retryable", async () => {
    expect(await failure(provider.run({ artifact_id: "nope" }, setup([]).ctx))).toMatchObject({
      retryable: false,
      code: "NOT_FOUND",
    });
  });

  it("classifies HTTP errors, including FastAPI 422 details", async () => {
    const cases: [number, unknown, boolean, string, string][] = [
      [
        422,
        { detail: [{ msg: "bad doc" }, { msg: "too big" }] },
        false,
        "PROVIDER_ERROR",
        "bad doc; too big",
      ],
      [401, { message: "Unauthorized" }, true, "AUTH_FAILED", "Unauthorized"],
      [
        429,
        { message: "Requests rate limit exceeded" },
        true,
        "RATE_LIMITED",
        "Requests rate limit exceeded",
      ],
      [500, { object: "error", message: "oops" }, true, "PROVIDER_ERROR", "oops"],
    ];
    for (const [status, body, retryable, code, message] of cases) {
      const { ctx } = setup([{ match: /mistral/, reply: () => json(body, status) }]);
      const e = (await failure(provider.run({ artifact_id: "pdf1" }, ctx))) as CapabilityError;
      expect(e).toMatchObject({ retryable, code, status });
      expect(e.message).toBe(`Mistral ${status}: ${message}`);
    }
  });
});

describe("mistral estimate", () => {
  it("prices an image as one page at $4 per 1,000", async () => {
    expect(await provider.estimate?.({ artifact_id: "png1" }, setup([]).ctx)).toEqual({
      usd: 0.004,
      basis: "static price table (2026-11): 1 page at $4/1,000",
    });
  });

  it("has no estimate for a PDF of unknown length or a missing file", async () => {
    expect(await provider.estimate?.({ artifact_id: "pdf1" }, setup([]).ctx)).toBeNull();
    expect(await provider.estimate?.({ artifact_id: "nope" }, setup([]).ctx)).toBeNull();
  });

  it("uses the page count the library knows", async () => {
    const { ctx } = setup([]);
    const t = harnesses[harnesses.length - 1];
    t?.library?.seed({
      id: "pdf42",
      mime: "application/pdf",
      bytes: "%PDF-1.7",
      tool: "user/upload",
      meta: { pages: 42 },
    });
    expect(await provider.estimate?.({ artifact_id: "pdf42" }, ctx)).toEqual({
      usd: 0.168,
      basis: "static price table (2026-11): 42 pages at $4/1,000",
    });
  });
});
