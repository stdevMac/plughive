// A tiny history-API router: one path, one query string, links that do not reload.
// Pages with unsaved work register a blocker (useBlocker); leaving the page by
// a link, navigate() or the browser's back and forward buttons asks them first.
import {
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { blockingFor } from "./navguard";

interface Location {
  path: string;
  query: URLSearchParams;
}

interface NavOpts {
  replace?: boolean;
}

interface RouterValue extends Location {
  navigate(to: string, opts?: NavOpts): void;
  setQuery(update: Record<string, string | null | undefined>, opts?: NavOpts): void;
}

interface BlockerEntry {
  id: number;
  when: boolean;
  /** Called instead of navigating; `proceed` completes the move. */
  onBlock: (proceed: () => void) => void;
}

interface BlockerRegistry {
  set(entry: BlockerEntry): void;
  remove(id: number): void;
}

const RouterContext = createContext<RouterValue | null>(null);
const BlockerContext = createContext<BlockerRegistry | null>(null);

function read(): Location {
  return {
    path: window.location.pathname.replace(/\/+$/, "") || "/",
    query: new URLSearchParams(window.location.search),
  };
}

function here(): string {
  return `${window.location.pathname}${window.location.search}`;
}

export function RouterProvider({ children }: { children: ReactNode }) {
  const [loc, setLoc] = useState<Location>(read);
  const blockers = useRef(new Map<number, BlockerEntry>());
  // The URL the app is showing, so a blocked back/forward can be put back.
  const shown = useRef(here());

  const go = useCallback((to: string, opts: NavOpts = {}) => {
    if (to !== here()) {
      if (opts.replace) window.history.replaceState(null, "", to);
      else window.history.pushState(null, "", to);
    }
    shown.current = here();
    setLoc(read());
    if (!opts.replace) window.scrollTo?.(0, 0);
  }, []);

  useEffect(() => {
    const onPop = () => {
      const to = here();
      const b = blockingFor(blockers.current.values(), shown.current, to);
      if (b) {
        // Put the page the user is on back in the address bar, then ask.
        window.history.pushState(null, "", shown.current);
        b.onBlock(() => go(to));
        return;
      }
      shown.current = to;
      setLoc(read());
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [go]);

  const navigate = useCallback(
    (to: string, opts: NavOpts = {}) => {
      const b = blockingFor(blockers.current.values(), here(), to);
      if (b) b.onBlock(() => go(to, opts));
      else go(to, opts);
    },
    [go],
  );

  const setQuery = useCallback(
    (update: Record<string, string | null | undefined>, opts: NavOpts = { replace: true }) => {
      const q = new URLSearchParams(window.location.search);
      for (const [k, v] of Object.entries(update)) {
        if (v === null || v === undefined || v === "") q.delete(k);
        else q.set(k, v);
      }
      const qs = q.toString();
      const to = `${window.location.pathname}${qs ? `?${qs}` : ""}`;
      if (opts.replace) window.history.replaceState(null, "", to);
      else window.history.pushState(null, "", to);
      shown.current = here();
      setLoc(read());
    },
    [],
  );

  const registry = useMemo<BlockerRegistry>(
    () => ({
      set: (entry) => blockers.current.set(entry.id, entry),
      remove: (id) => blockers.current.delete(id),
    }),
    [],
  );

  const value = useMemo(() => ({ ...loc, navigate, setQuery }), [loc, navigate, setQuery]);
  return (
    <BlockerContext.Provider value={registry}>
      <RouterContext.Provider value={value}>{children}</RouterContext.Provider>
    </BlockerContext.Provider>
  );
}

export function useRouter(): RouterValue {
  const v = useContext(RouterContext);
  if (!v) throw new Error("useRouter outside RouterProvider");
  return v;
}

let nextBlockerId = 1;

/**
 * While `when` is true, leaving the page in the app calls `onBlock(proceed)`
 * instead; call `proceed()` to leave after all (for example after the user
 * confirms discarding their changes).
 */
export function useBlocker(when: boolean, onBlock: (proceed: () => void) => void): void {
  const registry = useContext(BlockerContext);
  const id = useRef(0);
  if (id.current === 0) id.current = nextBlockerId++;
  const cb = useRef(onBlock);
  cb.current = onBlock;
  useEffect(() => {
    if (!registry) return;
    const myId = id.current;
    registry.set({ id: myId, when, onBlock: (p) => cb.current(p) });
    return () => registry.remove(myId);
  }, [registry, when]);
}

type LinkProps = AnchorHTMLAttributes<HTMLAnchorElement> & { to: string };

export function Link({ to, onClick, children, ...rest }: LinkProps) {
  const { navigate } = useRouter();
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={handle} {...rest}>
      {children}
    </a>
  );
}
