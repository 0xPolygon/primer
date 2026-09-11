/**
 * Keeps a document's version list live for a collaborator who leaves the
 * page open (issue: reader pinned to v1 never saw v2 exist until a manual
 * refresh — the version fetch only ever ran once, on mount). There's no
 * server push for this (unlike the SSE-backed document-events channel);
 * `POST /api/documents/:docId/versions` doesn't publish anywhere the page
 * already listens, and stapling a "version published" notification onto
 * that consent-gated, audience-scoped channel (apps/api/src/lib/events.ts)
 * would conflate a system notification with the artifact data model it's
 * built for. So: poll while the tab is visible, and refresh immediately the
 * moment it becomes visible/focused again rather than waiting out the
 * interval — see queries/versions.ts for the useQuery wiring.
 *
 * Kept pure and DOM-free so the policy is unit-testable; the visibility/
 * focus listeners themselves aren't (no DOM in this repo's web test env —
 * see eventsFeed.ts for the same split applied to the events stream).
 */
export const VERSIONS_POLL_INTERVAL_MS = 30_000;

/** react-query's `refetchInterval` for the given tab-visibility state: poll
 *  while visible, back off (no wasted requests) while hidden. */
export function versionsRefetchInterval(hidden: boolean): number | false {
  return hidden ? false : VERSIONS_POLL_INTERVAL_MS;
}

/** True exactly when a visibility/focus event marks the tab BECOMING visible
 *  again — the moment to refresh immediately instead of waiting for the next
 *  poll tick. */
export function becameVisible(wasHidden: boolean, isHiddenNow: boolean): boolean {
  return wasHidden && !isHiddenNow;
}
