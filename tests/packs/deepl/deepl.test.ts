import { fileURLToPath } from "node:url";
import type { CapabilityError } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it } from "vitest";
import deeplPack, { endpointFor, provider, targetLang } from "../../../packs/deepl/index.js";
import { type Route, failure, routerFetch } from "../provider-support.js";

const packDir = fileURLToPath(new URL("../../../packs/deepl", import.meta.url));
const PRO = "0123abcd-0000-1111-2222-333344445555";
const FREE = `${PRO}:fx`;
const json = (v: unknown, status = 200) =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

const harnesses: TestContext[] = [];
afterEach(async () => {
  for (const t of harnesses.splice(0)) await t.dispose();
});

function setup(routes: Route[], secrets: Record<string, string> = { DEEPL_API_KEY: PRO }) {
  const fetch = routerFetch(routes);
  const t = createTestContext({ packDir, secrets, fetch });
  harnesses.push(t);
  return { ctx: t.forTool("translate_text"), fetch };
}

const ok = () =>
  json({
    translations: [
      { detected_source_language: "EN", text: "Hallo Welt", model_type_used: "quality_optimized" },
    ],
  });

describe("deepl pack", () => {
  it("exports one text.translate provider", () => {
    expect(deeplPack.providers).toEqual([provider]);
    expect(provider).toMatchObject({ id: "deepl", capability: "text.translate", priority: 60 });
  });

  it("isConfigured follows DEEPL_API_KEY", async () => {
    expect(await provider.isConfigured(setup([]).ctx)).toBe(true);
    expect(await provider.isConfigured(setup([], {}).ctx)).toBe(false);
  });

  it("normalizes target codes", () => {
    expect(targetLang("de")).toBe("DE");
    expect(targetLang("en")).toBe("EN-US");
    expect(targetLang("pt")).toBe("PT-PT");
    expect(targetLang("pt-BR")).toBe("PT-BR");
    expect(targetLang("en_gb")).toBe("EN-GB");
    expect(targetLang("zh-Hans")).toBe("ZH-HANS");
  });

  it("picks the Free host for :fx keys", () => {
    expect(endpointFor(FREE)).toBe("https://api-free.deepl.com/v2/translate");
    expect(endpointFor(PRO)).toBe("https://api.deepl.com/v2/translate");
  });

  it("maps the input onto POST /v2/translate and normalizes the reply", async () => {
    const { ctx, fetch } = setup([
      { match: /^POST https:\/\/api\.deepl\.com\/v2\/translate$/, reply: ok },
    ]);
    const out = await provider.run(
      {
        text: "Hello world",
        target_language: "de",
        source_language: "en-US",
        formality: "more",
        model: "quality_optimized",
      },
      ctx,
    );
    const call = fetch.calls[0];
    expect(call?.headers.authorization).toBe(`DeepL-Auth-Key ${PRO}`);
    expect(call?.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(call?.body ?? "{}")).toEqual({
      text: ["Hello world"],
      target_lang: "DE",
      source_lang: "EN",
      formality: "prefer_more",
      model_type: "quality_optimized",
    });
    expect(out).toEqual({
      provider: "deepl",
      text: "Hallo Welt",
      detected_source_language: "EN",
      model: "quality_optimized",
    });
  });

  it("uses api-free.deepl.com with a Free key and sends only what was asked", async () => {
    const { ctx, fetch } = setup(
      [{ match: /^POST https:\/\/api-free\.deepl\.com\/v2\/translate$/, reply: ok }],
      { DEEPL_API_KEY: FREE },
    );
    await provider.run({ text: "x", target_language: "ja", formality: "less" }, ctx);
    expect(JSON.parse(fetch.calls[0]?.body ?? "{}")).toEqual({
      text: ["x"],
      target_lang: "JA",
      formality: "prefer_less",
    });
  });

  it("refuses an unknown model, an oversized text and a missing key retryably", async () => {
    const a = setup([]);
    for (const input of [
      { text: "x", target_language: "de", model: "next-gen" },
      { text: "€".repeat(50_000), target_language: "de" },
    ]) {
      expect(await failure(provider.run(input, a.ctx))).toMatchObject({
        retryable: true,
        code: "UNSUPPORTED_OPTION",
      });
    }
    expect(a.fetch.calls).toHaveLength(0);
    expect(
      await failure(provider.run({ text: "x", target_language: "de" }, setup([], {}).ctx)),
    ).toMatchObject({ retryable: true, code: "NOT_CONFIGURED" });
  });

  it("classifies HTTP errors, including 456 quota and 529", async () => {
    const cases: [number, boolean, string][] = [
      [400, false, "PROVIDER_ERROR"],
      [403, true, "AUTH_FAILED"],
      [429, true, "RATE_LIMITED"],
      [456, true, "QUOTA_EXCEEDED"],
      [529, true, "RATE_LIMITED"],
      [500, true, "PROVIDER_ERROR"],
    ];
    for (const [status, retryable, code] of cases) {
      const { ctx } = setup([{ match: /deepl/, reply: () => json({ message: "nope" }, status) }]);
      const e = (await failure(
        provider.run({ text: "x", target_language: "de" }, ctx),
      )) as CapabilityError;
      expect(e).toMatchObject({ retryable, code, status });
      expect(e.message).toBe(`DeepL ${status}: nope`);
    }
  });

  it("redacts the trimmed key it sent, even when the stored key has a trailing newline", async () => {
    const { ctx } = setup(
      [{ match: /deepl/, reply: () => json({ message: `bad key ${PRO}` }, 403) }],
      {
        DEEPL_API_KEY: `${PRO}\n`,
      },
    );
    const e = await failure(provider.run({ text: "x", target_language: "de" }, ctx));
    expect(e.message).toBe("DeepL 403: bad key [key]");
  });

  it("a reply without translations is a non-retryable BAD_RESPONSE", async () => {
    const { ctx } = setup([{ match: /deepl/, reply: () => json({ translations: [] }) }]);
    expect(await failure(provider.run({ text: "x", target_language: "de" }, ctx))).toMatchObject({
      retryable: false,
      code: "BAD_RESPONSE",
    });
  });
});

describe("deepl estimate", () => {
  const est = (text: string) => provider.estimate?.({ text, target_language: "de" }, setup([]).ctx);

  it("prices source characters at $25 per million", async () => {
    expect(await est("x".repeat(40_000))).toEqual({
      usd: 1,
      basis: "static price table (2026-11): 40000 chars at $25/M",
    });
    expect((await est("Hello"))?.usd).toBe(0.000125);
  });

  it("is never 0", async () => {
    expect((await est("a"))?.usd).toBeGreaterThan(0);
  });
});
