// packs/machines/policy.ts
//
// Which SSH targets and key files agents may use. Registering a machine is an
// agent-callable tool, so where it may point cannot be the agent's decision:
// the user lists the allowed hosts (`allowedHosts`) and key files
// (`allowedIdentityFiles`) in the pack settings, which only the dashboard /
// admin API can change. Both lists are empty by default, so out of the box an
// agent can register nothing. The same check runs again every time a stored
// machine is used, so taking a host off the list cuts it off at once.
import { homedir } from "node:os";
import type { PackContext } from "plughive/pack";
import { USER_PATTERN, isValidHost } from "./shell.js";

export interface HostRule {
  user: string | null;
  host: string;
  port: number | null;
}

export interface AccessPolicy {
  hosts: HostRule[];
  identityFiles: string[];
  /** The user's allowDefaultKeys setting: machines may use ssh's default ~/.ssh keys. */
  defaultKeys: boolean;
}

export interface SshTargetLike {
  host: string;
  user: string;
  port: number;
  identityFile: string | null;
  useDefaultKeys?: boolean;
}

const WHERE = "in the dashboard (Packs > Machines > Settings)";

function normalizeHost(h: string): string {
  return h.trim().toLowerCase().replace(/\.$/, "");
}

/** `host`, `user@host`, `host:port`, `user@host:port`, `[v6]:port` or a bare IPv6 address. */
export function parseHostRule(raw: string): HostRule {
  const s = raw.trim();
  const bad = new Error(
    `allowedHosts entry "${s.slice(0, 200)}" is not host, user@host, host:port or user@host:port; fix it ${WHERE}`,
  );
  let rest = s;
  let user: string | null = null;
  const at = s.indexOf("@");
  if (at >= 0) {
    user = s.slice(0, at);
    rest = s.slice(at + 1);
    if (!USER_PATTERN.test(user)) throw bad;
  }
  let host: string;
  let port: number | null = null;
  const bracket = rest.match(/^\[([^\]]+)\](?::(\d{1,5}))?$/);
  const colons = rest.split(":").length - 1;
  if (bracket) {
    host = bracket[1]!;
    if (bracket[2] !== undefined) port = Number(bracket[2]);
  } else if (colons === 1) {
    const [h, p] = rest.split(":") as [string, string];
    if (!/^\d{1,5}$/.test(p)) throw bad;
    host = h;
    port = Number(p);
  } else {
    host = rest; // a hostname, IPv4 or bare IPv6 (no port)
  }
  if (!isValidHost(host)) throw bad;
  if (port !== null && (port < 1 || port > 65535)) throw bad;
  return { user, host: normalizeHost(host), port };
}

function listSetting(ctx: PackContext, key: string): string[] {
  const v = ctx.settings[key];
  if (v === undefined || v === null || v === "") return [];
  const raw: unknown[] | null = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : null;
  if (!raw || raw.some((x) => typeof x !== "string")) {
    throw new Error(
      `the Machines pack's "${key}" setting is not a list of strings; fix it ${WHERE}`,
    );
  }
  return (raw as string[]).map((x) => x.trim()).filter(Boolean);
}

/** "~/x" and "<home>/x" name the same file. Comparison only; nothing is opened. */
export function normalizeIdentityPath(p: string, home = homedir()): string {
  const t = p.trim();
  if (!t.startsWith("~/") && !t.startsWith("~\\")) return t;
  const sep = home.includes("\\") ? "\\" : "/";
  return `${home.replace(/[/\\]+$/, "")}${sep}${t.slice(2)}`;
}

export function policyFrom(ctx: PackContext): AccessPolicy {
  return {
    hosts: listSetting(ctx, "allowedHosts").map(parseHostRule),
    identityFiles: listSetting(ctx, "allowedIdentityFiles").map((p) => normalizeIdentityPath(p)),
    defaultKeys: ctx.settings.allowDefaultKeys === true,
  };
}

export function hostAllowed(policy: AccessPolicy, t: SshTargetLike): boolean {
  const host = normalizeHost(t.host);
  return policy.hosts.some(
    (r) =>
      r.host === host &&
      (r.user === null || r.user === t.user) &&
      (r.port === null || r.port === t.port),
  );
}

/** No identity file needs no listing (default keys are gated by allowDefaultKeys); a named key does. */
export function identityAllowed(policy: AccessPolicy, identityFile: string | null): boolean {
  if (identityFile === null) return true;
  return policy.identityFiles.includes(normalizeIdentityPath(identityFile));
}

function label(t: SshTargetLike): string {
  const host = t.host.includes(":") ? `[${t.host}]` : t.host;
  return `${t.user}@${host}:${t.port}`;
}

/**
 * Throws an actionable error unless the target's host and key are on the
 * lists. The identity file error never says whether the path exists: the pack
 * does not look, and the message is the same for every unlisted path.
 */
export function assertTargetAllowed(
  policy: AccessPolicy,
  t: SshTargetLike,
  machine?: string,
): void {
  const subject = machine === undefined ? "" : `machine "${machine}": `;
  if (!hostAllowed(policy, t)) {
    throw new Error(
      `${subject}host ${label(t)} is not allowed. Agents can only use hosts listed in the Machines pack's "allowedHosts" setting (empty by default). ` +
        `To allow it, add "${t.host}" (or "${label(t)}") to Allowed hosts ${WHERE}; agents cannot change that setting.`,
    );
  }
  if (!identityAllowed(policy, t.identityFile)) {
    throw new Error(
      `${subject}this identity_file is not allowed. Agents can only reference key files listed in the Machines pack's "allowedIdentityFiles" setting (empty by default). ` +
        `To use it, add its path to Allowed identity files ${WHERE}, or register the machine with use_agent=true instead.`,
    );
  }
  // use_default_keys is an agent input, so on its own it would let an agent
  // reach every key in ~/.ssh: the user has to allow that in the settings.
  if (t.identityFile === null && t.useDefaultKeys === true && !policy.defaultKeys) {
    throw new Error(
      `${subject}use_default_keys is not allowed. ssh's default ~/.ssh keys can be used only when the Machines pack's "allowDefaultKeys" setting is on (off by default). ` +
        `Turn on Allow default keys ${WHERE}, or use identity_file or use_agent=true; agents cannot change that setting.`,
    );
  }
}
