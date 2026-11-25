// packs/elevenlabs/util.ts
// Errors, capped body reads, abortable sleep, WAV wrapping and artifact inputs.
import type { PackContext } from "plughive/pack";

export class ElevenError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** A network failure, 429, 5xx or garbled body: a read may succeed if repeated. */
    readonly transient = false,
  ) {
    super(message);
    this.name = "ElevenError";
  }
}

/** Remove the key and anything shaped like an ElevenLabs key from provider text. */
export function scrub(text: string, key?: string): string {
  let out = text;
  if (key) out = out.split(key).join("[key]");
  return out.replace(/sk_[0-9a-f]{16,}/gi, "[key]");
}

/** Pull a short, scrubbed message and a status code out of an ElevenLabs error body. */
function parseDetail(bodyText: string, key?: string): { message: string; code: string } {
  let message = "";
  let code = "";
  try {
    const j = JSON.parse(bodyText) as { detail?: unknown };
    const d = j.detail;
    if (typeof d === "string") message = d;
    else if (Array.isArray(d)) {
      const first = d[0] as { msg?: unknown } | undefined;
      if (typeof first?.msg === "string") message = first.msg;
    } else if (d && typeof d === "object") {
      const o = d as { message?: unknown; status?: unknown };
      if (typeof o.message === "string") message = o.message;
      if (typeof o.status === "string") code = o.status.replace(/[^a-z0-9_]/gi, "").slice(0, 60);
    }
  } catch {
    // not JSON: say nothing about the body
  }
  return { message: scrub(message, key).slice(0, 240), code };
}

/** Map an HTTP failure to a message that tells the user what to do. Never echoes the raw body. */
export function mapHttpError(status: number, bodyText: string, key?: string): ElevenError {
  const { message, code } = parseDetail(bodyText, key);
  const suffix = message ? ` Provider said: ${message}` : "";
  if (status === 401) {
    return new ElevenError(
      "ElevenLabs refused the API key (HTTP 401). Check ELEVENLABS_API_KEY in the dashboard and that the key has the needed permission.",
      status,
    );
  }
  if (status === 402 || code === "quota_exceeded") {
    return new ElevenError(
      `ElevenLabs reports the plan or credits cannot cover this request (HTTP ${status}). Run elevenlabs_usage to see the remaining quota, shorten the input, or upgrade the plan.${suffix}`,
      status,
    );
  }
  if (status === 404) {
    return new ElevenError(
      `ElevenLabs does not know that voice, model or resource (HTTP 404). Use elevenlabs_list_voices or elevenlabs_list_models for current ids.${suffix}`,
      status,
    );
  }
  if (status === 429) {
    return new ElevenError(
      `ElevenLabs concurrency or rate limit reached (HTTP 429${code ? ` ${code}` : ""}). Wait for running requests to finish, then retry one at a time.`,
      status,
      true,
    );
  }
  if (status >= 500) {
    // No "retry shortly": a generation request that hit a 5xx may already
    // have been processed and billed, and repeating it would bill again.
    return new ElevenError(
      `ElevenLabs had a server error (HTTP ${status}). The request may already have been processed and billed; check elevenlabs_usage (or, for a dub, the ElevenLabs dubbing dashboard) before running it again.`,
      status,
      true,
    );
  }
  return new ElevenError(
    `ElevenLabs rejected the request (HTTP ${status}${code ? ` ${code}` : ""}). Check the ids and parameters.${suffix}`,
    status,
  );
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ElevenError("The call was cancelled.");
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ElevenError("The call was cancelled."));
    const onAbort = () => {
      clearTimeout(t);
      reject(new ElevenError("The call was cancelled."));
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
    new ElevenError(`The response is larger than the ${Math.round(maxBytes / 1048576)} MB limit.`);
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

export const MAX_INPUT_BYTES = 50 * 1024 * 1024;

/** Load a library artifact as media input. Only library ids are accepted. */
export async function loadArtifact(
  ctx: PackContext,
  id: string,
  mimePrefixes: string[],
  maxBytes = MAX_INPUT_BYTES,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const rec = await ctx.library.get(id);
  if (!rec) {
    throw new ElevenError(
      `Artifact "${id}" was not found. Pass an artifact id from the library, not a path or URL.`,
    );
  }
  if (!mimePrefixes.some((p) => rec.mime.startsWith(`${p}/`))) {
    throw new ElevenError(
      `Artifact "${id}" is ${rec.mime}; this input needs ${mimePrefixes.map((p) => `${p}/*`).join(" or ")}.`,
    );
  }
  if (rec.bytes > maxBytes) {
    throw new ElevenError(
      `Artifact "${id}" is ${(rec.bytes / 1048576).toFixed(1)} MB; the limit is ${Math.round(maxBytes / 1048576)} MB. Trim or compress it first.`,
    );
  }
  return { bytes: await ctx.library.read(id), mime: rec.mime };
}

export interface ArtifactOut {
  id: string;
  url: string;
  mime: string;
}

export interface AudioResult {
  artifacts: ArtifactOut[];
  model: string;
  provider: "elevenlabs";
  characters_used?: number;
  song_id?: string;
}
