// src/core/http/events-api.ts
//
// Live updates of the management API, as Server-Sent Events.
//
//   GET /api/events
//
//   event: hello   data: {"interval_ms": 1000}          once, when the stream opens
//   event: job     data: <the job as on /api/jobs/:id>  a job appeared or changed
//   event: pack    data: {id, state, enabled, error, tools, providers}
//                                                       a pack appeared, changed or went away
//                                                       (state "removed")
//   event: approval data: {id, status, tool, pending}   a spend approval was requested or
//                                                       decided (`pending`: open requests now)
//   : ping                                              a comment every 20 s keeps proxies open
//
// The stream carries changes from the moment it opens: read /api/jobs and
// /api/packs first for the current state. Behind the admin token and the Origin
// guard like the rest of /api. At most 16 streams are open at once (429
// beyond that), and nothing is polled while no stream is open.
import type { EventEmitter } from "node:events";
import type { Express, Response } from "express";
import type { JobStatus } from "../../types.js";
import type { PackStatus } from "../packs/loader.js";
import { type JobRow, jobView } from "../tools/builtin/index.js";
import { type ApiLogger, fail } from "./api-common.js";

export const MAX_EVENT_STREAMS = 16;
export const EVENT_POLL_INTERVAL_MS = 1000;
export const EVENT_PING_INTERVAL_MS = 20_000;
/** How many of the newest jobs are watched for changes. */
const WATCHED_JOBS = 200;

export interface EventsApiDeps {
  logger?: ApiLogger;
  jobs: { list(opts: { status?: JobStatus; limit?: number; offset?: number }): JobRow[] };
  packs?: { listPacks(): Promise<PackStatus[]> };
  /** Spend approvals: each change is sent as an "approval" event. */
  approvals?: {
    events: EventEmitter;
    pendingCount(): number;
  };
  /** Applied to job results: signs the artifact links inside them. */
  decorate?(value: unknown): unknown;
  intervalMs?: number;
  pingMs?: number;
  maxStreams?: number;
}

export interface EventStreams {
  /** Look for changes now instead of at the next tick. */
  poke(): void;
  /** End every open stream and stop the timers. */
  close(): void;
  /** Open streams (for tests and /health). */
  size(): number;
}

interface PackEvent {
  id: string;
  state: string;
  enabled: boolean;
  error: string | null;
  tools: number;
  providers: number;
}

const packEvent = (p: PackStatus): PackEvent => ({
  id: p.id,
  state: p.state,
  enabled: p.enabled,
  error: p.error,
  tools: p.tools.length,
  providers: p.providers.length,
});

export function mountEventsApi(app: Express, deps: EventsApiDeps): EventStreams {
  const intervalMs = deps.intervalMs ?? EVENT_POLL_INTERVAL_MS;
  const pingMs = deps.pingMs ?? EVENT_PING_INTERVAL_MS;
  const maxStreams = deps.maxStreams ?? MAX_EVENT_STREAMS;
  const decorate = deps.decorate ?? ((v: unknown) => v);
  const clients = new Set<Response>();
  let jobSeen = new Map<string, string>();
  let packSeen = new Map<string, string>();
  let pollTimer: NodeJS.Timeout | null = null;
  let pingTimer: NodeJS.Timeout | null = null;
  let polling = false;
  let again = false;
  let closed = false;

  const send = (event: string, data: unknown) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) {
      // A reader that stopped reading is dropped, not buffered for.
      if (res.writableLength > 1024 * 1024) {
        res.destroy();
        continue;
      }
      res.write(frame);
    }
  };

  /** Compare with what was last seen; `emit` false only records the baseline. */
  const poll = async (emit: boolean): Promise<void> => {
    if (polling) {
      again = true;
      return;
    }
    polling = true;
    try {
      const nextJobs = new Map<string, string>();
      for (const job of deps.jobs.list({ limit: WATCHED_JOBS })) {
        const view = jobView(job);
        const key = `${view.status}|${view.progress}|${view.message ?? ""}|${view.updated_at}`;
        nextJobs.set(job.id, key);
        if (emit && jobSeen.get(job.id) !== key) {
          send("job", { ...view, result: decorate(view.result) });
        }
      }
      jobSeen = nextJobs;
      if (deps.packs) {
        const nextPacks = new Map<string, string>();
        for (const pack of await deps.packs.listPacks()) {
          const event = packEvent(pack);
          const key = JSON.stringify(event);
          nextPacks.set(pack.id, key);
          if (emit && packSeen.get(pack.id) !== key) send("pack", event);
        }
        if (emit) {
          for (const id of packSeen.keys()) {
            if (!nextPacks.has(id)) {
              send("pack", {
                id,
                state: "removed",
                enabled: false,
                error: null,
                tools: 0,
                providers: 0,
              });
            }
          }
        }
        packSeen = nextPacks;
      }
    } catch (e) {
      deps.logger?.warn({ err: e instanceof Error ? e.name : typeof e }, "event poll failed");
    } finally {
      polling = false;
      if (again && clients.size > 0 && !closed) {
        again = false;
        void poll(true);
      }
    }
  };

  const stopTimers = () => {
    if (pollTimer) clearInterval(pollTimer);
    if (pingTimer) clearInterval(pingTimer);
    pollTimer = null;
    pingTimer = null;
  };

  const startTimers = () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => void poll(true), intervalMs);
    pingTimer = setInterval(() => {
      for (const res of clients) res.write(": ping\n\n");
    }, pingMs);
    pollTimer.unref();
    pingTimer.unref();
  };

  app.get("/api/events", (req, res) => {
    if (closed) {
      fail(res, 503, "SHUTTING_DOWN", "the daemon is shutting down");
      return;
    }
    if (res.destroyed) return;
    // The slot is reserved synchronously, in the same step as the check: the
    // first stream then waits for its baseline poll before writing, and a
    // concurrent request arriving meanwhile must already see the slot taken.
    if (clients.size >= maxStreams) {
      fail(res, 429, "TOO_MANY_STREAMS", `at most ${maxStreams} event streams are open at once`);
      return;
    }
    clients.add(res);
    res.status(200).set({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Content-Type-Options": "nosniff",
    });
    res.flushHeaders();
    res.write(`event: hello\ndata: ${JSON.stringify({ interval_ms: intervalMs })}\n\n`);
    startTimers();
    req.on("close", () => {
      clients.delete(res);
      if (clients.size === 0) stopTimers();
    });
    // The first stream sets the baseline: only what changes after it is sent.
    if (clients.size === 1) void poll(false);
  });

  // Approvals are pushed as they change (no polling): what a badge needs, no arguments.
  const onApproval = (a: { id: string; status: string; tool: string }) => {
    if (clients.size === 0 || closed) return;
    let pending = 0;
    try {
      pending = deps.approvals?.pendingCount() ?? 0;
    } catch {
      return;
    }
    send("approval", { id: a.id, status: a.status, tool: a.tool, pending });
  };
  deps.approvals?.events.on("change", onApproval);

  return {
    poke: () => {
      if (clients.size > 0 && !closed) void poll(true);
    },
    close: () => {
      closed = true;
      deps.approvals?.events.off("change", onApproval);
      stopTimers();
      for (const res of clients) res.end();
      clients.clear();
    },
    size: () => clients.size,
  };
}
