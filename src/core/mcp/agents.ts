// src/core/mcp/agents.ts
//
// The MCP clients this daemon has heard from since it started, so the
// dashboard can say "Connected agents: 2" and name them. In memory only.
//
// A client names itself in `initialize` (2025-era) or in every request's
// `_meta["io.modelcontextprotocol/clientInfo"]` (2026-07-28). Only requests
// that passed the access-key check reach here. The name is the client's own
// claim: it is cut to printable text and 64 characters, and the list keeps at
// most MAX_AGENTS entries (the least recently seen goes first), so a client
// cannot grow it or put markup in it.

export const MAX_AGENTS = 20;
const MAX_NAME = 64;
const META_KEY = "io.modelcontextprotocol/clientInfo";

export interface SeenAgent {
  name: string;
  version: string | null;
  /** The exposure profile it connected through ("default" for /mcp). */
  profile: string;
  first_seen: number;
  last_seen: number;
}

function clean(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .trim();
  return s ? s.slice(0, MAX_NAME) : null;
}

function clientInfoOf(msg: unknown): { name: string; version: string | null } | null {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) return null;
  const params = (msg as { params?: unknown }).params;
  if (!params || typeof params !== "object") return null;
  const p = params as { clientInfo?: unknown; _meta?: unknown };
  let info: unknown = null;
  if ((msg as { method?: unknown }).method === "initialize") info = p.clientInfo;
  if (!info && p._meta && typeof p._meta === "object")
    info = (p._meta as Record<string, unknown>)[META_KEY];
  if (!info || typeof info !== "object") return null;
  const name = clean((info as { name?: unknown }).name);
  if (!name) return null;
  return { name, version: clean((info as { version?: unknown }).version) };
}

export class RecentAgents {
  private readonly seen = new Map<string, SeenAgent>();
  constructor(private readonly now: () => number = Date.now) {}

  /** Note the client named in a JSON-RPC body (a message or a batch). */
  note(body: unknown, profile: string): void {
    const msgs = Array.isArray(body) ? body.slice(0, 16) : [body];
    for (const m of msgs) {
      const info = clientInfoOf(m);
      if (!info) continue;
      const key = `${profile}\u0000${info.name}`;
      const t = this.now();
      const prev = this.seen.get(key);
      this.seen.delete(key);
      this.seen.set(key, {
        name: info.name,
        version: info.version ?? prev?.version ?? null,
        profile,
        first_seen: prev?.first_seen ?? t,
        last_seen: t,
      });
      while (this.seen.size > MAX_AGENTS) {
        const oldest = this.seen.keys().next().value;
        if (oldest === undefined) break;
        this.seen.delete(oldest);
      }
    }
  }

  /** Most recently seen first. */
  list(): SeenAgent[] {
    return [...this.seen.values()].reverse().map((a) => ({ ...a }));
  }
}
