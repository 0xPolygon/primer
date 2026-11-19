---
"@primer/api": minor
"@primer/web": minor
"@polygonlabs/primer-api-types": minor
---

Foundations for live documents: storage, one write path and live sync. No
user-visible change yet; the Markdown editor builds on this.

- **Dependencies.** BlockNote 0.57.0 (MPL-2.0), Yjs, y-prosemirror and
  Hocuspocus 4.8.0 (MIT), pinned exactly. A new private package,
  `@primer/blocks`, holds the one BlockNote schema the API and the web app
  share. `codegen-drift-check` now fails if any GPL `@blocknote/xl-*` package
  is installed, declared or imported.
- **Storage.** A live document's Y.Doc is an update log (`doc_updates`, each
  row attributed to its actor and run, with the blocks it touched) plus a
  compacted snapshot (`doc_snapshots`). `documents` gain `format` (null for
  legacy HTML documents), `metadata` and `agent_mode`; `versions` gain
  `bundle_key` and `doc_version` for checkpoints; `doc_files` holds uploads
  placed in documents.
- **One write path.** Every server write to a live document goes through
  `applyPlan`: preconditions on block versions, all changes built before any
  is written, comment and suggestion marks on untouched content kept, and a
  result in one format (`Reconciliation`).
- **Live sync.** Hocuspocus runs inside the API at `/collab`, authenticated
  with Primer's own sessions and tokens. Browser credentials are accepted only
  from the app's own origin; owners and editors connect read-write, readers
  read-only, and token connections always read-only. Revoking a token,
  logging out, removing or demoting a collaborator, changing visibility or
  deleting the document closes the affected sockets at once (code 4403); a
  timer rechecks bearer connections every 10 s and others every minute. A
  document whose update can't be saved closes its sockets with code 4500.
- **api-types.** `Target`, `Reconciliation`, `EditOutcome`, `LiveBlockDTO`,
  `DocumentFormat`, `AgentMode`, the checkpoint, export and file DTOs,
  `DocumentDetail.format`, and the refusal codes `target_changed` and
  `republish_unsupported`.
- **Event streams honour revocation.** The per-document and owner (`scope=me`)
  SSE streams re-resolve their credentials on every recheck and close as soon
  as the token is revoked, the session ends or access is removed, through the
  same registry as live-sync sockets (`auth/revocation.ts`). Before, the owner
  stream never re-checked its credentials.
