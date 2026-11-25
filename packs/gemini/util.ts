// packs/gemini/util.ts
// Small helpers: errors, capped body reads, abortable sleep, PCM to WAV, artifact inputs.
import type { PackContext } from "plughive/pack";

export class GeminiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** The Gemini interaction id, once Gemini accepted the job. */
    readonly interactionId?: string,
  ) {
    super(message);
    this.name = "GeminiError";
  }
}

/** Remove the key and anything shaped like a Google API key from provider text. */
export function scrub(text: string, key?: string): string {
  let out = text;
  if (key) out = out.split(key).join("[key]");
  return out.replace(/AIza[0-9A-Za-z_-]{20,}/g, "[key]");
}

/** Map an HTTP failure to a message that tells the user what to do. Never echoes the raw body. */
/** Said instead of "retry" when a generation request may already have been billed. */
export const BILLED_NOTE =
  "The request may already have been processed and billed; check usage in Google AI Studio before running it again.";

export function mapHttpError(
  status: number,
  bodyText: string,
  key?: string,
  paid = false,
): GeminiError {
  let detail = "";
  let code = "";
  try {
    const j = JSON.parse(bodyText) as { error?: { message?: unknown; status?: unknown } };
    if (typeof j.error?.message === "string") detail = scrub(j.error.message, key).slice(0, 240);
    if (typeof j.error?.status === "string") code = j.error.status.replace(/[^A-Z_]/g, "");
  } catch {
    // not JSON: say nothing about the body
  }
  const suffix = detail ? ` Provider said: ${detail}` : "";
  if (status === 401 || status === 403) {
    return new GeminiError(
      `Gemini refused the API key (HTTP ${status}). Check GEMINI_API_KEY in the dashboard and that the Generative Language API is enabled for its project.`,
      status,
    );
  }
  if (status === 404) {
    return new GeminiError(
      `Gemini does not know that model or resource (HTTP 404). Run gemini_list_models for current model ids.${suffix}`,
      status,
    );
  }
  if (status === 429) {
    return new GeminiError(
      `Gemini rate limit or spend cap reached (HTTP 429${code ? ` ${code}` : ""}). Wait a minute and retry, or check quota at https://ai.google.dev/gemini-api/docs/rate-limits.`,
      status,
    );
  }
  if (status >= 500) {
    return new GeminiError(
      `Gemini had a server error (HTTP ${status}). ${paid ? BILLED_NOTE : "Retry shortly."}`,
      status,
    );
  }
  return new GeminiError(
    `Gemini rejected the request (HTTP ${status}${code ? ` ${code}` : ""}). Check the model id and parameters.${suffix}`,
    status,
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GeminiError("The call was cancelled.");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new GeminiError("The call was cancelled."));
    const onAbort = () => {
      clearTimeout(t);
      reject(new GeminiError("The call was cancelled."));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Read a response body, refusing anything over `maxBytes`. */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const tooBig = () =>
    new GeminiError(`The response is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw tooBig();
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw tooBig();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.byteLength;
  }
  return out;
}

export function b64decode(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data, "base64"));
}

export function b64encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

/** Wrap raw little-endian 16-bit PCM in a RIFF/WAVE header. */
export function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1): Uint8Array {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + pcm.byteLength, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(pcm.byteLength, 40);
  const out = new Uint8Array(44 + pcm.byteLength);
  out.set(header, 0);
  out.set(pcm, 44);
  return out;
}

export function isRiff(bytes: Uint8Array): boolean {
  return bytes.length > 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF";
}

export const MAX_INPUT_BYTES = 15 * 1024 * 1024;

/** Load a library artifact as media input. Only library ids are accepted. */
export async function loadArtifact(
  ctx: PackContext,
  id: string,
  mimePrefix: string,
  maxBytes = MAX_INPUT_BYTES,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const rec = await ctx.library.get(id);
  if (!rec) {
    throw new GeminiError(
      `Artifact "${id}" was not found. Pass an artifact id from the library, not a path or URL.`,
    );
  }
  if (!rec.mime.startsWith(`${mimePrefix}/`)) {
    throw new GeminiError(`Artifact "${id}" is ${rec.mime}; this input needs ${mimePrefix}/*.`);
  }
  if (rec.bytes > maxBytes) {
    throw new GeminiError(
      `Artifact "${id}" is ${(rec.bytes / 1048576).toFixed(1)} MB; the limit for inline input is ${Math.round(maxBytes / 1048576)} MB. Trim or compress it first.`,
    );
  }
  return { bytes: await ctx.library.read(id), mime: rec.mime };
}

export interface ArtifactOut {
  id: string;
  url: string;
  mime: string;
}

export interface MediaResult {
  artifacts: ArtifactOut[];
  model: string;
  provider: "gemini";
  /** Estimated from published prices and token counts; not the billed amount. */
  cost_usd_estimate?: number;
  /** The Gemini interaction behind a background job. */
  interaction_id?: string | null;
  /** Set when only part of the request succeeded. */
  note?: string;
}

export const round6 = (n: number): number => Math.round(n * 1e6) / 1e6;
