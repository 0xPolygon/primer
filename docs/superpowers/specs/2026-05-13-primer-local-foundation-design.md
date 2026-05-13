# Sub-project 1 — Local foundation: Design

**Author:** Taylan Pince (with Claude)
**Date:** 2026-05-13
**Status:** Approved for implementation planning
**Parent PRD:** `docs/prd-primer.md`
**Parent decomposition:** `docs/superpowers/specs/2026-05-12-primer-decomposition-design.md`

## Purpose

This document specifies sub-project 1 of Primer: the local-only foundation that lets a single mock user upload a self-contained HTML file and view it inside a sandboxed iframe with the locked CSP from the PRD applied. No real auth, no comments, no versioning UI, no Slack — those land in later sub-projects.

The intent is to ship a working `pnpm dev` loop, the data model from day 1 (forward-compatible across all phases), and the security primitives (iframe sandbox, CSP, supply-chain hardening) baked in early so they're load-bearing from the start rather than retrofitted.

## Scope summary

**In scope:**
- pnpm workspaces repo with hardened supply-chain config
- Hono API server + React/Vite client + shared package
- Drizzle schema for *all* tables (users, documents, versions, threads, comments) with seed for a single mock user; only users/documents/versions are exercised
- Mock-user middleware
- Upload pipeline: validate → parse5 → strip `<iframe>` + `<meta http-equiv="refresh">` → inject companion script tag → persist to filesystem object storage → write version row
- Filesystem-backed `Storage` interface (swappable later)
- Companion script stub served at `/companion/v1.js`
- Document detail page rendering the iframe with locked sandbox attrs + locked CSP
- Home page placeholder + upload page
- Local Postgres via Docker Compose
- Vitest unit + integration tests for the upload pipeline and artifact endpoint

**Out of scope (deferred to later sub-projects):**
- Companion script body (sub-project 2)
- Comments, threading, sidebar, polling (sub-project 3)
- Multi-version per document, version selector, soft-delete UI, recently-deleted, metadata editing (sub-project 4)
- Real Okta auth, sessions, CSRF, multi-user (sub-project 5)
- Slack notifications, @mention typeahead (sub-project 6)
- Element-path anchor resolution fallback, drift indicator, internal alpha (sub-project 7)
- Production deploy, Railway integration, observability, tracing

## Stack decisions

These were resolved during the 2026-05-13 brainstorm and lock the foundation:

| Concern | Decision |
|---|---|
| Backend framework | Hono on Node, run via `tsx watch` in dev |
| Frontend | React + Vite |
| Repo shape | pnpm workspaces: `apps/api` + `apps/web` + `packages/shared` |
| Package manager | pnpm, pinned via `packageManager` field + Corepack |
| DB access | Drizzle ORM + `drizzle-kit` migrations |
| DB driver | `postgres` (postgres.js) |
| Local Postgres | Docker Compose with a pinned `postgres:16.<exact>` image |
| Object storage | Local filesystem behind a `Storage` interface |
| Routing | React Router v7 (library mode) |
| Data fetching | TanStack Query |
| Styling | Tailwind CSS (installed locally in `apps/web`) |
| Logging | `pino` JSON logging |
| Test runner | Vitest |
| Nix flake dev shell | Out of scope for sub-project 1 |

## Repo layout

```
primer/
  apps/
    api/                     # Hono server
      src/
        index.ts             # bootstraps Hono, mounts middleware + routes
        db.ts                # Drizzle client singleton
        logger.ts            # pino instance
        middleware/
          mockUser.ts
        routes/
          upload.ts          # POST /api/upload
          documents.ts       # GET /api/documents/:docId
          versionContent.ts  # GET /api/versions/:versionId/content
          companion.ts       # GET /companion/v1.js
        upload/
          validate.ts
          sanitize.ts        # strip iframe + meta refresh, inject companion script
          pipeline.ts        # orchestrates validate → sanitize → store → DB write
        storage/
          interface.ts       # re-exports Storage from @primer/shared
          filesystem.ts      # FilesystemStorage impl
        companion/
          v1.js              # companion script stub (literal file)
      package.json
      tsconfig.json
      vitest.config.ts
    web/                     # React + Vite
      src/
        main.tsx
        App.tsx
        routes/
          home.tsx
          upload.tsx
          document.tsx
          notFound.tsx
        components/
          AppShell.tsx
          ArtifactIframe.tsx
        queries/
          documents.ts       # TanStack Query hooks
      index.html
      vite.config.ts
      tailwind.config.ts
      package.json
      tsconfig.json
  packages/
    shared/
      src/
        schema.ts            # Drizzle table definitions
        storage.ts           # Storage interface
        api.ts               # request/response DTO types
        index.ts             # barrel
      package.json
      tsconfig.json
  drizzle/                   # generated migration SQL (committed)
  docker-compose.yml
  pnpm-workspace.yaml        # workspaces + supply-chain settings
  package.json               # root: packageManager pin, dev orchestrator scripts
  .nvmrc
  .env.example
  drizzle.config.ts
  README.md
```

## Supply-chain hardening

These settings ship in the first commit.

**`pnpm-workspace.yaml`:**

```yaml
packages:
  - "apps/*"
  - "packages/*"

minimumReleaseAge: 20160         # 14 days in minutes
blockExoticSubdeps: true         # already default in pnpm 11; set explicitly
allowBuilds: {}                  # empty allowlist; all install scripts default-deny
strict-peer-dependencies: true
```

**Root `package.json` (essentials):**

```json
{
  "name": "primer",
  "private": true,
  "packageManager": "pnpm@<exact-current-stable>",
  "engines": { "node": "<exact-current-LTS>" },
  "scripts": {
    "dev": "pnpm -r --parallel run dev",
    "build": "pnpm -r run build",
    "typecheck": "pnpm -r run typecheck",
    "test": "pnpm -r run test",
    "verify": "pnpm typecheck && pnpm test && pnpm audit --audit-level=high",
    "db:up": "docker compose up -d postgres",
    "db:down": "docker compose down",
    "db:migrate": "drizzle-kit migrate",
    "db:generate": "drizzle-kit generate",
    "db:reset": "docker compose down -v && pnpm db:up && wait-on tcp:5432 && pnpm db:migrate"
  }
}
```

**Workflow rules:**

- `pnpm install --frozen-lockfile` is the only sanctioned install command in CI and in any deploy path. Local devs may run `pnpm install` interactively, but the lockfile is committed and any unintended diff is treated as suspect.
- `pnpm approve-builds` is the only path to adding a package to `allowBuilds`. The diff to `pnpm-workspace.yaml` is reviewed as part of the PR.
- `engine-strict: true` lives in `pnpm-workspace.yaml` (per pnpm 11's consolidation of settings out of `.npmrc`) so a Node mismatch fails install rather than warns.

**Exact versions** for `packageManager`, `engines.node`, and the Postgres image are pinned at scaffold time by reading the then-current stable versions and committing those literals. The implementation plan will name them; this design doc deliberately doesn't, because they should be fresh when the work starts.

## Data model

The Drizzle schema lives in `packages/shared/src/schema.ts`. All tables are created in the first migration; sub-project 1 only exercises `users`, `documents`, `versions`. The remaining tables exist to lock the structure from day one (forward-compatibility constraint from the decomposition doc).

```ts
// packages/shared/src/schema.ts
import { pgTable, text, uuid, timestamp, integer, jsonb, bigint, uniqueIndex } from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id:           text('id').primaryKey(),                  // Okta sub in Phase 2; "mock-user-1" in Phase 1
  email:        text('email').notNull(),
  displayName:  text('display_name').notNull(),
  slackUserId:  text('slack_user_id'),                    // nullable; populated in Phase 2
  createdAt:    timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable('documents', {
  id:          uuid('id').primaryKey(),                   // UUIDv7
  title:       text('title').notNull(),
  description: text('description'),
  uploaderId:  text('uploader_id').notNull().references(() => users.id),
  createdAt:   timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt:   timestamp('deleted_at', { withTimezone: true }),
});

export const versions = pgTable('versions', {
  id:            uuid('id').primaryKey(),                 // UUIDv7
  documentId:    uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  versionNumber: integer('version_number').notNull(),
  storageKey:    text('storage_key').notNull(),
  sizeBytes:     bigint('size_bytes', { mode: 'number' }).notNull(),
  versionNote:   text('version_note'),
  createdAt:     timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  uniqDocVersion: uniqueIndex('versions_doc_version_unique').on(t.documentId, t.versionNumber),
}));

export const threads = pgTable('threads', {                // Exists but unused in sub-project 1.
  id:         uuid('id').primaryKey(),
  versionId:  uuid('version_id').notNull().references(() => versions.id, { onDelete: 'cascade' }),
  anchor:     jsonb('anchor').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: text('resolved_by').references(() => users.id),
  createdAt:  timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const comments = pgTable('comments', {              // Exists but unused in sub-project 1.
  id:        uuid('id').primaryKey(),
  threadId:  uuid('thread_id').notNull().references(() => threads.id, { onDelete: 'cascade' }),
  authorId:  text('author_id').notNull().references(() => users.id),
  body:      text('body').notNull(),
  mentions:  text('mentions').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
```

**ID strategy:** UUIDv7 generated in app code via the `uuid` npm package's v7 helper. Sortable by time, no info-leak from sequential ints.

**User.id is `text`, not `uuid`,** because in Phase 2 it holds the Okta `sub` string. In Phase 1 it holds the literal `"mock-user-1"`. The schema doesn't need to change between phases.

**Seed migration** runs immediately after table creation:

```sql
INSERT INTO users (id, email, display_name)
VALUES ('mock-user-1', 'mock@polygon.technology', 'Mock User')
ON CONFLICT (id) DO NOTHING;
```

Idempotent. Phase 2 deletes this row in its own migration once Okta proves out — not before.

## Mock-user middleware

Single Hono middleware, applied globally before any route. Sets a typed `user` variable on the request context.

```ts
// apps/api/src/middleware/mockUser.ts
import type { MiddlewareHandler } from 'hono';

export const MOCK_USER = {
  id: 'mock-user-1',
  email: 'mock@polygon.technology',
  displayName: 'Mock User',
} as const;

export const mockUserMiddleware: MiddlewareHandler = async (c, next) => {
  c.set('user', MOCK_USER);
  await next();
};
```

The Hono app is typed so `c.get('user')` is non-nullable everywhere downstream:

```ts
type Variables = { user: { id: string; email: string; displayName: string } };
const app = new Hono<{ Variables: Variables }>();
app.use('*', mockUserMiddleware);
```

In sub-project 5, this middleware is swapped for real Okta session resolution. The context shape stays the same, so route handlers don't change.

## Storage interface

Defined in `packages/shared/src/storage.ts`, imported by `apps/api`.

```ts
export interface Storage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
}
```

Keys are opaque to callers. The convention used by the upload pipeline: `v1/<versionId>.html`. The `v1/` prefix is a layout version we can rev later without scanning.

The filesystem impl (`apps/api/src/storage/filesystem.ts`) maps keys to file paths under `STORAGE_ROOT` (env var, default `./storage`). It ensures the parent directory exists on `put`, returns a `ReadableStream` from `fs.createReadStream` on `get`, and `unlink`s on `delete`. Errors propagate as exceptions — the upload pipeline catches and compensates.

## Upload pipeline

**Endpoint:** `POST /api/upload`, `multipart/form-data`

Form fields:
- `file`: the `.html` file (required)
- `title`: string, trimmed, 1–200 chars (required)
- `description`: string, 0–2000 chars (optional)

**Response shapes:**
- `200`: `{ documentId: string, versionId: string, url: string }`
- `400`: `{ error: 'validation_failed' | 'parse_failed' | 'too_large' | 'bad_extension' | 'bad_content_type' | 'missing_title' | 'missing_file', message: string }`
- `500`: `{ error: 'internal', message: string }`

**Pipeline stages, in order:**

1. **Pre-read validation (cheap):**
   - Reject if `Content-Length` is present and exceeds **10,485,760** bytes (10 MiB) → `too_large`.
   - Reject if `title` is missing or empty after trim → `missing_title`.
   - Reject if no file field is present → `missing_file`.

2. **Read the file into memory.** 10 MiB cap means buffering is fine. Re-check actual byte length after read in case `Content-Length` was missing/wrong → `too_large` if exceeded.

3. **MIME + extension check.**
   - Filename must end in `.html` (case-insensitive) → otherwise `bad_extension`.
   - Form-claimed content-type must be `text/html` or absent → otherwise `bad_content_type`. Don't trust this as the sole gate; treat it as a sanity check.

4. **Parse with `parse5`.** Decode bytes to UTF-8 string. Run `parse5.parse(html)`. If parse throws or yields no usable `<html>`/`<body>`, reject → `parse_failed`.

5. **Mutate the parse tree.** Walk the document and:
   - Remove every `<iframe>` element.
   - Remove every `<meta>` whose `http-equiv` attribute equals `"refresh"` (case-insensitive comparison on the attribute value).
   - Insert `<script src="/companion/v1.js" defer></script>` as the last child of `<body>`. parse5 always normalizes the tree to contain `<body>`, so this is always safe.
   
   Nothing else is touched. `<script>`, `<form>`, inline event handlers, CDN references, `<canvas>`, SVG — all preserved.

6. **Serialize back to HTML** via `parse5.serialize()`. The serialized bytes are what gets persisted; the original bytes are not kept.

7. **Persist.** Generate `documentId` and `versionId` as UUIDv7. Compute `storageKey = "v1/<versionId>.html"`. Call `storage.put(storageKey, serializedBytes)`.

8. **Database write — single transaction:**
   ```ts
   await db.transaction(async (tx) => {
     await tx.insert(documents).values({
       id: documentId, title, description, uploaderId: c.get('user').id,
     });
     await tx.insert(versions).values({
       id: versionId, documentId, versionNumber: 1, storageKey,
       sizeBytes: serializedBytes.byteLength, versionNote: null,
     });
   });
   ```

9. **Compensating cleanup.** If step 8 throws (transaction rolls back), call `storage.delete(storageKey)` in a `try { ... } catch { logger.warn(...) }` — best-effort. A failure here leaves an orphan file that a future GC job can sweep; we don't surface the secondary failure to the user.

10. **Response.** On success, return `200` with `{ documentId, versionId, url: \`/d/\${documentId}\` }`.

**CSRF protection:** deferred to sub-project 5 (lands with real auth). Phase 1 runs on localhost with a single mock user; the threat model doesn't require CSRF defense yet.

## Viewer surfaces

### Parent page (`/d/:docId`)

React app served by Vite in dev and (eventually) by Hono in prod. For sub-project 1:

- Fetches `GET /api/documents/:docId` → `{ document, latestVersion }`.
- Top bar: title, uploader display name, upload date.
- Center: `<iframe>` pointing at the artifact endpoint.
- No sidebar (sub-project 3).
- No version selector (sub-project 4).

Iframe element:

```jsx
<iframe
  src={`/api/versions/${latestVersion.id}/content`}
  sandbox="allow-scripts allow-forms"
  style={{ width: '100%', height: 'calc(100vh - 60px)', border: 0 }}
/>
```

The `sandbox` attribute deliberately omits `allow-same-origin`, `allow-popups`, and `allow-popups-to-escape-sandbox`. Static iframe height in sub-project 1; the dynamic `resize(height)` postMessage path lands in sub-project 2.

**Parent-page CSP** (set by Hono on the bootstrapping HTML response that delivers the React app):

```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';
frame-src 'self';
connect-src 'self';
```

### Artifact endpoint (`GET /api/versions/:versionId/content`)

Hono route. Behind mock-user middleware (auth-equivalent for Phase 1). Streams the stored HTML to the response from `storage.get(storageKey)`.

**Response headers — locked from day one:**

```
Content-Type: text/html; charset=utf-8
Content-Security-Policy:
  default-src 'none';
  script-src 'self' 'unsafe-inline' cdn.tailwindcss.com cdnjs.cloudflare.com
             unpkg.com cdn.jsdelivr.net esm.sh cdn.skypack.dev;
  style-src 'self' 'unsafe-inline' cdn.tailwindcss.com cdnjs.cloudflare.com
            unpkg.com cdn.jsdelivr.net fonts.googleapis.com;
  connect-src 'none';
  img-src data: blob: 'self' https:;
  font-src 'self' fonts.gstatic.com;
  form-action 'none';
  frame-src 'none';
  frame-ancestors 'self';
  base-uri 'self';
  object-src 'none';
X-Frame-Options: SAMEORIGIN
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Cache-Control: private, max-age=300
```

#### PRD refinements baked in here

The PRD's literal CSP table omits a few directives needed for the system to actually work. These are not contradictions of intent — they're gaps closed during this design pass:

1. **`'self'` in `script-src`** — the companion script tag `<script src="/companion/v1.js">` is same-origin and won't load without it. Same logic mirrored into `style-src` defensively.
2. **`default-src 'none'`** — explicit fallback so any directive not enumerated is denied rather than implicitly permitted.
3. **`frame-ancestors 'self'` + `X-Frame-Options: SAMEORIGIN`** — prevent other origins from embedding the artifact endpoint, which would otherwise enable clickjacking inside the artifact.
4. **`base-uri 'self'`** — defense against `<base>` redirect tricks inside hostile artifacts.
5. **`object-src 'none'`** — block legacy `<object>` and `<embed>` content.

The artifact endpoint does *not* set `Content-Disposition: attachment` — the response is meant to be embedded in an iframe, not downloaded.

### Companion script route (`GET /companion/v1.js`)

Served same-origin from Hono. Body for sub-project 1 (the stub):

```js
// Companion script v1 — stub for sub-project 1.
// Real implementation (capture, postMessage, marker rendering) lands in sub-project 2.
console.log('[primer] companion v1 loaded');
```

Headers:
```
Content-Type: application/javascript
Cache-Control: public, max-age=3600
```

The route ships in sub-project 1 so the iframe sees a 200 (not a 404) when it loads the script tag the upload pipeline injected.

## Frontend surface

### Routes (`apps/web` via React Router v7)

| Path | Component | Notes |
|---|---|---|
| `/` | `HomePage` | Heading + "Upload a new document" CTA. Placeholder until sub-project 3. |
| `/upload` | `UploadPage` | File picker + title + description. `POST /api/upload`. Inline validation errors. On success: `navigate('/d/<docId>')`. |
| `/d/:docId` | `DocumentPage` | Fetches doc metadata, renders chrome + iframe. |
| `*` | `NotFoundPage` | Plain not-found state. |

Version-pinned URL (`/d/:docId/v/:versionNumber`) is deferred to sub-project 4.

### Data fetching

TanStack Query with a single `QueryClientProvider` at the app root. Sub-project 1 has one query (`documents.byId`). The 10s polling pattern sub-project 3 needs is the same hook with `refetchInterval` set — no swap-out later.

### Styling

Tailwind CSS installed locally in `apps/web` (NOT loaded from `cdn.tailwindcss.com` — that origin is allowlisted in the *iframe* CSP for artifacts, not for our chrome). No component library; native HTML elements with Tailwind classes for sub-project 1. shadcn/ui likely added in sub-project 3 when the sidebar lands.

### State

Server state via TanStack Query, component state via React's built-ins. No Redux/Zustand.

## Dev process orchestration

| Process | Port | Command | Notes |
|---|---|---|---|
| Hono API | 3000 | `tsx watch src/index.ts` | Reads `DATABASE_URL`, `STORAGE_ROOT`, `PORT`. |
| Vite dev server | 5173 | `vite` | Proxies `/api/*` and `/companion/*` to `http://localhost:3000`. |

Both started by `pnpm dev` at repo root (which is `pnpm -r --parallel run dev`). The developer opens `http://localhost:5173`.

In production (when we deploy in a later sub-project), Hono will serve `apps/web/dist` as static files with an SPA fallback. One process, one port. The layout supports this without rework but the implementation lands later.

## Configuration

`.env.example` (committed) lists every variable. `.env` (gitignored) holds the actual local values.

```
DATABASE_URL=postgres://primer:primer@localhost:5432/primer
STORAGE_ROOT=./storage
PORT=3000
LOG_LEVEL=info
```

The Postgres credentials in dev are fixed-and-known (`primer/primer`). Don't reuse anywhere.

## Logging

`pino` JSON logger in `apps/api/src/logger.ts`. Default `info` in dev, configurable via `LOG_LEVEL` env var. Every API request logs a single line with `{ method, path, status, ms, user_id, document_id?, version_id? }`. Upload pipeline emits `debug`-level events at each stage transition (`validate_ok`, `parse_ok`, `sanitize_ok`, `storage_put_ok`, `db_insert_ok`) so failures can be traced without enabling DB query logging.

## Testing strategy

### Tier 1 — Unit tests (pure functions, no I/O)

- `validateUpload(input)` — 10 MiB cap, `.html` extension check (case-insensitive), empty-title rejection, content-type sanity check.
- `sanitizeHtml(parse5Tree)` — strips `<iframe>` and `<meta http-equiv="refresh">` (case-insensitive on `http-equiv` value). Round-trips other elements unchanged: `<script>`, `<form>`, inline `onclick`, `<canvas>`, SVG sub-trees.
- `injectCompanionScript(parse5Tree)` — adds the script tag as the last child of `<body>`. Works on inputs without explicit `<body>` (parse5 normalizes).

These are the prime TDD targets — pure functions with clean inputs and outputs.

### Tier 2 — Integration tests (real Postgres, real filesystem)

Use the same Docker Compose Postgres but with a separate database (`primer_test`). Tests open a transaction per test and roll back. Filesystem storage points at a per-run temp dir (`os.tmpdir()/primer-test-<runId>`), cleaned up at end.

Required cases:

- **Happy path:** `POST /api/upload` with a small fixture → 200 with `{ documentId, versionId, url }`. Assert `documents` and `versions` rows exist with the mock user as uploader. Assert the stored file on disk parses and contains the companion script tag.
- **CSP headers:** `GET /api/versions/:id/content` → 200 with every directive from the locked artifact CSP, asserted as a literal string match. Pinning the header value catches accidental loosening.
- **Sandbox attrs:** snapshot test on the `ArtifactIframe` component to lock the literal `sandbox="allow-scripts allow-forms"`.
- **Compensating delete:** mock the DB-insert to throw; assert that the storage file is deleted before the error response is returned.
- **Rejection paths:** one test per error code — `too_large`, `bad_extension`, `bad_content_type`, `missing_title`, `missing_file`, `parse_failed`.

### Tier 3 — Frontend tests

Skipped for sub-project 1. The UI surface is too small to be worth the harness setup and is likely to churn in sub-project 3. Reintroduced when the sidebar / comment UI lands.

## Exit criteria

Sub-project 1 is done when **all** of these hold:

1. `pnpm install --frozen-lockfile && pnpm db:up && pnpm db:migrate && pnpm dev` boots both processes cleanly from a fresh clone.
2. From `http://localhost:5173`, a user can upload a self-contained HTML file with a title and optional description.
3. On successful upload, the browser lands on `/d/<docId>` showing the artifact rendered inside a sandboxed iframe with the exact CSP from the artifact endpoint section applied.
4. `GET /companion/v1.js` returns 200 with `application/javascript`. The iframe's console shows the stub's `console.log` line.
5. The upload pipeline strips `<iframe>` and `<meta http-equiv="refresh">` and preserves every other element type. A fixture test demonstrates this.
6. `pnpm verify` (typecheck + tests + audit) passes green from a fresh clone.
7. Supply-chain settings are enforced: `pnpm install --frozen-lockfile` succeeds, and a one-shot manual check confirms `pnpm install` of a package version < 14 days old is refused. This manual check is documented in the README.

## Deferred / out of scope (restated)

- Companion script body (sub-project 2)
- Comments, threading, sidebar, polling (sub-project 3)
- Multi-version per document, version selector, soft-delete UI, recently-deleted, metadata editing (sub-project 4)
- Real Okta auth, sessions, CSRF, multi-user (sub-project 5)
- Slack notifications, @mention typeahead (sub-project 6)
- Element-path anchor resolution fallback, drift indicator, internal alpha (sub-project 7)
- Production deploy, Railway integration, observability, tracing

## Open items the implementation plan should resolve

These don't change the design — they're the exact-version pins and small detail picks that should be made at scaffold time using then-current values:

- Exact pinned versions for: pnpm (in `packageManager`), Node (in `engines.node` + `.nvmrc`), Postgres image tag, and each direct dep in the three `package.json` files. Pinned to current stable when the scaffold lands.
- Exact `parse5` API surface used (which versions of parse5 expose which traversal helpers shift between majors).
- Exact `uuid` package version chosen for UUIDv7 support.
- Whether `wait-on` (used in `db:reset` script) is the right helper or if Docker Compose's healthcheck-based wait suffices.
- Exact YAML key names for the pnpm-workspace.yaml settings (`minimumReleaseAge`, `blockExoticSubdeps`, `allowBuilds`, `strict-peer-dependencies` vs `strictPeerDependencies`, `engine-strict` vs `engineStrict`) verified against the pnpm 11 docs at scaffold time. The semantics are locked above; only the literal key casing needs confirmation against the version of pnpm pinned.
- Whether the `pnpm approve-builds` command in pnpm 11 still edits `allowBuilds` (it edited `onlyBuiltDependencies` in pnpm 10). If not, the equivalent flow for approving a postinstall script is documented in the README.
