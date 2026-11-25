// HTTP helpers for this pack's tools. Each bundled action pack carries its own
// copy, since packs do not import from each other.
//
// Every error built here is short, single-line and scrubbed of the secret
// values passed in (raw, URL-encoded and base64), and never includes the
// request URL: some providers take their key as a query parameter.
import type { PackFetch, PackFetchInit } from "plughive/pack";

/** Most of an error body that is read, and the most of its message shown. */
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_ERROR_CHARS = 300;
/** Most of a JSON body that is read. */
export const MAX_JSON_BYTES = 8 * 1024 * 1024;

/** Remove secret values (and their encoded forms) and control characters; cap the length. */
export function scrub(text: string, secrets: readonly string[], max = MAX_ERROR_CHARS): string {
  let out = text;
  for (const s of secrets) {
    if (!s || s.length < 4) continue;
    for (const form of new Set([s, encodeURIComponent(s), Buffer.from(s).toString("base64")])) {
      out = out.split(form).join("[redacted]");
    }
  }
  out = Array.from(out, (c) => (isControl(c) ? " " : c))
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return out.length > max ? `${out.slice(0, max)}...` : out;
}

/** A C0 control character or DEL. */
function isControl(c: string): boolean {
  const code = c.charCodeAt(0);
  return code < 0x20 || code === 0x7f;
}

/** True when `s` has no control characters (for input schemas). */
export function noControl(s: string): boolean {
  return !Array.from(s).some(isControl);
}

/** True when `s` has no control characters, whitespace or URL path/query/fragment delimiters. */
export function isPathSegment(s: string): boolean {
  return noControl(s) && !/[\s/?#\\]/.test(s) && s !== "." && s !== "..";
}

/** Up to `maxBytes` of a body; `truncated` when there was more. */
export async function readCapped(
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
      total += room;
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }
  return { bytes: new Uint8Array(Buffer.concat(chunks)), truncated };
}

const MESSAGE_KEYS = [
  "message",
  "error_message",
  "detail",
  "Error Message",
  "Information",
  "Note",
  "title",
];

/** The provider's own error message, when the body carries one in a common shape. */
function messageOf(body: unknown, depth = 0): string | null {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object" || depth > 3) return null;
  const o = body as Record<string, unknown>;
  for (const k of MESSAGE_KEYS) {
    if (typeof o[k] === "string") return o[k] as string;
  }
  if (typeof o.error === "string") return o.error;
  if (o.error && typeof o.error === "object") return messageOf(o.error, depth + 1);
  if (Array.isArray(o.errors) && o.errors.length > 0) return messageOf(o.errors[0], depth + 1);
  return null;
}

/** A short error for a failed response: the provider's message, never the raw body or URL. */
export async function apiError(
  provider: string,
  res: Response,
  secrets: readonly string[],
): Promise<Error> {
  let message = "";
  try {
    const text = new TextDecoder().decode((await readCapped(res, MAX_ERROR_BYTES)).bytes);
    try {
      message = messageOf(JSON.parse(text)) ?? "";
    } catch {
      message = text;
    }
  } catch {
    // body unreadable: the status alone
  }
  message = scrub(message, secrets);
  return new Error(`${provider} ${res.status}${message ? `: ${message}` : ""}`);
}

/** Calls fetch; a network failure is reported without the URL. Permission and abort errors pass. */
export async function send(
  fetch: PackFetch,
  provider: string,
  url: string,
  init: PackFetchInit,
  secrets: readonly string[],
): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const e = err as { name?: string; code?: string; message?: string };
    if (
      e?.code === "PACK_PERMISSION_DENIED" ||
      e?.name === "AbortError" ||
      e?.name === "TimeoutError"
    ) {
      throw err;
    }
    throw new Error(`${provider}: request failed (${scrub(String(e?.message ?? err), secrets)})`);
  }
}

/** Parses a JSON body read with a cap; an empty body is `{}`. */
export async function readJson<T>(provider: string, res: Response): Promise<T> {
  const { bytes, truncated } = await readCapped(res, MAX_JSON_BYTES);
  if (truncated)
    throw new Error(`${provider}: the response is larger than ${MAX_JSON_BYTES} bytes`);
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === "") return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`${provider}: the response is not JSON`);
  }
}

/** A JSON request: throws a scrubbed error on a non-2xx status or a body that is not JSON. */
export async function requestJson<T = unknown>(
  fetch: PackFetch,
  provider: string,
  url: string,
  init: PackFetchInit,
  secrets: readonly string[],
): Promise<T> {
  const res = await send(fetch, provider, url, init, secrets);
  if (!res.ok) throw await apiError(provider, res, secrets);
  return readJson<T>(provider, res);
}

/** A binary download capped at `maxBytes`; a larger body is refused, never cut. */
export async function requestBytes(
  fetch: PackFetch,
  provider: string,
  url: string,
  init: PackFetchInit,
  secrets: readonly string[],
  maxBytes: number,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const res = await send(fetch, provider, url, init, secrets);
  if (!res.ok) throw await apiError(provider, res, secrets);
  const declared = Number(res.headers.get("content-length") ?? "");
  const tooBig = `${provider}: the file is larger than the ${maxBytes}-byte limit`;
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(tooBig);
  }
  const { bytes, truncated } = await readCapped(res, maxBytes);
  if (truncated) throw new Error(tooBig);
  const mime = (res.headers.get("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
  return { bytes, mime: mime || "application/octet-stream" };
}

/** A string field, or null. */
export function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** A finite number field, or null. */
export function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** An object field, or an empty object. */
export function obj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** An array field, or an empty array. */
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
