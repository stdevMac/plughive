// src/core/mcp/scope.ts
//
// What the daemon knows about the request (or background job) a tool is
// running for. It travels in an AsyncLocalStorage so the tools that reach
// other things (job status, capability routing) can stay inside the caller's
// exposure profile without every signature carrying it.
import { AsyncLocalStorage } from "node:async_hooks";

export const DEFAULT_PROFILE_ID = "default";

/** What the HTTP layer knows about the request being served. */
export interface RequestScope {
  /** Profile id from /p/<id>/mcp. Absent: the default profile. */
  profileId?: string;
  /** The daemon's own origin, e.g. http://127.0.0.1:7777. Never taken from the request. */
  baseUrl?: string;
  /** True when `tool` is exposed in the caller's profile. Absent: no restriction. */
  allows?: (tool: string) => boolean;
  /**
   * True when capability providers of the pack `packId` may be routed to (and
   * listed) for this caller. Absent: no restriction. The rule lives in
   * scope-for.ts: a named profile only reaches providers of packs it exposes.
   */
  allowsProviderPack?: (packId: string) => boolean;
}

export const requestScope = new AsyncLocalStorage<RequestScope>();

export function currentScope(): RequestScope | undefined {
  return requestScope.getStore();
}

/**
 * Whether a caller on `callerProfile` may see a job started from `jobProfile`.
 * The default profile is the single user's own view and sees every job; any
 * other profile only sees the jobs it started.
 */
export function canSeeJob(
  jobProfile: string | null | undefined,
  callerProfile: string | undefined,
): boolean {
  const caller = callerProfile ?? DEFAULT_PROFILE_ID;
  if (caller === DEFAULT_PROFILE_ID) return true;
  return jobProfile === caller;
}

/** Same check, against the scope of the running request. No scope: host code, sees everything. */
export function currentScopeSeesJob(jobProfile: string | null | undefined): boolean {
  const scope = requestScope.getStore();
  if (!scope) return true;
  return canSeeJob(jobProfile, scope.profileId);
}

/** True when the running request may reach `tool`. No scope or no restriction: yes. */
export function currentScopeAllows(tool: string): boolean {
  const allows = requestScope.getStore()?.allows;
  return allows ? allows(tool) : true;
}

/**
 * True when the running request may be routed to capability providers of
 * `packId`. No scope (host code, the admin API) or no restriction: yes.
 */
export function currentScopeAllowsProviderPack(packId: string): boolean {
  const allows = requestScope.getStore()?.allowsProviderPack;
  return allows ? allows(packId) : true;
}

/** True when the running request is limited to some providers (a named profile). */
export function currentScopeLimitsProviders(): boolean {
  return requestScope.getStore()?.allowsProviderPack !== undefined;
}
