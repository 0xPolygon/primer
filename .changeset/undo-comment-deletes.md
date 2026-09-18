---
"@polygonlabs/primer-api-types": minor
"@primer/api": patch
"@primer/web": patch
---

Fix silent comment loss: deleting a comment no longer erases it without a
trace, and can be undone.

Nine comments across six reviewers had been destroyed by the delete affordance
in the thread card — an unlabelled 20x20px trash icon sitting 4px from the
identically-styled edit pencil, which fired immediately with no confirmation
and no undo. Because the sidebar filtered tombstoned comments out entirely, the
thread then disappeared from every version, so neither the author nor the
document owner could tell that feedback had ever existed. Every one of those
deletions was a self-delete within an hour of posting, most within minutes.

- Delete now asks for confirmation inline, and the trash is set apart from the
  edit pencil and reddened on hover instead of reading as the same control.
- Tombstoned comments render in place as a "Comment deleted" row rather than
  vanishing, matching what the MCP/agent surface (`(deleted)`) always showed.
  Thread and activity counts still only count live comments.
- The author can undo a delete for 15 minutes
  (`COMMENT_UNDO_WINDOW_MS`, newly exported from `@polygonlabs/primer-api-types`)
  via `POST /api/comments/:commentId/restore`. It is authorized exactly like
  `DELETE` — the comment's own author, on a document they can read — is
  idempotent for a comment that is already live, and returns 409
  `restore_window_expired` once the window has passed. Tombstoned bodies are
  still never disclosed over the API, including to their author.
