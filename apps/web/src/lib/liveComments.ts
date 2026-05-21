import type { CommentDTO, ThreadDTO } from '@primer/shared';

/** All comments in the thread that have NOT been tombstoned (deletedAt is null). */
export function liveComments(thread: ThreadDTO): CommentDTO[] {
  return thread.comments.filter((c) => c.deletedAt === null);
}

/** True when at least one comment in the thread is non-tombstoned. */
export function hasLiveComments(thread: ThreadDTO): boolean {
  return thread.comments.some((c) => c.deletedAt === null);
}
