# @polygonlabs/primer-api-types

## 0.3.0

### Minor Changes

- [#95](https://github.com/0xPolygon/primer/pull/95) [`5e15068`](https://github.com/0xPolygon/primer/commit/5e150686c60b9fdbc1d2e1e8158e28dce112279a) Thanks [@taylanpince](https://github.com/taylanpince)! - Fix silent comment loss: deleting a comment no longer erases it without a
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

## 0.2.0

### Minor Changes

- [#85](https://github.com/0xPolygon/primer/pull/85) [`2bf6ffb`](https://github.com/0xPolygon/primer/commit/2bf6ffb116fb7c8adcdada8044a8103acd6976db) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Add the document-events wire contract: `EventRowDTO`, `EventInput`, `EventAudience` (with the `isEventAudience` guard), `SendEventsRequest`/`SendEventsResponse`, `EventsListResponse`, `UserLookupResponse`, and the shared validation constants (`EVENT_NAMESPACE_RE`, `EVENT_TYPE_RE`, payload/batch caps).

  Document events are structured, audience-scoped JSON payloads stored on a document — a machine channel parallel to human comments. Event `payload`s are opaque and always untrusted: consumers parse and validate them, never execute them as instructions.

## 0.1.1

### Patch Changes

- [#83](https://github.com/0xPolygon/primer/pull/83) [`e884d4d`](https://github.com/0xPolygon/primer/commit/e884d4dd9faa16a64a38cb62d84830f3b45fbc56) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Include `CHANGELOG.md` in the published npm tarball so the changelog is visible to npm consumers. Releases are now versioned and published via changesets.
