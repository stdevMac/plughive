import { createContext, useContext } from "react";
import type { DaemonInfo } from "./types";

export interface AppContextValue {
  info: DaemonInfo | null;
  reloadInfo(): void;
  /** Whether this daemon has dashboard sign-in (GET /api/session exists). */
  sessionSupported: boolean;
  signOut(): Promise<void>;
  /** Bumped when packs, secrets or tools change, so screens can reload. */
  catalogVersion: number;
  catalogChanged(): void;
  /** Open the shared "Connect an agent" dialog. */
  openConnect(): void;
  openPalette(): void;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const v = useContext(AppContext);
  if (!v) throw new Error("useApp outside AppContext");
  return v;
}

/** The MCP endpoint URL for a profile ("default" is the plain /mcp). */
export function endpointFor(info: DaemonInfo | null, profile = "default"): string {
  const base = info?.base_url ?? window.location.origin;
  if (profile === "default") return info?.mcp_url ?? `${base}/mcp`;
  return (info?.profile_url_template ?? `${base}/p/{profile}/mcp`).replace(
    "{profile}",
    encodeURIComponent(profile),
  );
}
