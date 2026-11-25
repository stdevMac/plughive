// Building the body for POST /api/mounts from the "Add your own" form.
import { t } from "../i18n";

export interface AddDraft {
  transport: "http" | "stdio";
  id: string;
  name: string;
  prefix: string;
  url: string;
  header: string;
  headerValue: string;
  command: string;
  args: string;
}

export const EMPTY_MOUNT: AddDraft = {
  transport: "http",
  id: "",
  name: "",
  prefix: "",
  url: "",
  header: "",
  headerValue: "",
  command: "",
  args: "",
};

export function slug(s: string, max = 32): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, max)
    .replace(/-+$/, "");
}

/** Splits a line of arguments on spaces, keeping "quoted parts" together. */
export function splitArgs(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
}

export function mountBody(d: AddDraft): Record<string, unknown> {
  const id = d.id || slug(d.name);
  const body: Record<string, unknown> = {
    id,
    transport: d.transport,
    prefix: d.prefix || id.replace(/-/g, "_").slice(0, 32),
  };
  if (d.name.trim()) body.name = d.name.trim();
  if (d.transport === "http") {
    body.url = d.url.trim();
    if (d.header.trim()) body.headers = { [d.header.trim()]: d.headerValue };
  } else {
    body.command = d.command.trim();
    const args = splitArgs(d.args);
    if (args.length) body.args = args;
  }
  return body;
}

// ---- status of a mount ---------------------------------------------------------

/** The text the daemon reports for an OAuth mount that has no usable sign-in. */
export const NEEDS_SIGN_IN = "needs sign-in";

export interface MountStatusView {
  enabled: boolean;
  connected: boolean;
  error: string | null;
  secrets: Array<{ present: boolean }>;
  oauth?: { signedIn: boolean; pending: boolean } | null;
}

export type MountTone = "ok" | "warn" | "danger" | "neutral";

/** Whether an OAuth mount needs the user to sign in (again). */
export function needsSignIn(m: MountStatusView): boolean {
  if (!m.oauth) return false;
  return !m.oauth.signedIn || (m.enabled && m.error === NEEDS_SIGN_IN);
}

/** The status badge of a mount; null when the switch already says it (off, nothing to do). */
export function mountState(m: MountStatusView): { text: string; tone: MountTone } | null {
  if (m.oauth?.pending && needsSignIn(m))
    return { text: t("mounts.state.waitingForSignIn"), tone: "neutral" };
  if (needsSignIn(m))
    return m.enabled
      ? { text: t("mounts.state.needsSignIn"), tone: "warn" }
      : { text: t("mounts.state.notSignedIn"), tone: "neutral" };
  // Off is said by the switch; no second badge for it.
  if (!m.enabled)
    return m.oauth?.signedIn ? { text: t("mounts.state.signedIn"), tone: "neutral" } : null;
  if (m.error) return { text: t("mounts.state.cannotConnect"), tone: "danger" };
  if (m.secrets.some((s) => !s.present)) return { text: t("mounts.state.needsKey"), tone: "warn" };
  if (m.connected) return { text: t("mounts.state.connected"), tone: "ok" };
  return { text: t("mounts.state.connecting"), tone: "neutral" };
}
