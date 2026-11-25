import type { PackContext } from "plughive/pack";
import { describe, expect, it, vi } from "vitest";
import { providers, translateInstructions } from "../../../packs/gemini/capabilities.js";
import { CAPABILITY_SCHEMAS } from "../../../src/core/capabilities/schemas.js";
import { fakeCtx, jsonResponse } from "../support.js";

type Cap = keyof typeof CAPABILITY_SCHEMAS;

const find = (cap: Cap) => {
  const p = providers.find((x) => x.capability === cap);
  if (!p) throw new Error(`no ${cap} provider`);
  return p as unknown as { run(input: unknown, ctx: PackContext): Promise<unknown> };
};

const KEY = "AIzaTESTKEY0123456789abcdefghijk";
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");

function setup(reply: () => Response) {
  const bodies: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    bodies.push(init?.body ? JSON.parse(String(init.body)) : {});
    return reply();
  });
  const arts: Record<string, { mime: string; bytes: Uint8Array }> = {
    img1: { mime: "image/png", bytes: PNG },
    img2: { mime: "image/png", bytes: PNG },
  };
  let n = 0;
  const ctx = fakeCtx({
    packId: "gemini",
    secrets: { GEMINI_API_KEY: KEY },
    fetch: fetch as never,
    library: {
      get: (async (id: string) =>
        arts[id] ? { id, mime: arts[id].mime, bytes: arts[id].bytes.length } : null) as never,
      read: (async (id: string) => arts[id]?.bytes) as never,
      save: (async (input: { mime: string }) => {
        n++;
        return {
          id: `art_${n}`,
          path: "/x",
          url: `http://127.0.0.1:7777/a/art_${n}`,
          mime: input.mime,
        };
      }) as never,
    },
  });
  return { ctx: ctx as PackContext, bodies, fetch };
}

const interaction = (content: unknown[]) => ({
  id: "int_1",
  status: "completed",
  model: "gemini-test",
  steps: [{ type: "model_output", content }],
  usage: { total_input_tokens: 10, total_output_tokens: 20 },
});

async function call(cap: Cap, input: unknown, ctx: PackContext) {
  const out = await find(cap).run(CAPABILITY_SCHEMAS[cap].input.parse(input), ctx);
  return CAPABILITY_SCHEMAS[cap].output.parse(out) as Record<string, unknown>;
}

describe("gemini image.edit and text.translate providers", () => {
  it("image.edit sends the source image first, then the references", async () => {
    const h = setup(() =>
      jsonResponse(interaction([{ type: "image", mime_type: "image/png", data: b64("OUT") }])),
    );
    const out = await call(
      "image.edit",
      { artifact_id: "img1", reference_ids: ["img2"], prompt: "make it blue" },
      h.ctx,
    );
    const body = h.bodies[0] as {
      model: string;
      input: { type: string; text?: string; data?: string }[];
    };
    expect(body.model).toBe("gemini-nano-banana-2.1");
    expect(body.input.map((p) => p.type)).toEqual(["text", "image", "image"]);
    expect(body.input[0]?.text).toBe("make it blue");
    expect(body.input[1]?.data).toBe(b64(PNG));
    expect(out).toMatchObject({ provider: "gemini", model: "gemini-nano-banana-2.1" });
    expect(out.artifacts).toHaveLength(1);
  });

  it("image.edit refuses a mask with a retryable error, before any request", async () => {
    const h = setup(() => jsonResponse({}));
    const err = await find("image.edit")
      .run({ artifact_id: "img1", prompt: "x", mask_id: "img2" }, h.ctx)
      .catch((e: unknown) => e);
    expect(err).toMatchObject({
      name: "CapabilityError",
      retryable: true,
      code: "UNSUPPORTED_OPTION",
    });
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it("image.edit fails without retry when the accepted request returns no image", async () => {
    const h = setup(() => jsonResponse(interaction([{ type: "text", text: "blocked" }])));
    const err = (await find("image.edit")
      .run({ artifact_id: "img1", prompt: "x" }, h.ctx)
      .catch((e: unknown) => e)) as { name?: string; retryable?: boolean };
    expect(err).toBeInstanceOf(Error);
    expect(err.name).not.toBe("CapabilityError");
    expect(err.retryable).not.toBe(true);
  });

  it("text.translate asks the chat model for the translation alone", async () => {
    const h = setup(() => jsonResponse(interaction([{ type: "text", text: " Hallo Welt \n" }])));
    const out = await call(
      "text.translate",
      { text: "Hello world", target_language: "de", formality: "more" },
      h.ctx,
    );
    const body = h.bodies[0] as {
      input: string;
      system_instruction: string;
      generation_config: unknown;
    };
    expect(body.input).toBe("Hello world");
    expect(body.system_instruction).toContain('"de"');
    expect(body.system_instruction).toContain("formal register");
    expect(body.generation_config).toEqual({ temperature: 0 });
    expect(out).toMatchObject({ text: "Hallo Welt", provider: "gemini", model: "gemini-test" });
  });

  it("translateInstructions names the source language when given", () => {
    expect(translateInstructions({ target_language: "fr", source_language: "en" })).toContain(
      'from the language with code "en"',
    );
    expect(translateInstructions({ target_language: "fr" })).not.toContain("from the language");
  });
});
