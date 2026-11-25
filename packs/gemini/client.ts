// packs/gemini/client.ts
// Thin Gemini REST client on top of ctx.fetch. The key only ever travels in the
// x-goog-api-key header.
import type { PackContext, PackFetch } from "plughive/pack";
import {
  BILLED_NOTE,
  GeminiError,
  mapHttpError,
  readCapped,
  sleep,
  throwIfAborted,
} from "./util.js";

export const BASE = "https://generativelanguage.googleapis.com";
export const API_REVISION = "2026-05-20";
const MAX_JSON_BYTES = 64 * 1024 * 1024;
export const MAX_MEDIA_BYTES = 128 * 1024 * 1024;
/** Budget for one JSON request (create, poll). Inline image and audio replies can be large. */
const JSON_TIMEOUT_MS = 3 * 60_000;
/** Budget for a media download (up to MAX_MEDIA_BYTES). */
const MEDIA_TIMEOUT_MS = 10 * 60_000;

// biome-ignore lint/suspicious/noExplicitAny: provider JSON of unknown shape
export type Json = Record<string, any>;

export interface ContentPart {
  type: string;
  text?: string;
  mime_type?: string;
  data?: string;
  uri?: string;
}

export interface Interaction {
  id?: string;
  status?: string;
  model?: string;
  steps?: { type?: string; content?: ContentPart[] }[];
  usage?: Json;
  error?: unknown;
}

/** The service key setup() stores the pack-lifetime fetch under. */
export const LIFETIME_FETCH = "geminiLifetimeFetch";

/**
 * The fetch captured in setup(). It is bound to the pack's lifetime, not to
 * the call, so a cancel request still goes out after the call was aborted
 * (the per-call ctx.fetch refuses to run once the call signal fired).
 */
export function lifetimeFetch(ctx: PackContext): PackFetch {
  const f = (ctx as PackContext & { [LIFETIME_FETCH]?: PackFetch })[LIFETIME_FETCH];
  return typeof f === "function" ? f : ctx.fetch;
}

export type CancelOutcome = "sent" | "failed";

/** What a cancel did, for the error message. */
export function cancelNote(id: string, outcome: CancelOutcome): string {
  return outcome === "sent"
    ? `A cancel request for interaction ${id} was sent to Gemini; work it already did may still be billed.`
    : `The cancel request for interaction ${id} did not reach Gemini, so the job may keep running and be billed. Collect it later with gemini_get_interaction {interaction_id: "${id}"}.`;
}

const collectHint = (id: string) =>
  `collect it with gemini_get_interaction {interaction_id: "${id}"} instead of resubmitting`;

export class GeminiClient {
  private key: string | null = null;
  constructor(private readonly ctx: PackContext) {}

  private async getKey(): Promise<string> {
    this.key ??= await this.ctx.secrets.get("GEMINI_API_KEY");
    return this.key;
  }

  private async request(
    method: string,
    path: string,
    opts: { body?: unknown; revision?: boolean; timeoutMs?: number; paid?: boolean } = {},
  ): Promise<Response> {
    throwIfAborted(this.ctx.signal);
    const key = await this.getKey();
    const headers: Record<string, string> = { "x-goog-api-key": key, accept: "application/json" };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    if (opts.revision) headers["Api-Revision"] = API_REVISION;
    let res: Response;
    try {
      res = await this.ctx.fetch(`${BASE}${path}`, {
        method,
        headers,
        timeoutMs: opts.timeoutMs ?? JSON_TIMEOUT_MS,
        ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
        ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
      });
    } catch (e) {
      if (this.ctx.signal?.aborted) throw new GeminiError("The call was cancelled.");
      const msg = e instanceof Error ? e.message.replace(key, "[key]") : "network error";
      throw new GeminiError(
        `Could not reach the Gemini API: ${msg.slice(0, 200)}. ${opts.paid ? BILLED_NOTE : "Check the network and retry."}`,
      );
    }
    if (!res.ok) {
      const text = new TextDecoder().decode(
        await readCapped(res, 1024 * 1024).catch(() => new Uint8Array()),
      );
      throw mapHttpError(res.status, text, key, opts.paid);
    }
    return res;
  }

  async json(
    method: string,
    path: string,
    opts: { body?: unknown; revision?: boolean; paid?: boolean } = {},
  ): Promise<Json> {
    const res = await this.request(method, path, opts);
    const bytes = await readCapped(res, MAX_JSON_BYTES);
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as Json;
    } catch {
      throw new GeminiError(
        opts.paid
          ? `Gemini returned a response that is not JSON. ${BILLED_NOTE}`
          : "Gemini returned a response that is not JSON. Retry; if it repeats, report it.",
      );
    }
  }

  async bytes(path: string): Promise<{ bytes: Uint8Array; mime: string | null }> {
    const res = await this.request("GET", path, { timeoutMs: MEDIA_TIMEOUT_MS });
    return { bytes: await readCapped(res, MAX_MEDIA_BYTES), mime: res.headers.get("content-type") };
  }

  /**
   * Create an interaction and wait for it. Handles both an immediate
   * "completed" and a background run that must be polled. Cancels the remote
   * interaction when the call is aborted.
   */
  async interact(
    body: Json,
    opts: {
      background?: boolean;
      pollMs?: number;
      maxWaitMs?: number;
      onProgress?: (f: number, m: string) => void;
    } = {},
  ): Promise<Interaction> {
    const payload = opts.background ? { ...body, background: true } : body;
    const it = (await this.json("POST", "/v1beta/interactions", {
      body: payload,
      revision: true,
      paid: true,
    })) as Interaction;
    return this.wait(it, opts);
  }

  /**
   * Poll an interaction until it leaves the running states. Every error raised
   * after Gemini accepted the job names the interaction id.
   */
  async wait(
    first: Interaction,
    opts: { pollMs?: number; maxWaitMs?: number; onProgress?: (f: number, m: string) => void } = {},
  ): Promise<Interaction> {
    let it = first;
    const pollMs = opts.pollMs ?? 4000;
    const deadline = Date.now() + (opts.maxWaitMs ?? 10 * 60_000);
    let n = 0;
    let transient = 0;
    const cancelled = async (id: string) => {
      const outcome = await this.cancel(id);
      return new GeminiError(`The call was cancelled. ${cancelNote(id, outcome)}`, undefined, id);
    };
    while (it.status === "in_progress" || it.status === "requires_continuation") {
      const id = it.id;
      if (!id) {
        throw new GeminiError(
          "Gemini accepted the request but returned no interaction id, so it cannot be tracked. It may still run and be billed; check usage in Google AI Studio before running it again.",
        );
      }
      if (Date.now() > deadline) {
        // Not cancelled on purpose: the job is already paid for, so it is left
        // to finish and can be collected rather than paid for twice.
        throw new GeminiError(
          `Gemini is still working on interaction ${id} after the wait limit. It keeps running and is billed; ${collectHint(id)}.`,
          undefined,
          id,
        );
      }
      opts.onProgress?.(Math.min(0.9, 0.1 + n * 0.05), "Gemini is generating");
      try {
        await sleep(pollMs, this.ctx.signal);
      } catch {
        throw await cancelled(id);
      }
      n++;
      try {
        it = await this.get(id);
        transient = 0;
      } catch (e) {
        if (this.ctx.signal?.aborted) throw await cancelled(id);
        const status = e instanceof GeminiError ? e.status : undefined;
        const retryable = status === undefined || status >= 500 || status === 429;
        if (retryable && ++transient <= 3) {
          it = { ...it, id };
          continue;
        }
        const msg = e instanceof Error ? e.message : String(e);
        throw new GeminiError(
          `${msg} (while polling interaction ${id}; it may still finish: ${collectHint(id)}).`,
          status,
          id,
        );
      }
    }
    const ref = it.id ?? "(no id)";
    if (it.status === "failed" || it.status === "cancelled" || it.status === "incomplete") {
      throw new GeminiError(
        `Gemini ended interaction ${ref} with status "${it.status}". Rephrase the prompt (it may have been blocked) or try another model.`,
        undefined,
        it.id,
      );
    }
    if (it.status === "requires_action") {
      throw new GeminiError(
        `Gemini asked for an action this pack does not support (interaction ${ref}). Try a simpler request.`,
        undefined,
        it.id,
      );
    }
    return it;
  }

  /** Read one interaction. */
  async get(id: string): Promise<Interaction> {
    return (await this.json("GET", `/v1beta/interactions/${encodeURIComponent(id)}`, {
      revision: true,
    })) as Interaction;
  }

  /**
   * Ask Gemini to cancel a background interaction. Uses the pack-lifetime
   * fetch so the request still goes out after the call was aborted. Never throws.
   */
  async cancel(id: string): Promise<CancelOutcome> {
    try {
      const key = await this.getKey();
      const res = await lifetimeFetch(this.ctx)(
        `${BASE}/v1beta/interactions/${encodeURIComponent(id)}/cancel`,
        {
          method: "POST",
          headers: { "x-goog-api-key": key, "Api-Revision": API_REVISION },
          timeoutMs: 15_000,
        },
      );
      await res.body?.cancel().catch(() => {});
      return res.ok ? "sent" : "failed";
    } catch {
      return "failed";
    }
  }
}

/** Content parts of every model_output step, in order. */
export function outputParts(it: Interaction): ContentPart[] {
  const out: ContentPart[] = [];
  for (const step of it.steps ?? []) {
    if (step.type !== "model_output") continue;
    for (const c of step.content ?? []) out.push(c);
  }
  return out;
}

export function outputText(it: Interaction): string {
  return outputParts(it)
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
}

export function tokenCounts(it: Interaction): { input: number; output: number } {
  const u = it.usage ?? {};
  return {
    input: Number(u.total_input_tokens ?? 0) || 0,
    output: Number(u.total_output_tokens ?? 0) || 0,
  };
}
