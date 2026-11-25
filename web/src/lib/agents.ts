// The MCP clients the daemon has heard from (GET /api/info `agents`). While
// `watch` is on and nobody has connected yet, /api/info is re-read every few
// seconds so "Connected agents: 0" turns into a name without a reload.
import { useEffect } from "react";
import { useApp } from "./app-context";
import { agentNames } from "./onboarding";

export function useAgents(
  watch: boolean,
  opts: { profile?: string; everyMs?: number } = {},
): string[] {
  const { info, reloadInfo } = useApp();
  const all = info?.agents ?? [];
  const names = agentNames(opts.profile ? all.filter((a) => a.profile === opts.profile) : all);
  const waiting = watch && names.length === 0;
  const every = opts.everyMs ?? 3000;
  useEffect(() => {
    if (!waiting) return;
    const t = window.setInterval(() => {
      if (!document.hidden) reloadInfo();
    }, every);
    return () => window.clearInterval(t);
  }, [waiting, every, reloadInfo]);
  return names;
}
