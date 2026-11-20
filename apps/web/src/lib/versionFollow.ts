/**
 * What the document page does when the stream reports a new version
 * (`primer.version.published`): refresh the version list, then — if it is
 * still safe — replace the view with the newest version in place.
 *
 * "Still safe" is decided AFTER the refresh, from live state, never from a
 * snapshot taken when the event arrived: the reader may start typing, open
 * a reply, or navigate elsewhere while the request is in flight. A later
 * event, a dispose (document change, unmount) or any change to the view
 * since the event arrived makes the pending callback obsolete, and an
 * obsolete callback never navigates.
 *
 * DI-friendly (refresh, state and navigation injected) so the ordering
 * around the await is testable without rendering the page.
 */
import { followNewVersion } from './viewedVersion.ts';

/** What the page shows right now, read from refs at call time. */
export interface FollowState {
  docId: string | undefined;
  /** The browser's path + query: changes as soon as a navigation starts,
   *  before the page re-renders. */
  path: string;
  /** Router location key of the last render: changes on every navigation. */
  locationKey: string;
  requestedNumber: number | undefined;
  viewedVersionId: string;
  viewedVersionNumber: number | undefined;
  /** Newest version in the freshly refreshed list (read from the cache,
   *  not from the last render, which may predate the refresh). */
  latestVersionNumber: number | undefined;
  /** Any new-comment, reply or edit input holding unsent text. */
  hasUnsentDraft: boolean;
}

export interface VersionFollowerOptions {
  /** Re-reads the version list. Its outcome doesn't matter: the decision
   *  reads `readState()` afterwards either way. */
  refreshVersions: () => Promise<unknown>;
  readState: () => FollowState;
  /** Opens /d/:docId fresh, which latches the newest version. */
  navigateToLatest: (docId: string) => void;
}

export interface VersionFollower {
  onVersionPublished(): void;
  /** Makes every pending callback obsolete (document change, unmount). */
  dispose(): void;
}

export function createVersionFollower(opts: VersionFollowerOptions): VersionFollower {
  let generation = 0;
  let disposed = false;

  return {
    onVersionPublished(): void {
      if (disposed) return;
      const token = ++generation;
      const atEvent = opts.readState();
      const settle = (): void => {
        // A later event's callback supersedes this one.
        if (disposed || token !== generation) return;
        const now = opts.readState();
        if (
          now.docId === undefined ||
          now.docId !== atEvent.docId ||
          now.path !== atEvent.path ||
          now.locationKey !== atEvent.locationKey ||
          now.viewedVersionId !== atEvent.viewedVersionId
        ) {
          return;
        }
        // Nothing newer than the view (e.g. a replayed old event).
        if (
          now.latestVersionNumber === undefined ||
          now.viewedVersionNumber === undefined ||
          now.latestVersionNumber <= now.viewedVersionNumber
        ) {
          return;
        }
        if (!followNewVersion({ requestedNumber: now.requestedNumber, hasUnsentDraft: now.hasUnsentDraft })) return;
        opts.navigateToLatest(now.docId);
      };
      opts.refreshVersions().then(settle, settle);
    },
    dispose(): void {
      disposed = true;
    },
  };
}
