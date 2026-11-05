# @primer/api

## 0.1.2

### Patch Changes

- [#119](https://github.com/0xPolygon/primer/pull/119) [`c86f7af`](https://github.com/0xPolygon/primer/commit/c86f7af17ed287e564e8466ddcaf74c7dad4d233) Thanks [@ScreamingHawk](https://github.com/ScreamingHawk)! - Bump the vendored mermaid bundle from 11.4.1 to 12.3.0. Since v12.0.0 ELK is bundled and is the default flowchart layout, replacing dagre's wide and flat layouts with crossing edges. Matches what mermaid.live renders with.

## 0.1.1

### Patch Changes

- [#91](https://github.com/0xPolygon/primer/pull/91) [`c5b99b4`](https://github.com/0xPolygon/primer/commit/c5b99b49ddcc87fe14cc86b9fdf00bebfb20ecfe) Thanks [@taylanpince](https://github.com/taylanpince)! - Security: clear npm audit advisories affecting the API service. Bumps `hono`
  to 4.12.34 (CORS ReDoS, `memo()` SSR bleed, language-middleware DoS, proxy
  header leak), `sanitize-html` to 2.17.7 (URI-scheme + SVG SMIL XSS,
  mutation-XSS), and `@hono/node-server` to 2.0.10 (serve-static path traversal,
  memory-leak DoS). Adds `pnpm` overrides pinning patched transitive copies
  pulled via `@modelcontextprotocol/sdk`: `fast-uri` 3.1.6 (SSRF + host
  confusion, 4 highs), `hono` 4.12.34, `@hono/node-server@1` 1.19.15, and
  `body-parser` 2.3.0.

  `qs` (2 moderate: array-limit bypass, isBuffer DoS; patched in 6.16.0) is
  deferred until 6.16.0 clears the repo's 14-day `minimumReleaseAge` gate
  (~2026-09-12).

- [#114](https://github.com/0xPolygon/primer/pull/114) [`49d08ff`](https://github.com/0xPolygon/primer/commit/49d08ff5e44a3f1aaecf6c708e7b173949d457f5) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - The GCS storage backend honours `STORAGE_EMULATOR_HOST`, so the image can run against a local GCS emulator. When it is set, requests go to the emulator and no access token is fetched from the GKE metadata server. It is meant for tests only; deployments leave it unset.

- [#109](https://github.com/0xPolygon/primer/pull/109) [`e0ee8e0`](https://github.com/0xPolygon/primer/commit/e0ee8e07d277f1c6198c5e720eed3844d174fb8b) Thanks [@taylanpince](https://github.com/taylanpince)! - Add a Google Cloud Storage backend for document storage, so Primer can run
  stateless on GKE. Set `STORAGE_BACKEND=gcs` and `GCS_BUCKET`; the default stays
  the filesystem (`STORAGE_ROOT`), so local dev is unchanged.

  It talks to the GCS JSON API over `fetch` and authenticates with Workload
  Identity tokens from the GKE metadata server, so it adds no dependencies and
  the pod holds no key file. Object names are the existing storage keys, so a
  copy of the filesystem root into the bucket is a valid migration. A missing
  object rejects with `ENOENT` like the filesystem backend; deleting one is a
  no-op.

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

- [#110](https://github.com/0xPolygon/primer/pull/110) [`107d329`](https://github.com/0xPolygon/primer/commit/107d329930d1a917b0e61711399e0739733da397) Thanks [@taylanpince](https://github.com/taylanpince)! - Add `GET /api/ready`, a readiness probe that checks the database (`select 1`,
  2s timeout) and returns 503 `database_unavailable` when it can't reach it.
  `/api/health` stays a cheap liveness check. Both are unauthenticated.

  On Railway, `/api/health` kept reporting ok after the database password was
  rotated, while every real request failed. Kubernetes now routes traffic only to
  pods that can reach the database.

- [#114](https://github.com/0xPolygon/primer/pull/114) [`49d08ff`](https://github.com/0xPolygon/primer/commit/49d08ff5e44a3f1aaecf6c708e7b173949d457f5) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Ship Primer as a versioned container image. Every release of `@primer/api` now builds a multi-architecture image tagged with the release version; the API serves the built web app from the same image and runs pending database migrations on start.

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

- [#85](https://github.com/0xPolygon/primer/pull/85) [`2bf6ffb`](https://github.com/0xPolygon/primer/commit/2bf6ffb116fb7c8adcdada8044a8103acd6976db) Thanks [@MaximusHaximus](https://github.com/MaximusHaximus)! - Dev-only multi-user mock auth: `AUTH_MODE=mock` sessions can now pick which mock persona a browser acts as via `GET /auth/mock` (picker page, or `?user=` to set directly; per-browser cookie), and a second persona — `mock-user-2` / Mock Reviewer — is seeded alongside the existing mock user. Registered strictly inside the existing dev gate (never in production, never under `AUTH_MODE=okta`). Enables two browsers to hold sessions as different collaborators at once — required to exercise the live multi-party events relay locally. README gains a "Local dev: the events loop end-to-end" walkthrough.

- Updated dependencies [[`2bf6ffb`](https://github.com/0xPolygon/primer/commit/2bf6ffb116fb7c8adcdada8044a8103acd6976db)]:
  - @polygonlabs/primer-api-types@0.2.0
