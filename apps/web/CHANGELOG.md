# @primer/web

## 0.3.1

### Patch Changes

- [#93](https://github.com/0xPolygon/primer/pull/93) [`885e37d`](https://github.com/0xPolygon/primer/commit/885e37d520fa7817bbd65628a19f3dc7fbeef1f2) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Fix two issues on the document page: a comment that fails to post (for
  example, because someone published a newer version while you were writing
  it) now shows a clear error message instead of silently disappearing — and
  if the reason is that a newer version exists, you get a "Switch to latest
  version" button. Separately, the version switcher now keeps itself current
  while you have a document open: it refreshes automatically when the tab
  regains focus and every 30 seconds while visible, so a newly published
  version shows up without needing a manual page refresh. The version you're
  currently viewing never changes on its own: when a newer version is published
  while you have the document open, a notice offers to switch to it, and a
  comment you're writing stays open with its text.

  Publishing a new version from the document page now lands you on that new version, instead of the previous one with a "newer version" notice about your own upload.

- Updated dependencies [[`d653b18`](https://github.com/0xPolygon/primer/commit/d653b185f5f6cd7ebca107d30a55d9b314ec2502)]:
  - @polygonlabs/primer-api-types@0.5.1

## 0.3.0

### Minor Changes

- [#125](https://github.com/0xPolygon/primer/pull/125) [`535a4cb`](https://github.com/0xPolygon/primer/commit/535a4cba7f6a458042b19dd7b3c7084703e8c09a) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Adds a `responder` collaborator role that can read, comment and submit document events but cannot publish versions or rename; commenters can no longer submit events.

  Commenters keep reading `collaborators`- and `artifact`-audience events. Events never grant or change permissions: roles change only through the collaborators API, by the document owner.

  Event namespace validation messages now use a neutral example namespace (`example`, `example/telemetry`, `example/*`) in their hints.

  On a document page, a viewer whose role cannot write events (a commenter, or an org reader who is not a collaborator) is no longer asked to consent to a submission the server would refuse: the page answers the document's request with "You can view this document but can't respond to it."

  An open event stream now re-checks the reader's access while it is open: a removed collaborator's open stream stops receiving rows (and closes when they can no longer read the document), and a deleted document's open streams close.

### Patch Changes

- Updated dependencies [[`535a4cb`](https://github.com/0xPolygon/primer/commit/535a4cba7f6a458042b19dd7b3c7084703e8c09a)]:
  - @polygonlabs/primer-api-types@0.5.0

## 0.2.0

### Minor Changes

- [#101](https://github.com/0xPolygon/primer/pull/101) [`ed2d99b`](https://github.com/0xPolygon/primer/commit/ed2d99bef01897a9a156a6f63bf6c5cb3d466d3f) Thanks [@taylanpince](https://github.com/taylanpince)! - Pick permissions when creating an API token, and require them for the
  Claude service account.

  `/settings/tokens` now shows each token's permissions ("Full access" for
  unrestricted tokens) and lets you limit a new personal token to specific
  permissions. Service-account tokens must be limited: the form requires at
  least one permission, and `POST /api/service-tokens` without `scopes` is
  rejected with 400 `scopes_required`. Existing service tokens keep working
  and show as Full access until replaced.

### Patch Changes

- Updated dependencies [[`b2c513b`](https://github.com/0xPolygon/primer/commit/b2c513b044ca8a01cabc809087c5ffaab4e2fc59)]:
  - @polygonlabs/primer-api-types@0.4.0

## 0.1.3

## 0.1.2

## 0.1.1

### Patch Changes

- [#97](https://github.com/0xPolygon/primer/pull/97) [`99c994d`](https://github.com/0xPolygon/primer/commit/99c994dc8fbfc1ecc3305c06d275e903ac1d4788) Thanks [@taylanpince](https://github.com/taylanpince)! - Security: clear the `js-yaml` high advisory GHSA-2883-xcg3-v3hh
  (`maxTotalMergeKeys` does not limit CPU use for empty merge sources —
  quadratic-complexity CPU DoS via YAML merge keys). Raises the per-major
  transitive overrides in `pnpm-workspace.yaml` from `^3.15.1` to `^3.15.2` and
  from `^4.3.1` to `^4.3.2`.

  The existing `^` ranges already admitted the patched releases, but the lockfile
  stayed on 3.15.1 / 4.3.1: both patches were published 2026-08-26 and were still
  inside the repo's 14-day `minimumReleaseAge` gate when the lockfile was last
  resolved. They have now cleared it, so no gate bypass is needed and
  `minimumReleaseAgeExclude` stays empty. The floors are pinned explicitly so a
  future re-resolve cannot silently drop back to a vulnerable version.

  Exposure was dev-tooling only — the vulnerable paths ran through
  `@changesets/cli` on both majors (`read-yaml-file` on 3.x, `@changesets/parse`
  on 4.x), never the API or web runtime. The two first-party consumers behind
  these overrides, `gray-matter` (api) and `react-diff-viewer-continued` (web),
  parse only first-party content.

  `qs` `^6.16.0` (2 moderate) remains deferred and is tracked separately; it does
  not trip `--audit-level=high`.

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

- Updated dependencies [[`5e15068`](https://github.com/0xPolygon/primer/commit/5e150686c60b9fdbc1d2e1e8158e28dce112279a)]:
  - @polygonlabs/primer-api-types@0.3.0

## 0.1.0

### Minor Changes

- [#85](https://github.com/0xPolygon/primer/pull/85) [`2bf6ffb`](https://github.com/0xPolygon/primer/commit/2bf6ffb116fb7c8adcdada8044a8103acd6976db) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Structured document events with a consent-gated artifact write path ([#78](https://github.com/0xPolygon/primer/issues/78)).

  - New `events` table and REST surface: `POST /api/documents/:id/events` (atomic batches, required per-event `audience`, 256 KB payload cap, namespace/type validation), token-paginated `GET …/events`, and `GET …/events/stream` (SSE with per-row `id:`, `Last-Event-ID`/`since` resume, keepalive comments) — all scoped per-row by `audience` (`author` / `collaborators` / `artifact`).
  - Companion consent gate: artifact-originated `primer:submit-events` is relayed only from within the same trusted event dispatch that carried the user gesture, with one consumable activation per physical interaction (a tap or keystroke's whole event burst shares one authorization); acks return as `primer:submit-result`.
  - First-submission grant: the first submission by an artifact version on a document opens a Primer-owned prompt disclosing the event count, namespaces, and each audience with its plain-language meaning (who will see the data); grants persist per viewer, document, and artifact version, and re-prompt on republish or audience escalation.
  - Companion read relay: the parent page hydrates the list, holds an SSE subscription, and forwards `artifact`-audience rows verbatim into the iframe as coalesced `primer:events` batches, re-hydrating in full on reconnect and visibility regain so no row is ever silently skipped.
  - User lookup (`GET /api/users/lookup?email=`) resolving an email to the canonical user id.
  - MCP tools `primer_get_events` / `primer_send_events` on the remote MCP surface.

### Patch Changes

- Updated dependencies [[`2bf6ffb`](https://github.com/0xPolygon/primer/commit/2bf6ffb116fb7c8adcdada8044a8103acd6976db)]:
  - @polygonlabs/primer-api-types@0.2.0
