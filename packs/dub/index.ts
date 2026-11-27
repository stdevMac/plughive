// packs/dub/index.ts
//
// Dub.co link shortening. https://dub.co/docs/api-reference/introduction
import { definePack, defineTool, z } from "plughive/pack";

const BASE = "https://api.dub.co";

/** Printable text with no whitespace or control characters. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
const TOKEN = /^[^\s\u0000-\u001f\u007f]+$/;
const HOSTNAME =
  /^(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

/** Most of an error body that is ever read, and the most of its message that is shown. */
const MAX_ERROR_BYTES = 16 * 1024;
/** Most of a successful JSON response that is read; a larger one is refused. */
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_ERROR_CHARS = 200;

const shorten = defineTool({
  name: "dub_shorten_url",
  description: "Create a Dub.co short link with optional tags. Returns short_url + Dub link id.",
  capability: "shorten_url",
  secrets: ["DUB_API_KEY"],
  // Creating a link is metered on Dub, and the call goes straight to api.dub.co
  // (not through the capability router), so the gate needs the "paid" tag.
  tags: ["dub", "paid"],
  annotations: { openWorldHint: true },
  input: z.object({
    url: z.url({ protocol: /^https?$/ }).max(8192),
    key: z
      .string()
      .min(1)
      .max(190)
      .regex(TOKEN, "key must not contain spaces or control characters")
      .optional(),
    tags: z
      .array(
        z
          .string()
          .min(1)
          .max(64)
          // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters is the point
          .regex(/^[^\u0000-\u001f\u007f]+$/),
      )
      .max(20)
      .optional(),
    domain: z
      .string()
      .max(253)
      .regex(HOSTNAME, "domain must be a hostname such as dub.sh")
      .optional(),
  }),
  async run(input, ctx) {
    const apiKey = await ctx.secrets.get("DUB_API_KEY");
    const res = await ctx.fetch(`${BASE}/links`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        url: input.url,
        key: input.key,
        tags: input.tags,
        domain: input.domain,
      }),
    });
    if (!res.ok) throw new Error(await dubError(res, apiKey));
    const j = (await readJson(res)) as { id?: unknown; shortLink?: unknown; key?: unknown } | null;
    if (typeof j?.id !== "string" || typeof j.shortLink !== "string") {
      throw new Error(
        "Dub created the link but returned no id or short link. Check the Dub dashboard before trying again.",
      );
    }
    return { id: j.id, short_url: j.shortLink, key: typeof j.key === "string" ? j.key : null };
  },
});

/** A JSON body of at most MAX_JSON_BYTES, or null when it is larger or not JSON. */
async function readJson(res: Response): Promise<unknown> {
  const { bytes, truncated } = await readCapped(res, MAX_JSON_BYTES);
  if (truncated) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

/** A short message for a failed Dub response: Dub's own error message when it sends one, never the raw body. */
export async function dubError(res: Response, apiKey?: string): Promise<string> {
  let message = "";
  try {
    const text = await readCappedText(res, MAX_ERROR_BYTES);
    try {
      const j = JSON.parse(text) as {
        error?: { message?: unknown; code?: unknown } | string;
        message?: unknown;
      };
      const m = typeof j.error === "string" ? j.error : (j.error?.message ?? j.message);
      if (typeof m === "string") message = m;
    } catch {
      // Not JSON: show the start of the text, made single-line below.
      message = text;
    }
  } catch {
    // body unreadable: report the status alone
  }
  if (apiKey) message = message.split(apiKey).join("[key]");
  message = message
    // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening control characters
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (message.length > MAX_ERROR_CHARS) message = `${message.slice(0, MAX_ERROR_CHARS)}...`;
  return `Dub ${res.status}${message ? `: ${message}` : ""}`;
}

async function readCappedText(res: Response, maxBytes: number): Promise<string> {
  return new TextDecoder().decode((await readCapped(res, maxBytes)).bytes);
}

/** Up to `maxBytes` of a body; `truncated` when there was more (the rest is not read). */
async function readCapped(
  res: Response,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!res.body) return { bytes: new Uint8Array(0), truncated: false };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - total;
    if (value.byteLength > room) {
      chunks.push(value.subarray(0, room));
      total = maxBytes;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { bytes: Buffer.concat(chunks), truncated };
}

export default definePack({ tools: [shorten] });
