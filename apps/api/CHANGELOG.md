# @primer/api

## 0.4.0

### Patch Changes

- [#135](https://github.com/0xPolygon/primer/pull/135) [`17c841c`](https://github.com/0xPolygon/primer/commit/17c841c66bcb55a326567b689e27bf67da228b30) Thanks [@taylanpince](https://github.com/taylanpince)! - Fix a remote code execution in Markdown uploads. gray-matter selected its parse
  engine from the front-matter fence language and its built-in JavaScript engine
  ran the block through `eval()`, so an uploaded `.md` beginning with `---js`
  executed arbitrary code with the API process's privileges at upload time.
  Markdown front-matter is now parsed with the JavaScript engine disabled; YAML
  and JSON front-matter are unchanged.

- [#133](https://github.com/0xPolygon/primer/pull/133) [`07ef829`](https://github.com/0xPolygon/primer/commit/07ef8296a33cb115bb78ede31cfb9a50f9843553) Thanks [@taylanpince](https://github.com/taylanpince)! - Security: clear the moderate and low npm audit advisories affecting the API service by raising the `hono` override floor to 4.13.16 (`mount()` middleware bypass, RegExpRouter skipping wildcard middleware, `csrf()` not checking `text/ping` requests, `validator('form')` skipping multipart bodies with extra parameters, `css` helper HTML injection) and the `@hono/node-server` floor to 2.1.6 (process crash on `ECONNRESET` during a WebSocket upgrade, backslash treated as a path separator behind a reverse proxy). Also removes the expired `body-parser` exemption from the 14-day release-age gate.

## 0.3.1

### Patch Changes

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

- [#100](https://github.com/0xPolygon/primer/pull/100) [`b2c513b`](https://github.com/0xPolygon/primer/commit/b2c513b044ca8a01cabc809087c5ffaab4e2fc59) Thanks [@taylanpince](https://github.com/taylanpince)! - API tokens can now be limited to specific permissions.

  `POST /api/tokens` and `POST /api/service-tokens` accept an optional
  `scopes` array: `documents:read`, `documents:write`, `comments:write`,
  `events:write`, `collaborators:manage`, `users:read` (exported as
  `API_TOKEN_SCOPES`, with `ApiTokenScope` and `isApiTokenScope`). A scoped
  token can call only the REST routes and MCP tools its scopes grant and gets
  403 `insufficient_scope` everywhere else — default deny, driven by one
  route→scope table. A scope only narrows what the user's role on a document
  already allows; it never grants more. Deleting or restoring documents, making
  a document org-visible, external sharing, folders, and token management have
  no scope at all, so a scoped token can never reach them; `documents:write`
  does allow making a document the user owns private. Over MCP, tools a token
  lacks the scope for are not registered for its request.

  Scopes apply to personal and service tokens only: OAuth access tokens
  (`primer_oat_`) are not scoped yet and keep the user's full permissions.

  Omitting `scopes` mints an unrestricted token, and existing tokens stay
  unrestricted, so nothing changes for current clients. `ApiTokenSummary`
  gains `scopes` (`null` = unrestricted). Invalid scopes are rejected with 400
  `invalid_scopes`. Adds a nullable `api_tokens.scopes` column (migration
  0014).

- [#101](https://github.com/0xPolygon/primer/pull/101) [`ed2d99b`](https://github.com/0xPolygon/primer/commit/ed2d99bef01897a9a156a6f63bf6c5cb3d466d3f) Thanks [@taylanpince](https://github.com/taylanpince)! - Pick permissions when creating an API token, and require them for the
  Claude service account.

  `/settings/tokens` now shows each token's permissions ("Full access" for
  unrestricted tokens) and lets you limit a new personal token to specific
  permissions. Service-account tokens must be limited: the form requires at
  least one permission, and `POST /api/service-tokens` without `scopes` is
  rejected with 400 `scopes_required`. Existing service tokens keep working
  and show as Full access until replaced.

### Patch Changes

- [#99](https://github.com/0xPolygon/primer/pull/99) [`1b375bd`](https://github.com/0xPolygon/primer/commit/1b375bd3cc2aa964ba733e81e4235342cb8efe57) Thanks [@taylanpince](https://github.com/taylanpince)! - Credential-management routes now require a signed-in browser session and
  refuse API-token (bearer) auth with 403 `session_required`:
  `POST /api/tokens`, all of `/api/service-tokens`, `POST /api/device/approve`,
  `POST /api/device/deny`, and `GET /api/admin/stats`.

  Before this, any bearer — including the Claude service token — could mint a
  never-expiring sibling token and read its plaintext back, or approve a device
  login started by someone else and hand them a 90-day token. Agents hold
  bearers whose requests can be steered by untrusted content, so neither path
  may be reachable with one. Listing and revoking your own tokens stays
  bearer-callable; the local MCP server's `primer_logout` relies on revoke.

- Updated dependencies [[`b2c513b`](https://github.com/0xPolygon/primer/commit/b2c513b044ca8a01cabc809087c5ffaab4e2fc59)]:
  - @polygonlabs/primer-api-types@0.4.0

## 0.1.3

### Patch Changes

- [#122](https://github.com/0xPolygon/primer/pull/122) [`3badb0c`](https://github.com/0xPolygon/primer/commit/3badb0c7bfd3f6099c71687600019e747b4e1523) Thanks [@ScreamingHawk](https://github.com/ScreamingHawk)! - Clear pnpm audit: bump @modelcontextprotocol/sdk to 1.32.1 (four high advisories), @hono/node-server to the patched 2.x line, raise the body-parser and fast-uri override floors, and refresh in-range transitive pins (proxy-addr, zod, markdown-it, undici, body-parser) out of their vulnerable versions.

- [#121](https://github.com/0xPolygon/primer/pull/121) [`8525424`](https://github.com/0xPolygon/primer/commit/852542420f616ce6de1f83090298143eb246defa) Thanks [@ScreamingHawk](https://github.com/ScreamingHawk)! - Fix a race where a device poll that lost the mint race could get slow_down instead of invalid_grant, telling the client to keep polling a consumed grant.

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
