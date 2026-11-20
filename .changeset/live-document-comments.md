---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
"@polygonlabs/primer-mcp": minor
"@polygonlabs/plugin-primer": minor
---

Comments on live documents.

- **Threads on live content.** `GET|POST /api/documents/:docId/threads` list
  and start threads on a live document. A thread there belongs to the live
  content (`versionId: null`); a text comment's position is BlockNote's
  `comment` mark, which the server places through the apply pipeline over the
  editor's selection (Yjs relative positions) or over an exact quote. Nothing
  is written when the mark can't be placed (409 `target_missing` or
  `quote_not_found`), and a commenter's read-only live connection is never
  written by the browser.
- **Text removed.** A thread whose commented text is deleted stays open with
  its quote, is listed with `orphaned: true` and a `primer.thread.orphaned`
  event, and clears when the text comes back.
  `POST /api/threads/:threadId/reanchor` moves it onto a selection or a quote.
- **Reactions.** `POST|DELETE /api/comments/:commentId/reactions/:emoji`;
  `CommentDTO.reactions` lists each emoji with who reacted.
- **Anchors.** api-types adds the live anchors (`prose`, `widget-part`,
  `data-point`, `block`), `ThreadAnchor`, `isValidAnchor` and `anchorLabel`;
  `ThreadDTO.versionId`/`versionNumber` may be null and `ThreadDTO.orphaned`
  is new; `PrimerCommentCreatedPayload.version_id` may be null.
- **MCP.** `primer_create_thread` (comment on quoted text in a block) and
  `primer_reanchor_thread`; the comment tools list live threads under `live`
  with `orphaned`.
