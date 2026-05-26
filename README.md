# Primer

> *"The Primer was a book in appearance only. Its interior was a tissue of paper, but each page was a separate flat-panel display, which formed itself into pictures, words, and animations responsive to the reader."*
> — Neal Stephenson, *The Diamond Age*

Internal Polygon tool for hosting and collaborating on LLM-generated HTML artifacts.

See:
- Product: `docs/prd-primer.md`
- Decomposition: `docs/superpowers/specs/2026-05-12-primer-decomposition-design.md`
- This sub-project's design spec: `docs/superpowers/specs/2026-05-13-primer-local-foundation-design.md`
- Implementation plan: `docs/superpowers/plans/2026-05-13-primer-local-foundation.md`

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

## Architecture

- `apps/api` — Hono API server (Node 24, drizzle-orm, postgres, parse5, pino, markdown-it).
- `apps/web` — React + Vite frontend (React 19, React Router 7, TanStack Query, Tailwind 4).
- `packages/shared` — Drizzle schema, Storage interface, API DTOs. drizzle-orm is declared as a peer dep so workspaces share one instance.
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
