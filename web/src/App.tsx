// The shell: sign-in gate, sidebar, routes.
import {
  type ReactNode,
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { CommandPalette, type PalettePage, isPaletteShortcut } from "./components/CommandPalette";
import { ConnectAgent } from "./components/ConnectAgent";
import { Dialog } from "./components/Dialog";
import { Icon, type IconName } from "./components/Icon";
import { LanguagePicker } from "./components/LanguagePicker";
import { ToastProvider } from "./components/Toast";
import { Button, IconButton, Spinner } from "./components/ui";
import { t } from "./i18n";
import { forgetDaemonSession, syncLocaleFromDaemon } from "./i18n/sync";
import {
  ApiError,
  api,
  signOut as apiSignOut,
  errorMessage,
  getSession,
  signIn,
  takeTokenFromLocation,
} from "./lib/api";
import { AppContext, type AppContextValue } from "./lib/app-context";
import { type ApprovalsResponse, pendingAfter } from "./lib/approvals";
import { closeEvents, useEvent } from "./lib/events";
import { Link, RouterProvider, useRouter } from "./lib/router";
import type { DaemonInfo } from "./lib/types";
import { HomePage } from "./pages/Home";
import { SignIn, signInErrorMessage } from "./pages/SignIn";

// Home is in the first bundle; every other page loads when it is first opened,
// so the dashboard starts with a fraction of the script to parse.
const PAGE_LOADERS: Array<() => Promise<unknown>> = [];
function page<K extends string, M extends Record<K, () => ReactNode>>(
  load: () => Promise<M>,
  name: K,
) {
  PAGE_LOADERS.push(load);
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
/** Fetches every page's script once the browser is idle, so later clicks are instant. */
function preloadPages(): void {
  const run = () => {
    for (const load of PAGE_LOADERS) void load().catch(() => undefined);
  };
  if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 3000 });
  else setTimeout(run, 1500);
}

/** Shown only when a page takes a moment to load, so fast loads never flash. */
function PageLoading() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setShow(true), 200);
    return () => clearTimeout(timer);
  }, []);
  return show ? (
    <div className="page-loading">
      <Spinner label={t("common.app.pageLoading")} />
    </div>
  ) : null;
}
const ApprovalsPage = page(() => import("./pages/Approvals"), "ApprovalsPage");
const CapabilitiesPage = page(() => import("./pages/Capabilities"), "CapabilitiesPage");
const ExposurePage = page(() => import("./pages/Exposure"), "ExposurePage");
const JobsPage = page(() => import("./pages/Jobs"), "JobsPage");
const LibraryPage = page(() => import("./pages/Library"), "LibraryPage");
const MountsPage = page(() => import("./pages/Mounts"), "MountsPage");
const PacksPage = page(() => import("./pages/Packs"), "PacksPage");
const PlaygroundPage = page(() => import("./pages/Playground"), "PlaygroundPage");
const SettingsPage = page(() => import("./pages/Settings"), "SettingsPage");
const SoftwarePage = page(() => import("./pages/Software"), "SoftwarePage");
const TriggersPage = page(() => import("./pages/Triggers"), "TriggersPage");
const UsagePage = page(() => import("./pages/Usage"), "UsagePage");

interface NavItem {
  path: string;
  label: string;
  /** The precise term, shown as a tooltip and found by the palette. */
  term?: string;
  keywords?: string;
  icon: IconName;
  page: () => ReactNode;
  /** Shows the count of approvals waiting. */
  pendingBadge?: boolean;
}

// Daily pages first; one-time setup below. Built at render time, so switching
// the language relabels the sidebar and the palette.
function navGroups(): Array<{ group: string | null; items: NavItem[] }> {
  return [
    {
      group: null,
      items: [
        {
          path: "/",
          label: t("common.app.nav.home"),
          icon: "home",
          keywords: "overview status",
          page: () => <HomePage />,
        },
        {
          path: "/playground",
          label: t("common.app.nav.playground"),
          icon: "play",
          keywords: "try run tool",
          page: () => <PlaygroundPage />,
        },
        {
          path: "/library",
          label: t("common.app.nav.library"),
          icon: "image",
          keywords: "files images video audio gallery artifacts",
          page: () => <LibraryPage />,
        },
        {
          path: "/jobs",
          label: t("common.app.nav.jobs"),
          icon: "list",
          keywords: "running tasks failed",
          page: () => <JobsPage />,
        },
        {
          path: "/triggers",
          label: t("common.app.nav.triggers"),
          term: t("common.app.nav.triggersTerm"),
          icon: "clock",
          keywords: "cron schedule webhook automation recurring",
          page: () => <TriggersPage />,
        },
        {
          path: "/usage",
          label: t("common.app.nav.usage"),
          icon: "chart",
          keywords: "spend cost calls",
          page: () => <UsagePage />,
        },
        {
          path: "/approvals",
          label: t("common.app.nav.approvals"),
          term: t("common.app.nav.approvalsTerm"),
          keywords: "approve deny spend cap budget pending",
          icon: "shield",
          page: () => <ApprovalsPage />,
          pendingBadge: true,
        },
      ],
    },
    {
      group: t("common.app.nav.groupSetup"),
      items: [
        {
          path: "/packs",
          label: t("common.app.nav.packs"),
          term: t("common.app.nav.packsTerm"),
          keywords: "secret api key provider",
          icon: "key",
          page: () => <PacksPage />,
        },
        {
          path: "/software",
          label: t("common.app.nav.software"),
          term: t("common.app.nav.softwareTerm"),
          keywords: "install ffmpeg yt-dlp whisper ollama program setup plan goal",
          icon: "package",
          page: () => <SoftwarePage />,
        },
        {
          path: "/exposure",
          label: t("common.app.nav.exposure"),
          term: t("common.app.nav.exposureTerm"),
          keywords: "tool access profile",
          icon: "layers",
          page: () => <ExposurePage />,
        },
        {
          path: "/mounts",
          label: t("common.app.nav.mounts"),
          term: t("common.app.nav.mountsTerm"),
          keywords: "mcp server mount",
          icon: "plug",
          page: () => <MountsPage />,
        },
        {
          path: "/capabilities",
          label: t("common.app.nav.capabilities"),
          term: t("common.app.nav.capabilitiesTerm"),
          keywords: "provider order capability",
          icon: "route",
          page: () => <CapabilitiesPage />,
        },
      ],
    },
  ];
}

function settingsItem(): NavItem {
  return {
    path: "/settings",
    label: t("common.app.nav.settings"),
    icon: "settings",
    keywords: "theme appearance endpoint sign out",
    page: () => <SettingsPage />,
  };
}
const IS_MAC =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function NotFound() {
  return (
    <div className="not-found">
      <h1 id="page-title" tabIndex={-1}>
        {t("common.app.notFoundTitle")}
      </h1>
      <p className="muted">{t("common.app.notFoundBody")}</p>
      <Link to="/" className="btn btn-primary">
        {t("common.app.notFoundHome")}
      </Link>
    </div>
  );
}

/** Approvals waiting: loaded once, then kept current by the event stream. */
function usePendingApprovals(): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    let live = true;
    api
      .get<ApprovalsResponse>("/api/approvals", { status: "pending", limit: 1 })
      .then((r) => {
        if (live) setN(r.pending);
      })
      .catch(() => {
        // No badge when the list cannot be read.
      });
    return () => {
      live = false;
    };
  }, []);
  useEvent("approval", (e) => setN((prev) => pendingAfter(prev, e)));
  return n;
}

function NavLink({
  item,
  current,
  onNavigate,
  pending = 0,
}: { item: NavItem; current: boolean; onNavigate: () => void; pending?: number }) {
  return (
    <li>
      <Link
        to={item.path}
        className={current ? "nav-link nav-link-on" : "nav-link"}
        aria-current={current ? "page" : undefined}
        title={item.term}
        onClick={onNavigate}
      >
        <Icon name={item.icon} />
        <span className="nav-text">{item.label}</span>
        {item.pendingBadge && pending > 0 ? (
          <span
            className="nav-count"
            aria-label={t("common.app.nav.pendingWaiting", { count: pending })}
          >
            {pending > 99 ? "99+" : pending}
          </span>
        ) : null}
      </Link>
    </li>
  );
}

function Shell({
  palette,
  setPalette,
  connect,
  setConnect,
}: {
  palette: boolean;
  setPalette: (v: boolean) => void;
  connect: boolean;
  setConnect: (v: boolean) => void;
}) {
  const { path } = useRouter();
  const [menuOpen, setMenuOpen] = useState(false);
  const pendingApprovals = usePendingApprovals();
  const groups = navGroups();
  const settings = settingsItem();
  const all = [...groups.flatMap((g) => g.items), settings];
  const palettePages: PalettePage[] = all.map(({ path, label, term, icon, keywords }) => ({
    path,
    label,
    icon,
    ...(term ? { term } : {}),
    ...(keywords ? { keywords } : {}),
  }));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isPaletteShortcut(e)) {
        e.preventDefault();
        setPalette(!palette);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [palette, setPalette]);
  const first = useRef(true);
  const active = all.find((i) =>
    i.path === "/" ? path === "/" : path === i.path || path.startsWith(`${i.path}/`),
  );

  useEffect(preloadPages, []);

  // Move focus to the new page's title, so screen readers announce it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on path change
  useEffect(() => {
    setMenuOpen(false);
    if (first.current) {
      first.current = false;
      return;
    }
    // A page opened for the first time may still be loading: wait for its title
    // (up to two seconds), then focus it.
    let frame = 0;
    const until = Date.now() + 2000;
    const tryFocus = () => {
      const title = document.getElementById("page-title");
      if (title) title.focus({ preventScroll: true });
      else if (Date.now() < until) frame = requestAnimationFrame(tryFocus);
    };
    const timer = setTimeout(tryFocus, 0);
    return () => {
      clearTimeout(timer);
      cancelAnimationFrame(frame);
    };
  }, [path]);

  const close = () => setMenuOpen(false);
  // Escape closes the mobile menu, unless a dialog or the palette took the key first.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setMenuOpen(false);
      document.querySelector<HTMLElement>('.topbar [aria-controls="sidebar"]')?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  return (
    <div className="shell">
      <a href="#main" className="skip-link">
        {t("common.app.skipToContent")}
      </a>
      <header className="topbar">
        <IconButton
          icon="menu"
          label={menuOpen ? t("common.app.nav.closeMenu") : t("common.app.nav.openMenu")}
          variant="ghost"
          aria-expanded={menuOpen}
          aria-controls="sidebar"
          onClick={() => setMenuOpen((o) => !o)}
        />
        <span className="brand">
          <span className="brand-mark" aria-hidden="true">
            <Icon name="package" size={14} />
          </span>
          plughive
        </span>
      </header>
      <nav
        id="sidebar"
        className={menuOpen ? "sidebar sidebar-open" : "sidebar"}
        aria-label={t("common.app.nav.ariaLabel")}
      >
        <Link to="/" className="brand sidebar-brand" onClick={close}>
          <span className="brand-mark" aria-hidden="true">
            <Icon name="package" size={14} />
          </span>
          plughive
        </Link>
        <button
          type="button"
          className="palette-trigger"
          onClick={() => setPalette(true)}
          aria-keyshortcuts={IS_MAC ? "Meta+K" : "Control+K"}
        >
          <Icon name="search" />
          <span>{t("common.app.nav.search")}</span>
          <kbd className="kbd">{IS_MAC ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <div className="nav-groups">
          {groups.map((g, gi) => (
            <div key={g.group ?? "top"} className="nav-group">
              {g.group ? (
                <div className="nav-group-label" id={`nav-${gi}`}>
                  {g.group}
                </div>
              ) : null}
              <ul aria-labelledby={g.group ? `nav-${gi}` : undefined}>
                {g.items.map((i) => (
                  <NavLink
                    key={i.path}
                    item={i}
                    current={active === i}
                    onNavigate={close}
                    pending={pendingApprovals}
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
        <ul className="nav-foot">
          <NavLink item={settings} current={active === settings} onNavigate={close} />
          <li className="nav-lang">
            <LanguagePicker />
          </li>
        </ul>
      </nav>
      {menuOpen ? (
        // biome-ignore lint/a11y/useKeyWithClickEvents: click-outside scrim; Escape closes the menu from the keyboard
        <div className="scrim" aria-hidden="true" onClick={close} />
      ) : null}
      <main id="main" className="main" tabIndex={-1}>
        <div className="content">
          <Suspense fallback={<PageLoading />}>{active ? active.page() : <NotFound />}</Suspense>
        </div>
      </main>
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        pages={palettePages}
        onConnect={() => setConnect(true)}
      />
      <Dialog
        open={connect}
        onClose={() => setConnect(false)}
        size="lg"
        title={t("common.app.connectTitle")}
        description={t("common.app.connectDescription")}
      >
        <ConnectAgent />
      </Dialog>
    </div>
  );
}

type Gate =
  | { kind: "checking" }
  | { kind: "signin"; error: string | null }
  | { kind: "in"; supported: boolean }
  | { kind: "down"; error: string };

export function App() {
  const [gate, setGate] = useState<Gate>({ kind: "checking" });
  const [info, setInfo] = useState<DaemonInfo | null>(null);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [palette, setPalette] = useState(false);
  const [connect, setConnect] = useState(false);

  const check = useCallback(async () => {
    setGate({ kind: "checking" });
    let tokenError: string | null = null;
    const token = takeTokenFromLocation();
    if (token) {
      try {
        await signIn(token);
      } catch (e) {
        // A 404 means this daemon has no dashboard sign-in; carry on.
        if (!(e instanceof ApiError && (e.status === 404 || e.status === 405)))
          tokenError = signInErrorMessage(e);
      }
    }
    try {
      const s = await getSession();
      setGate(
        s.authenticated
          ? { kind: "in", supported: s.supported }
          : { kind: "signin", error: tokenError },
      );
    } catch (e) {
      setGate({ kind: "down", error: errorMessage(e) });
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // The menu-bar app re-opens the sign-in link after the daemon restarts. On a
  // page whose address only differs by the #token part the browser does not
  // reload, so pick the token up here too.
  useEffect(() => {
    const onHash = () => {
      if (/(^#|&)token=/.test(window.location.hash)) void check();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [check]);

  // Any 401 later on (session expired, daemon restarted) goes back to sign-in.
  useEffect(
    () =>
      api.onUnauthorized(() => {
        closeEvents();
        setGate((g) =>
          g.kind === "in" && g.supported
            ? { kind: "signin", error: t("common.app.sessionEnded") }
            : g,
        );
      }),
    [],
  );

  const reloadInfo = useCallback(() => {
    api
      .get<DaemonInfo>("/api/info")
      // Home re-reads this every few seconds while waiting for an agent: keep the
      // same object when nothing changed so the whole app does not re-render.
      .then((next) =>
        setInfo((cur) => (cur && JSON.stringify(cur) === JSON.stringify(next) ? cur : next)),
      )
      .catch(() => setInfo((cur) => cur));
  }, []);

  useEffect(() => {
    if (gate.kind === "in") {
      reloadInfo();
      void syncLocaleFromDaemon();
    }
  }, [gate.kind, reloadInfo]);

  const value = useMemo<AppContextValue>(
    () => ({
      info,
      reloadInfo,
      sessionSupported: gate.kind === "in" && gate.supported,
      async signOut() {
        await apiSignOut();
        closeEvents();
        forgetDaemonSession();
        setInfo(null);
        setGate({ kind: "signin", error: null });
      },
      catalogVersion,
      catalogChanged: () => setCatalogVersion((v) => v + 1),
      openConnect: () => setConnect(true),
      openPalette: () => setPalette(true),
    }),
    [info, reloadInfo, gate, catalogVersion],
  );

  let body: ReactNode;
  if (gate.kind === "checking") {
    body = (
      <main className="center-screen" id="main">
        <Spinner label={t("common.app.connecting")} />
      </main>
    );
  } else if (gate.kind === "down") {
    body = (
      <main className="center-screen" id="main">
        <div className="signin-card">
          <h1>{t("common.app.cannotReach")}</h1>
          <p className="muted">{gate.error}</p>
          <p className="small muted">{t("common.app.cannotReachHint")}</p>
          <Button variant="primary" icon="refresh" onClick={() => void check()}>
            {t("common.app.tryAgain")}
          </Button>
        </div>
      </main>
    );
  } else if (gate.kind === "signin") {
    body = <SignIn initialError={gate.error} onSignedIn={() => void check()} />;
  } else {
    body = (
      <AppContext.Provider value={value}>
        <Shell
          palette={palette}
          setPalette={setPalette}
          connect={connect}
          setConnect={setConnect}
        />
      </AppContext.Provider>
    );
  }

  return (
    <ToastProvider>
      <RouterProvider>{body}</RouterProvider>
    </ToastProvider>
  );
}
