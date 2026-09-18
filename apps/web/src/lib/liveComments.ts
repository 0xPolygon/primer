import type { CommentDTO, ThreadDTO } from '@polygonlabs/primer-api-types';

/** All comments in the thread that have NOT been tombstoned (deletedAt is null). */
export function liveComments(thread: ThreadDTO): CommentDTO[] {
  return thread.comments.filter((c) => c.deletedAt === null);
}

/** True when at least one comment in the thread is non-tombstoned. Use this
 *  for counting real feedback, not for deciding whether to render a thread —
 *  see hasAnyComments. */
export function hasLiveComments(thread: ThreadDTO): boolean {
  return thread.comments.some((c) => c.deletedAt === null);
}

/**
 * True when the thread has any comment at all, tombstoned or not.
 *
 * This is the render predicate. Filtering on hasLiveComments instead used to
 * make a thread vanish from the sidebar the instant its last comment was
 * deleted, so a delete left no trace anywhere in the UI and the document owner
 * never learned that feedback had existed.
 */
export function hasAnyComments(thread: ThreadDTO): boolean {
  return thread.comments.length > 0;
}
