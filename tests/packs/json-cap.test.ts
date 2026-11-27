// R4-M8: a successful response from these providers is read with a byte cap
// (8 MiB) before JSON.parse, never with an unbounded res.json().
import { fileURLToPath } from "node:url";
import type { PackContext } from "plughive/pack";
import { type TestContext, createTestContext } from "plughive/pack/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { provider as brave } from "../../packs/brave/index.js";
import { provider as deepl } from "../../packs/deepl/index.js";
import dubPack from "../../packs/dub/index.js";
import { provider as exa } from "../../packs/exa/index.js";
import { provider as mistral } from "../../packs/mistral/index.js";
import { provider as parallel } from "../../packs/parallel/index.js";
import { provider as supadata } from "../../packs/supadata/index.js";
import { provider as tavily } from "../../packs/tavily/index.js";
import { failure } from "./provider-support.js";
import { fakeCtx, toolOf } from "./support.js";

const MiB = 1024 * 1024;

/** A 200 response that streams `total` bytes of a JSON-looking body, counting what is pulled. */
function bigResponse(total: number): { res: Response; pulled: () => number } {
  let sent = 0;
  const chunk = new Uint8Array(256 * 1024).fill(0x20);
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      if (sent === 0) {
        c.enqueue(new TextEncoder().encode('{"x":"'));
        sent += 6;
        return;
      }
      if (sent >= total) {
        c.close();
        return;
      }
      c.enqueue(chunk);
      sent += chunk.byteLength;
    },
  });
  return {
    res: new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
    pulled: () => sent,
  };
}

const harnesses: TestContext[] = [];
afterEach(async () => {
  for (const t of harnesses.splice(0)) await t.dispose();
});

interface Case {
  name: string;
  pack: string;
  tool: string;
  secrets: Record<string, string>;
  run: (ctx: PackContext) => unknown;
  label: string;
}

const cases: Case[] = [
  {
    name: "brave",
    pack: "brave",
    tool: "search_web",
    secrets: { BRAVE_API_KEY: "BSA-test-0123456789" },
    run: (ctx) => brave.run({ query: "q" } as never, ctx as never),
    label: "Brave Search",
  },
  {
    name: "deepl",
    pack: "deepl",
    tool: "translate_text",
    secrets: { DEEPL_API_KEY: "0123abcd-0000-1111-2222-333344445555" },
    run: (ctx) => deepl.run({ text: "hi", target_language: "de" } as never, ctx as never),
    label: "DeepL",
  },
  {
    name: "exa",
    pack: "exa",
    tool: "search_web",
    secrets: { EXA_API_KEY: "exa-test-key-0123456789" },
    run: (ctx) => exa.run({ query: "q" } as never, ctx as never),
    label: "Exa",
  },
  {
    name: "parallel",
    pack: "parallel",
    tool: "search_web",
    secrets: { PARALLEL_API_KEY: "par-test-0123456789" },
    run: (ctx) => parallel.run({ query: "q" } as never, ctx as never),
    label: "Parallel",
  },
  {
    name: "tavily",
    pack: "tavily",
    tool: "search_web",
    secrets: { TAVILY_API_KEY: "tvly-test-0123456789" },
    run: (ctx) => tavily.run({ query: "q" } as never, ctx as never),
    label: "Tavily",
  },
  {
    name: "supadata",
    pack: "supadata",
    tool: "get_media_transcript",
    secrets: { SUPADATA_API_KEY: "sd_test0123456789" },
    run: (ctx) =>
      supadata.run({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } as never, ctx as never),
    label: "Supadata",
  },
  {
    name: "mistral",
    pack: "mistral",
    tool: "parse_document",
    secrets: { MISTRAL_API_KEY: "mistral-test-0123456789" },
    run: (ctx) => mistral.run({ artifact_id: "pdf1" } as never, ctx as never),
    label: "Mistral",
  },
];

describe("successful JSON responses are read with a cap (R4-M8)", () => {
  for (const c of cases) {
    it(`${c.name}: refuses a body over 8 MiB without reading all of it`, async () => {
      const big = bigResponse(64 * MiB);
      const fetch = Object.assign(async () => big.res, { calls: [] });
      const packDir = fileURLToPath(new URL(`../../packs/${c.pack}`, import.meta.url));
      const t = createTestContext({ packDir, secrets: c.secrets, fetch });
      harnesses.push(t);
      t.library?.seed({
        id: "pdf1",
        mime: "application/pdf",
        bytes: "%PDF-1.7",
        tool: "user/upload",
      });
      const err = await failure(Promise.resolve().then(() => c.run(t.forTool(c.tool))));
      expect(err.message).toBe(`${c.label} sent a response larger than 8 MB; it was not read.`);
      expect(big.pulled()).toBeLessThan(10 * MiB);
    });
  }

  it("dub: an oversized body is treated as no id and not read in full", async () => {
    const big = bigResponse(64 * MiB);
    const f = vi.fn(async () => big.res);
    const tool = toolOf(dubPack, "dub_shorten_url");
    const err = await failure(
      tool.run(
        tool.input.parse({ url: "https://example.com" }),
        fakeCtx({ packId: "dub", secrets: { DUB_API_KEY: "dub_key" }, fetch: f as never }),
      ),
    );
    expect(err.message).toMatch(/Dub created the link but returned no id/);
    expect(big.pulled()).toBeLessThan(10 * MiB);
  });
});
