// One EventSource on /api/events for the whole page, shared by every screen.
// It carries changes only, so screens load their lists first and then apply events.
import { useEffect, useRef, useSyncExternalStore } from "react";
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

const listeners: { [K in Kind]: Set<Handlers[K]> } = {
  job: new Set(),
  pack: new Set(),
  approval: new Set(),
};
const stateListeners = new Set<() => void>();
let source: EventSource | null = null;
let state: StreamState = "closed";
let users = 0;
let retry: ReturnType<typeof setTimeout> | null = null;
let backoff = 1000;

function setState(s: StreamState) {
  state = s;
  for (const l of stateListeners) l();
}

function open() {
  if (source || typeof EventSource === "undefined") return;
  setState("connecting");
  const es = new EventSource("/api/events", { withCredentials: true });
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
    // The browser retries by itself on network errors, but not after an HTTP
    // error (401, 429). Close and retry with a growing delay either way.
    es.close();
    source = null;
    setState("closed");
    if (users > 0 && !retry) {
      retry = setTimeout(() => {
        retry = null;
        if (users > 0) open();
      }, backoff);
      backoff = Math.min(backoff * 2, 30_000);
    }
  };
}

function close() {
  if (retry) clearTimeout(retry);
  retry = null;
  source?.close();
  source = null;
  setState("closed");
}

/** Call a handler for every event of one kind while the component is mounted. */
export function useEvent<K extends Kind>(kind: K, handler: Handlers[K]): void {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    const fn = ((x: never) => (ref.current as (v: never) => void)(x)) as Handlers[K];
    (listeners[kind] as Set<Handlers[K]>).add(fn);
    users++;
    open();
    return () => {
      (listeners[kind] as Set<Handlers[K]>).delete(fn);
      users--;
      if (users === 0) close();
    };
  }, [kind]);
}

export function useStreamState(): StreamState {
  return useSyncExternalStore(
    (cb) => {
      stateListeners.add(cb);
      return () => stateListeners.delete(cb);
    },
    () => state,
  );
}

/** Close the stream (sign out). */
export function closeEvents(): void {
  close();
}
