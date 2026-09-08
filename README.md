# Primer

> *"The Primer was a book in appearance only. Its interior was a tissue of paper, but each page was a separate flat-panel display, which formed itself into pictures, words, and animations responsive to the reader."*
> — Neal Stephenson, *The Diamond Age*

Internal Polygon tool for hosting and collaborating on LLM-generated HTML artifacts.

See:
- Product: `docs/prd-primer.md`
- Decomposition: `docs/superpowers/specs/2026-05-12-primer-decomposition-design.md`
- This sub-project's design spec: `docs/superpowers/specs/2026-05-13-primer-local-foundation-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-13-primer-local-foundation.md`

## Publish from Claude Code (or any MCP-capable agent)

This repo ships a Claude Code plugin (`primer`) that bundles a skill + the [`@polygonlabs/primer-mcp`](apps/mcp/) server. End users at Polygon install it once with:

```
/plugin marketplace add 0xPolygon/primer
/plugin install primer@primer
/reload-plugins
```

Then in any Claude Code session: *"publish this to Primer"* triggers the device-flow login (one-time browser approval), creates the document, and returns a stable URL. Subsequent versions and reviewer comments flow through the same skill.

The plugin manifest bakes in the prod `PRIMER_API_URL` (`https://primer-polygon.up.railway.app`) — nothing else to configure. For local development against `localhost:3000`, see `apps/mcp/README.md`.

## Quickstart

Prerequisites: Node 24 LTS, Docker, Corepack-enabled (Node ships with this; run `corepack enable` once — see NixOS note below).

```bash
git clone <repo> primer && cd primer
corepack use pnpm@11.1.0
cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:up         # Postgres in Docker Compose
pnpm db:migrate    # apply migrations + seed mock user
pnpm db:migrate:test  # mirror schema into primer_test
pnpm dev           # boots API on :3000 and web on :5173
```

Open `http://localhost:5173`.

### NixOS dev note

`corepack enable` fails on NixOS (read-only Nix store). Workaround:

```bash
mkdir -p ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"
corepack enable --install-directory "$HOME/.local/bin"
corepack prepare pnpm@11.1.0 --activate
```

Also ensure your Nix-store `node` binary is on `PATH` (otherwise pnpm postinstall scripts can't find `node`).

## Local dev: the events loop end-to-end

How to exercise the structured document-events channel (issue #78) — the
consent-gated artifact write path, the live relay, and an external consumer
(e.g. a CLI driving the REST API) — entirely against a local Primer.

**Boot** — the Quickstart above (`pnpm db:up && pnpm db:migrate && pnpm dev`)
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

**Collaborators and the write bar.** Only the document owner and its
collaborators may write events. To let Mock Reviewer submit on a document
Mock User (or the service account) owns, add them as a collaborator — via
the Share UI, or `POST /api/documents/:id/collaborators` with
`{"userId":"mock-user-2","role":"editor"}` (resolve ids from emails with
`GET /api/users/lookup?email=…`).

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
  -d '{"events":[{"namespace":"padd","type":"export","audience":"artifact","payload":{"hello":"relay"}}]}'
```

Both browsers' artifacts receive the row live (SSE → companion relay →
`primer:events`, no reload), and `GET
/api/documents/<docId>/events?namespace=padd/*` shows the stored rows.
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

## Architecture

- `apps/api` — Hono API server (Node 24, drizzle-orm, postgres, parse5, pino, markdown-it). Contains the Drizzle schema and Storage interface.
- `apps/web` — React + Vite frontend (React 19, React Router 7, TanStack Query, Tailwind 4). Contains the companion protocol module.
- `packages/api-types` — Published wire contract (`@polygonlabs/primer-api-types`): REST API DTOs, anchor shapes, and type guards.
- `apps/api/drizzle/` — committed migration SQL.
- `docker/init-db.sql` — runs once on first Postgres boot, creates the `primer_test` database alongside `primer`.

Dev: two processes. Vite serves the React app at `:5173` with a proxy forwarding `/api/*` and `/companion/*` to the API at `:3000`.

## Supply-chain hardening

`pnpm-workspace.yaml` enforces:

- `minimumReleaseAge: 20160` — no package version younger than 14 days will install.
- `allowBuilds: { esbuild: true }` — every postinstall script must be explicitly approved (esbuild is the only one allowed; it's required transitively by drizzle-kit and downloads its platform binary from the @esbuild scope).
- `blockExoticSubdeps: true` — no git/tarball/http deps in the transitive tree.
- `strictPeerDependencies: true`, `engineStrict: true`.

`pnpm-lock.yaml` is committed; `pnpm install --frozen-lockfile` is the only sanctioned install path. `pnpm approve-builds` is the only path to extending the allowlist — review each request individually.

### Manual verification (run once after setup)

Confirm the 14-day gate is active:

```bash
pnpm add hono@4.12.18
# Expected: install fails with "ERR_PNPM_NO_MATURE_MATCHING_VERSION" or similar.
git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml
```

If the install **succeeds**, the gate is not active — stop and investigate before continuing.

## Scripts

- `pnpm dev` — start API + web in parallel.
- `pnpm db:up` / `pnpm db:down` — manage local Postgres.
- `pnpm db:reset` — drop volume, restart, re-migrate (uses `docker compose up --wait`).
- `pnpm db:migrate` / `pnpm db:migrate:test` — apply migrations.
- `pnpm db:generate` — generate a new migration from schema changes (then commit the SQL).
- `pnpm typecheck` — run `tsc --noEmit` across all workspaces.
- `pnpm test` — run Vitest across all workspaces.
- `pnpm verify` — typecheck + test + `pnpm audit --audit-level=high`.

## Out of scope here (deferred to later sub-projects)

- Companion script body (sub-project 2)
- Comments, threading, sidebar, polling (sub-project 3)
- Multi-version per document, version selector, soft-delete UI (sub-project 4)
- Real Okta auth, CSRF, multi-user (sub-project 5)
- Slack notifications (sub-project 6)
- Element-path anchor fallback, drift indicator, alpha launch (sub-project 7)
