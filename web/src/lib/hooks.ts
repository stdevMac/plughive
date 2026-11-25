import { type DependencyList, useCallback, useEffect, useRef, useState } from "react";

export interface Resource<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload(): Promise<void>;
  /** Replace the data locally (optimistic updates, event streams). */
  mutate(update: T | ((prev: T | undefined) => T | undefined)): void;
}

/** Load something once per deps change; keep the last data while reloading. */
export function useResource<T>(
  load: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList = [],
): Resource<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const loadRef = useRef(load);
  loadRef.current = load;
  const ctrlRef = useRef<AbortController | null>(null);

  const reload = useCallback(async () => {
    ctrlRef.current?.abort();
    const ctrl = new AbortController();
    ctrlRef.current = ctrl;
    setLoading(true);
    try {
      const v = await loadRef.current(ctrl.signal);
      if (ctrl.signal.aborted) return;
      setData(v);
      setError(null);
    } catch (e) {
      if (ctrl.signal.aborted || (e as { name?: string })?.name === "AbortError") return;
      setError(e);
    } finally {
      if (!ctrl.signal.aborted) setLoading(false);
    }
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are the caller's
  useEffect(() => {
    void reload();
    return () => ctrlRef.current?.abort();
  }, deps);

  const mutate = useCallback((update: T | ((prev: T | undefined) => T | undefined)) => {
    setData((prev) =>
      typeof update === "function" ? (update as (p: T | undefined) => T | undefined)(prev) : update,
    );
  }, []);

  return { data, error, loading, reload, mutate };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

/** A clock that ticks while `active`, for elapsed times. */
export function useNow(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title ? `${title} - plughive` : "plughive";
  }, [title]);
}
