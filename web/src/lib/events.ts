// One EventSource on /api/events for the whole page, shared by every screen.
// It carries changes only, so screens load their lists first and then apply events.
import { useEffect, useRef, useSyncExternalStore } from "react";
import { type ApiClient, ApiError, api } from "./api";
import type { ApprovalEvent } from "./approvals";
import type { JobView } from "./types";

export interface PackEvent {
  id: string;
  state: string;
  enabled: boolean;
  error: string | null;
  tools: number;
  providers: number;
}

type Handlers = {
  job: (j: JobView) => void;
  pack: (p: PackEvent) => void;
  approval: (a: ApprovalEvent) => void;
};
type Kind = keyof Handlers;

export type StreamState = "connecting" | "open" | "closed";

export interface EventSourceLike {
  addEventListener(type: string, listener: (e: Event) => void): void;
  close(): void;
  onerror: ((e: Event) => void) | null;
}

export interface EventsDeps {
  createSource?: (url: string) => EventSourceLike | null;
  client?: Pick<ApiClient, "get">;
}

export function createEventManager(deps: EventsDeps = {}) {
  const listeners: { [K in Kind]: Set<Handlers[K]> } = {
    job: new Set(),
    pack: new Set(),
    approval: new Set(),
  };
  const stateListeners = new Set<() => void>();
  let source: EventSourceLike | null = null;
  let state: StreamState = "closed";
  let users = 0;
  let retry: ReturnType<typeof setTimeout> | null = null;
  let probeAbort: AbortController | null = null;
  let generation = 0;
  let backoff = 1000;

  const client = deps.client ?? api;
  const createSource =
    deps.createSource ??
    ((url: string) =>
      typeof EventSource === "undefined"
        ? null
        : (new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike));

  function setState(s: StreamState) {
    state = s;
    for (const l of stateListeners) l();
  }

  function scheduleRetry(gen: number) {
    if (gen !== generation || users <= 0 || retry) return;
    retry = setTimeout(() => {
      retry = null;
      if (gen === generation && users > 0) open();
    }, backoff);
    backoff = Math.min(backoff * 2, 30_000);
  }

  function open() {
    if (source) return;
    const es = createSource("/api/events");
    if (!es) return;
    const gen = generation;
    setState("connecting");
    source = es;
    es.addEventListener("hello", () => {
      backoff = 1000;
      setState("open");
    });
    es.addEventListener("job", (e) => {
      try {
        const job = JSON.parse((e as MessageEvent<string>).data) as JobView;
        for (const l of listeners.job) l(job);
      } catch {
        // A malformed event is skipped.
      }
    });
    es.addEventListener("pack", (e) => {
      try {
        const p = JSON.parse((e as MessageEvent<string>).data) as PackEvent;
        for (const l of listeners.pack) l(p);
      } catch {
        // skipped
      }
    });
    es.addEventListener("approval", (e) => {
      try {
        const a = JSON.parse((e as MessageEvent<string>).data) as ApprovalEvent;
        for (const l of listeners.approval) l(a);
      } catch {
        // skipped
      }
    });
    es.onerror = () => {
      // EventSource does not expose HTTP status codes. Close on any error and
      // check /api/info before retrying so an expired session (401) notifies
      // api.onUnauthorized() and stops reconnecting instead of looping forever.
      es.close();
      if (source === es) source = null;
      setState("closed");
      if (gen !== generation || users <= 0 || retry || probeAbort) return;
      const ac = new AbortController();
      probeAbort = ac;
      void client
        .get("/api/info", undefined, ac.signal)
        .then(() => {
          if (probeAbort === ac) probeAbort = null;
          scheduleRetry(gen);
        })
        .catch((err) => {
          if (probeAbort === ac) probeAbort = null;
          if (gen !== generation) return;
          if (err instanceof ApiError && err.status === 401) return;
          scheduleRetry(gen);
        });
    };
  }

  function close() {
    generation++;
    if (retry) clearTimeout(retry);
    retry = null;
    probeAbort?.abort();
    probeAbort = null;
    source?.close();
    source = null;
    setState("closed");
  }

  function subscribe<K extends Kind>(kind: K, fn: Handlers[K]): () => void {
    (listeners[kind] as Set<Handlers[K]>).add(fn);
    users++;
    open();
    return () => {
      (listeners[kind] as Set<Handlers[K]>).delete(fn);
      users--;
      if (users === 0) close();
    };
  }

  return {
    subscribe,
    close,
    getState: () => state,
    subscribeState: (cb: () => void) => {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
  };
}

const manager = createEventManager();

/** Call a handler for every event of one kind while the component is mounted. */
export function useEvent<K extends Kind>(kind: K, handler: Handlers[K]): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const fn = ((x: never) => (ref.current as (v: never) => void)(x)) as Handlers[K];
    return manager.subscribe(kind, fn);
  }, [kind]);
}

export function useStreamState(): StreamState {
  return useSyncExternalStore(manager.subscribeState, manager.getState);
}

/** Close the stream (sign out). */
export function closeEvents(): void {
  manager.close();
}
