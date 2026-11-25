// Pure rules for the unsaved-changes guard used by the router.

export interface Blocker {
  id: number;
  when: boolean;
}

/** The path part of an in-app URL, without a trailing slash. */
export function pathOf(url: string): string {
  const base = url.split(/[?#]/, 1)[0] ?? "";
  return base.replace(/\/+$/, "") || "/";
}

/**
 * The blocker that stops a move from `from` to `to`, or null to let it
 * through. Only leaving the page is guarded: query changes on the same page
 * (switching a profile tab) are the page's own business.
 */
export function blockingFor<B extends Blocker>(
  blockers: Iterable<B>,
  from: string,
  to: string,
): B | null {
  if (pathOf(from) === pathOf(to)) return null;
  let found: B | null = null;
  for (const b of blockers) if (b.when) found = b;
  return found;
}
