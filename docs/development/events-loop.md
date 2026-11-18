# Local dev: the events loop end-to-end

How to exercise the structured document-events channel (issue #78) — the
consent-gated artifact write path, the live relay, and an external consumer
(e.g. a CLI driving the REST API) — entirely against a local Primer.

**Boot** — the [Quickstart](../../README.md#quickstart-run-it-locally) (`pnpm db:up && pnpm db:migrate && pnpm dev`)
is all of it. Migrations seed two mock personas.

**Sign in as each mock user.** With `AUTH_MODE=mock` every browser session is
authenticated automatically; WHICH persona a browser is defaults to
`mock-user-1` (Mock User, `mock@polygon.technology`) and is chosen per
browser at **`http://localhost:5173/auth/mock`** (a dev-only picker;
`/auth/mock?user=mock-user-2` sets it directly). The choice is a plain
session cookie, so two browsers — or a normal and a private window — can be
two different collaborators at once:

- Browser A: leave as `mock-user-1` (Mock User) — the document owner.
- Browser B: open `/auth/mock`, pick `mock-user-2` (Mock Reviewer,
  `mock-reviewer@polygon.technology`).

The route and cookie exist only under `AUTH_MODE=mock` outside production;
`AUTH_MODE=okta` has neither.

**Mint a local API token for external tooling.** Sign in as the persona the
tool should act as, open `http://localhost:5173/settings/tokens`, create a
token (`primer_pat_…`), and point the tool at `http://localhost:3000` with
`Authorization: Bearer <token>`. If the tool should act as the shared
service account instead (`service-claude`), add your persona's email to
`ADMIN_EMAILS` in `.env` (for `mock-user-1` that's `mock@polygon.technology`)
and mint a service token from the admin section of the same page.

**Scoped tokens.** `POST /api/tokens` and `POST /api/service-tokens` accept
an optional `scopes` array (see `API_TOKEN_SCOPES` in
`@polygonlabs/primer-api-types`). A scoped token can call only the REST
routes and MCP tools its scopes grant — `apps/api/src/auth/scopes.ts` is the
single route→scope table — and gets 403 `insufficient_scope` everywhere else.
A scope only narrows what the user's document role already allows; it never
grants access the role doesn't have (a commenter's or an org reader's token with
`events:write` still gets 403 `forbidden`: writing events needs the owner,
editor or responder role). Deleting documents, making a
document org-visible, external sharing, folders, and token management have no
scope, so a scoped token can never reach them; with `documents:write` it may
make a document its user owns private. `collaborators:manage` is the one
scope that changes who can access a document, so grant it deliberately.
Service tokens must be scoped; omitting `scopes` on a personal token mints
an unrestricted one. OAuth access tokens (`primer_oat_`, used by remote MCP
clients) carry no scopes yet and act with the user's full permissions.
Minting and device approval always
require a browser session, whatever the token.

**Collaborators and the write bar.** Only the document owner,
editors and responders may write events; commenters can read and comment
only. To let Mock Reviewer submit on a document Mock User (or the service
account) owns, add them as a responder — via the Share UI, or
`POST /api/documents/:id/collaborators` with
`{"userId":"mock-user-2","role":"responder"}` (resolve ids from emails with
`GET /api/users/lookup?email=…`). Events never grant or change permissions;
roles change only through the collaborators API, by the document owner.

**Artifact-originated submissions: where the gates sit.** When an artifact
dispatches `primer:submit-events`, two layers run before any network call:
the companion's consent gate (the dispatch must ride a real user gesture —
one physical click/keystroke authorizes at most one submission) and, on an
artifact version's first submission (or an audience escalation), the
first-submission grant — a Primer-owned prompt over the artifact disclosing
what will be submitted and who will see it. Testing locally: click the
artifact's submit control and expect the grant prompt once per (browser,
document, artifact version); Allow forwards the submission (the artifact
receives `primer:submit-result` with the created rows), Deny answers it with
an error. Programmatic submissions (API token → `POST
/api/documents/:id/events`) bypass neither gate — they simply aren't
artifact-originated; auth is the consent there.

**Two-user live-relay smoke.** Open the SAME document in both browsers
(both personas collaborators). Submit an `audience: "artifact"` event from
either side — from the artifact's own UI, or via curl:

```bash
curl -s -X POST http://localhost:3000/api/documents/<docId>/events \
  -H "Authorization: Bearer $PRIMER_TOKEN" -H "content-type: application/json" \
  -d '{"events":[{"namespace":"example","type":"export","audience":"artifact","payload":{"hello":"relay"}}]}'
```

Both browsers' artifacts receive the row live (SSE → companion relay →
`primer:events`, no reload), and `GET
/api/documents/<docId>/events?namespace=example/*` shows the stored rows.
Watching the raw stream directly also works:
`curl -N -H "Authorization: Bearer $PRIMER_TOKEN"
http://localhost:3000/api/documents/<docId>/events/stream`.

Two consumer gotchas when testing artifacts locally: (1) the sandboxed
iframe has no Clipboard API (`navigator.clipboard.writeText` rejects with a
permissions-policy violation) — artifact fallback UX must not rely on
in-iframe clipboard writes; (2) the consent gate's real-input behavior is
only provable in a real browser — after any change to `v1.js`'s gate, run
the real-browser test tier: `pnpm --filter @primer/api test:browser`
(launches your installed Chrome headless; not part of the default
`pnpm test`).
