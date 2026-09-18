import type { CommentDTO, ThreadDTO } from '@polygonlabs/primer-api-types';
import { COMMENT_UNDO_WINDOW_MS } from '@polygonlabs/primer-api-types';

/**
 * Whether `comment`'s author may still undo its deletion.
 *
 * Mirrors the server rule in POST /api/comments/:id/restore so the Undo button
 * is offered exactly when the request would succeed. A deletedAt slightly in
 * the future (clock skew between server and browser) still counts as inside
 * the window; an unparseable timestamp counts as outside it.
 */
export function canUndoDelete(
  comment: CommentDTO,
  currentUserId: string,
  nowMs: number,
): boolean {
  if (comment.deletedAt === null) return false;
  if (comment.authorId !== currentUserId) return false;
  const deletedAtMs = Date.parse(comment.deletedAt);
  if (Number.isNaN(deletedAtMs)) return false;
  return nowMs - deletedAtMs <= COMMENT_UNDO_WINDOW_MS;
}

export interface CommentRowModel {
  comment: CommentDTO;
  /** 'deleted' rows render a tombstone placeholder — never `comment.body`,
   *  which the server blanks for tombstoned comments anyway. */
  mode: 'live' | 'deleted';
  canUndo: boolean;
}

/**
 * The rows to render for a thread, in stored order, tombstones included.
 *
 * Tombstones are kept in place deliberately: a deleted comment leaves a
 * visible "comment deleted" row rather than silently rewriting history. This
 * matches what the MCP/agent surface has always shown (format.ts renders
 * `(deleted)`), which the web UI alone used to hide.
 */
export function commentRowModels(
  thread: ThreadDTO,
  currentUserId: string,
  nowMs: number,
): CommentRowModel[] {
  return thread.comments.map((comment) => ({
    comment,
    mode: comment.deletedAt === null ? ('live' as const) : ('deleted' as const),
    canUndo: canUndoDelete(comment, currentUserId, nowMs),
  }));
}
