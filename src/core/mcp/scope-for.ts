// src/core/mcp/scope-for.ts
//
// The one place that turns a profile id into the scope a tool call runs in.
// A call made inline from /mcp, one made inline from /api/tools and one that
// waited on the job queue all go through it, so a tool reached from inside a
// pack is allowed or refused the same way whichever road the call took.
//
// Capability providers follow the profile too. A provider (fal for
// image.generate, elevenlabs for speech, ...) runs with its own pack's keys,
// so a profile that hides a pack must not be able to spend through it: any
// profile, the default one included, reaches the providers of a pack only
// when the profile exposes at least one tool of that pack (or names it with a
// selector and does not exclude it). Host code with no scope reaches every
// provider.
//
// A provider outside the profile is not routed to, not listed, and an explicit
// `provider` naming it is answered like one that does not exist.
import { type Profile, profileExposesPack, resolveExposure } from "../profiles.js";
import type { RegisteredTool } from "../tools/registry.js";
import { DEFAULT_PROFILE_ID, type RequestScope } from "./scope.js";

export interface ScopeBuilderOptions {
  registry: { list(): RegisteredTool[] };
  /** Looks a profile up by id. Absent: no profiles, nothing is restricted. */
  profile?: (id: string) => Profile | undefined;
  /** The daemon's own origin. */
  baseUrl?: () => string | undefined;
}

export type ScopeFor = (profileId: string | undefined) => RequestScope;

export function createScopeBuilder(opts: ScopeBuilderOptions): ScopeFor {
  return (profileId) => {
    const id = profileId ?? DEFAULT_PROFILE_ID;
    const baseUrl = opts.baseUrl?.();
    const scope: RequestScope = { profileId: id, ...(baseUrl ? { baseUrl } : {}) };
    if (!opts.profile) return scope;
    const lookup = opts.profile;
    return {
      ...scope,
      // Looked up at the time of the nested call: a profile edited or deleted
      // while the call runs takes effect at once, and a deleted one reaches nothing.
      allows: (name) => {
        const profile = lookup(id);
        if (!profile) return false;
        return resolveExposure(profile, opts.registry).exposed.some((t) => t.name === name);
      },
      // Every profile, the default one included: its excludes also stop
      // capability provider routing (the default ships with none, so it still
      // reaches every provider).
      allowsProviderPack: (packId: string) => {
        const profile = lookup(id);
        if (!profile) return false;
        return profileExposesPack(profile, opts.registry, packId);
      },
    };
  };
}
