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
  read-only, and token connections always read-only. Access is rechecked
  after sharing changes and every minute; a document whose update can't be
  saved closes its sockets with code 4500.
- **api-types.** `Target`, `Reconciliation`, `EditOutcome`, `LiveBlockDTO`,
  `DocumentFormat`, `AgentMode`, the checkpoint, export and file DTOs,
  `DocumentDetail.format`, and the refusal codes `target_changed` and
  `republish_unsupported`.
