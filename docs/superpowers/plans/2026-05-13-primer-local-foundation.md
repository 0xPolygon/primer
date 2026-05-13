# Primer Sub-Project 1 (Local Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a local-only Primer foundation: a single mock user can upload a self-contained HTML file via a Vite/React UI and view the result inside a sandboxed iframe served by a Hono API, with all PRD-mandated CSP and supply-chain defenses in place from the first commit.

**Architecture:** pnpm workspaces (`apps/api` + `apps/web` + `packages/shared`). Hono on Node 24 LTS serves the API and a static companion script. Drizzle ORM (Postgres 17 via Docker Compose) is the persistence layer; HTML artifacts live on the local filesystem behind a `Storage` interface. The React/Vite frontend runs as a separate dev process with a proxy to Hono. All install scripts default-deny via pnpm 11's `allowBuilds: {}`; every dependency version installed must be at least 14 days old (`minimumReleaseAge: 20160`).

**Tech Stack:** Node 24 LTS, pnpm 11.1.0, TypeScript 5.x, Hono 4.12.x, Drizzle ORM 0.45.x, postgres.js 3.4.x, parse5 7.x, uuid 10.x, React 19.x, Vite 7.x, React Router 7.9.x, TanStack Query 5.x, Tailwind CSS 4.x, Vitest, pino, Postgres 17.10.

**Companion spec:** `docs/superpowers/specs/2026-05-13-primer-local-foundation-design.md`

---

## Pre-flight assumptions

- Working directory: `/home/taylan/development/polygon/primer`
- Branch: `master` is clean; create a feature branch for this work (e.g., `feat/local-foundation`).
- Already installed locally: Docker (or Docker-compatible runtime), Corepack (ships with Node), Git, `psql` client (optional, used in some verification steps).
- The `docs/` tree already contains the PRD, decomposition doc, and the design spec. None of those files are edited by this plan.

---

## Phase 1 — Repo scaffold + supply-chain hardening

### Task 1: Root files and Docker Compose

**Files:**
- Create: `package.json`
- Create: `pnpm-workspace.yaml`
- Create: `.nvmrc`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `docker-compose.yml`
- Create: `docker/init-db.sql`
- Create: `README.md` (skeleton — fully filled in by Task 33)

- [ ] **Step 1: Set up Node + Corepack**

Run:
```bash
corepack enable
node --version    # Expected: v24.x.x (any 24 LTS minor)
```

If Node is not 24.x, install Node 24 LTS first (via `nvm`, your system package manager, or another method). Then re-run `corepack enable`.

- [ ] **Step 2: Create `.nvmrc`**

File: `.nvmrc`

```
24
```

- [ ] **Step 3: Create `.gitignore`**

File: `.gitignore`

```
node_modules/
dist/
.env
.env.local
*.log
.DS_Store
storage/
coverage/
.vitest-tmp/
```

- [ ] **Step 4: Create `.env.example`**

File: `.env.example`

```
DATABASE_URL=postgres://primer:primer@localhost:5432/primer
DATABASE_URL_TEST=postgres://primer:primer@localhost:5432/primer_test
STORAGE_ROOT=./storage
PORT=3000
LOG_LEVEL=info
```

The test DB (`primer_test`) is a separate database on the same Postgres instance — created by the init script (Step 7) so tests never touch dev state.

- [ ] **Step 5: Create root `package.json`**

File: `package.json`

```json
{
  "name": "primer",
  "private": true,
  "packageManager": "pnpm@11.1.0",
  "engines": {
    "node": ">=24.0.0 <25.0.0"
  },
  "scripts": {
    "dev": "pnpm -r --parallel run dev",
    "build": "pnpm -r run build",
    "typecheck": "pnpm -r run typecheck",
    "test": "pnpm -r run test",
    "verify": "pnpm typecheck && pnpm test && pnpm audit --audit-level=high",
    "db:up": "docker compose up -d postgres",
    "db:down": "docker compose down",
    "db:reset": "docker compose down -v && docker compose up -d postgres && sleep 3 && pnpm db:migrate",
    "db:migrate": "pnpm --filter @primer/api run db:migrate",
    "db:migrate:test": "DATABASE_URL=$DATABASE_URL_TEST pnpm --filter @primer/api run db:migrate",
    "db:generate": "pnpm --filter @primer/api run db:generate"
  }
}
```

- [ ] **Step 6: Create `pnpm-workspace.yaml` with supply-chain settings**

File: `pnpm-workspace.yaml`

```yaml
packages:
  - 'apps/*'
  - 'packages/*'

# Supply-chain hardening (see design spec, Section "Supply-chain hardening")
minimumReleaseAge: 20160          # 14 days, in minutes
blockExoticSubdeps: true
allowBuilds: {}                   # empty allowlist; all postinstall/preinstall scripts denied
strictPeerDependencies: true
engineStrict: true
```

Note: the exact YAML key names follow pnpm 11's consolidated config. If `pnpm install` later warns about unrecognized keys, run `pnpm config get <key>` for each to identify the canonical name (kebab-case vs camelCase) and adjust.

- [ ] **Step 7: Create `docker/init-db.sql` and `docker-compose.yml`**

File: `docker/init-db.sql`

```sql
-- Runs once on first Postgres boot (mounted into /docker-entrypoint-initdb.d/).
-- Creates the separate test database called for by the design spec.
CREATE DATABASE primer_test OWNER primer;
```

File: `docker-compose.yml`

```yaml
services:
  postgres:
    image: postgres:17.10
    restart: unless-stopped
    environment:
      POSTGRES_USER: primer
      POSTGRES_PASSWORD: primer
      POSTGRES_DB: primer
    ports:
      - "5432:5432"
    volumes:
      - primer-pg:/var/lib/postgresql/data
      - ./docker/init-db.sql:/docker-entrypoint-initdb.d/00-init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U primer -d primer"]
      interval: 2s
      timeout: 2s
      retries: 20

volumes:
  primer-pg:
```

The init script only runs when the Postgres volume is empty (first boot). If you ever need to re-run it, drop the volume: `docker compose down -v`.

- [ ] **Step 8: Create README skeleton**

File: `README.md`

```markdown
# Primer

Internal Polygon tool for hosting and collaborating on LLM-generated HTML artifacts.

This is sub-project 1: the local foundation. See `docs/prd-primer.md` for the product, and `docs/superpowers/specs/2026-05-13-primer-local-foundation-design.md` for what's in scope here.

## Quickstart

(filled in by Task 33)
```

- [ ] **Step 9: Stage and commit**

Run:
```bash
git checkout -b feat/local-foundation
git add .gitignore .nvmrc .env.example package.json pnpm-workspace.yaml docker-compose.yml docker/init-db.sql README.md
git status
git commit -m "chore: scaffold root with workspaces and supply-chain hardening"
```

Expected: commit succeeds, 8 files added.

---

### Task 2: Install pnpm and verify supply-chain config

**Files:**
- Create: `pnpm-lock.yaml` (generated)

- [ ] **Step 1: Use the pinned pnpm via Corepack**

Run:
```bash
corepack use pnpm@11.1.0
pnpm --version    # Expected: 11.1.0
```

This downloads pnpm 11.1.0 if not cached and updates `packageManager` in `package.json` if Corepack rewrites it (it should already match).

- [ ] **Step 2: Run install to create the lockfile**

Run:
```bash
pnpm install
```

Expected:
- Install succeeds (no errors).
- A `pnpm-lock.yaml` is created.
- The supply-chain settings are honored — there are no warnings about unrecognized keys in `pnpm-workspace.yaml`. If you see "Unknown setting 'X'", fix the key name and re-run.

- [ ] **Step 3: Verify `minimumReleaseAge` actively blocks fresh versions**

Run:
```bash
pnpm add --save-dev hono@4.12.18 --filter primer
```

Expected: install **fails** with an error mentioning `minimum-release-age` (or similar) because `hono@4.12.18` was published less than 14 days ago. If install succeeds, the supply-chain gate is not active — investigate before continuing.

Then **revert** any partial changes:
```bash
git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml
```

- [ ] **Step 4: Commit the lockfile**

Run:
```bash
git add pnpm-lock.yaml
git commit -m "chore: lockfile from initial pnpm install"
```

---

### Task 3: Bring up Postgres and confirm reachability

**Files:** (none)

- [ ] **Step 1: Start Postgres**

Run:
```bash
pnpm db:up
docker compose ps
```

Expected: `postgres` service shows `running (healthy)` after a few seconds.

- [ ] **Step 2: Smoke-test the connection**

Run (either of):
```bash
docker compose exec postgres psql -U primer -d primer -c "select version();"
# OR if you have psql installed locally:
PGPASSWORD=primer psql -h localhost -U primer -d primer -c "select version();"
```

Expected: prints `PostgreSQL 17.10 on ...` row.

- [ ] **Step 3: Leave Postgres running**

Postgres needs to stay up for the rest of the plan. To tear down at end of day: `pnpm db:down` (volume persists) or `docker compose down -v` (drops data).

No commit for this task — it's a verification gate.

---

## Phase 2 — Shared package (data model, types, interfaces)

### Task 4: Scaffold `packages/shared`

**Files:**
- Create: `packages/shared/package.json`
- Create: `packages/shared/tsconfig.json`
- Create: `packages/shared/src/index.ts`

- [ ] **Step 1: Create package.json**

File: `packages/shared/package.json`

```json
{
  "name": "@primer/shared",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "main": "./src/index.ts",
  "types": "./src/index.ts",
  "exports": {
    ".": "./src/index.ts",
    "./schema": "./src/schema.ts",
    "./storage": "./src/storage.ts",
    "./api": "./src/api.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "echo 'no shared tests yet'"
  }
}
```

(`@primer/shared` is consumed by `apps/api` and `apps/web` as a source-only workspace dep; no build step needed.)

- [ ] **Step 2: Create tsconfig.json**

File: `packages/shared/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create barrel `index.ts`**

File: `packages/shared/src/index.ts`

```ts
export * from './schema.ts';
export * from './storage.ts';
export * from './api.ts';
```

- [ ] **Step 4: Install Drizzle ORM**

Run:
```bash
pnpm add drizzle-orm --filter @primer/shared
pnpm --filter @primer/shared add -D drizzle-kit typescript@^5
```

Expected: installs succeed. Versions captured in lockfile — Drizzle should resolve to a `0.45.x` (or whatever the highest published-at-least-14-days-ago is at install time).

- [ ] **Step 5: Commit**

Run:
```bash
git add packages/shared package.json pnpm-lock.yaml
git commit -m "chore: scaffold @primer/shared workspace package"
```

---

### Task 5: Drizzle schema for all PRD tables

**Files:**
- Create: `packages/shared/src/schema.ts`

- [ ] **Step 1: Write the schema**

File: `packages/shared/src/schema.ts`

```ts
import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  jsonb,
  bigint,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),                                       // Okta sub (Phase 2) or "mock-user-1" (Phase 1)
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  slackUserId: text('slack_user_id'),                                // nullable; populated in Phase 2
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey(),
  title: text('title').notNull(),
  description: text('description'),
  uploaderId: text('uploader_id').notNull().references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

export const versions = pgTable(
  'versions',
  {
    id: uuid('id').primaryKey(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    versionNumber: integer('version_number').notNull(),
    storageKey: text('storage_key').notNull(),
    sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull(),
    versionNote: text('version_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    uniqDocVersion: uniqueIndex('versions_doc_version_unique').on(
      t.documentId,
      t.versionNumber
    ),
  })
);

export const threads = pgTable('threads', {
  id: uuid('id').primaryKey(),
  versionId: uuid('version_id')
    .notNull()
    .references(() => versions.id, { onDelete: 'cascade' }),
  anchor: jsonb('anchor').notNull(),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: text('resolved_by').references(() => users.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const comments = pgTable('comments', {
  id: uuid('id').primaryKey(),
  threadId: uuid('thread_id')
    .notNull()
    .references(() => threads.id, { onDelete: 'cascade' }),
  authorId: text('author_id').notNull().references(() => users.id),
  body: text('body').notNull(),
  mentions: text('mentions').array().notNull().default([]),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});
```

- [ ] **Step 2: Typecheck**

Run:
```bash
pnpm --filter @primer/shared typecheck
```

Expected: no errors.

- [ ] **Step 3: Commit**

Run:
```bash
git add packages/shared/src/schema.ts
git commit -m "feat(shared): Drizzle schema for users/documents/versions/threads/comments"
```

---

### Task 6: Storage interface and API DTOs

**Files:**
- Create: `packages/shared/src/storage.ts`
- Create: `packages/shared/src/api.ts`

- [ ] **Step 1: Storage interface**

File: `packages/shared/src/storage.ts`

```ts
export interface Storage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<ReadableStream<Uint8Array>>;
  delete(key: string): Promise<void>;
}

export type StorageKey = string;
```

- [ ] **Step 2: API DTOs**

File: `packages/shared/src/api.ts`

```ts
export interface UploadResponse {
  documentId: string;
  versionId: string;
  url: string;
}

export type UploadErrorCode =
  | 'validation_failed'
  | 'parse_failed'
  | 'too_large'
  | 'bad_extension'
  | 'bad_content_type'
  | 'missing_title'
  | 'missing_file'
  | 'internal';

export interface UploadErrorResponse {
  error: UploadErrorCode;
  message: string;
}

export interface DocumentSummary {
  id: string;
  title: string;
  description: string | null;
  uploaderDisplayName: string;
  createdAt: string;          // ISO timestamp
}

export interface VersionSummary {
  id: string;
  versionNumber: number;
  versionNote: string | null;
  sizeBytes: number;
  createdAt: string;          // ISO timestamp
}

export interface DocumentDetailResponse {
  document: DocumentSummary;
  latestVersion: VersionSummary;
}
```

- [ ] **Step 3: Typecheck**

Run:
```bash
pnpm --filter @primer/shared typecheck
```

Expected: no errors.

- [ ] **Step 4: Commit**

Run:
```bash
git add packages/shared/src/storage.ts packages/shared/src/api.ts
git commit -m "feat(shared): Storage interface and API request/response DTOs"
```

---

## Phase 3 — API scaffold and database wiring

### Task 7: Scaffold `apps/api`

**Files:**
- Create: `apps/api/package.json`
- Create: `apps/api/tsconfig.json`
- Create: `apps/api/vitest.config.ts`

- [ ] **Step 1: package.json**

File: `apps/api/package.json`

```json
{
  "name": "@primer/api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest",
    "db:generate": "drizzle-kit generate",
    "db:migrate": "tsx src/db/migrate.ts"
  },
  "dependencies": {
    "@primer/shared": "workspace:*"
  }
}
```

- [ ] **Step 2: tsconfig.json**

File: `apps/api/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: vitest.config.ts**

File: `apps/api/vitest.config.ts`

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: { enabled: false },
    // Force every test against the separate test database (see design spec).
    // The db client module reads DATABASE_URL at import time; vitest sets these
    // before any test file is loaded, so this guarantees no test ever talks to
    // the dev database.
    env: {
      DATABASE_URL: 'postgres://primer:primer@localhost:5432/primer_test',
    },
  },
});
```

- [ ] **Step 4: Install runtime + dev deps**

Run:
```bash
pnpm --filter @primer/api add hono @hono/node-server postgres drizzle-orm parse5 uuid pino pino-pretty
pnpm --filter @primer/api add -D typescript tsx vitest @types/node @types/uuid drizzle-kit
```

Expected: each install completes, versions land in the lockfile, no postinstall scripts run (any package that would have requested one would prompt for `pnpm approve-builds` — investigate any such prompt before approving).

- [ ] **Step 5: Commit**

Run:
```bash
git add apps/api/package.json apps/api/tsconfig.json apps/api/vitest.config.ts package.json pnpm-lock.yaml
git commit -m "chore(api): scaffold @primer/api with Hono and Drizzle deps"
```

---

### Task 8: Drizzle config and DB client

**Files:**
- Create: `apps/api/drizzle.config.ts`
- Create: `apps/api/src/db/client.ts`
- Create: `apps/api/src/db/migrate.ts`

- [ ] **Step 1: drizzle.config.ts**

File: `apps/api/drizzle.config.ts`

```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  schema: '../../packages/shared/src/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://primer:primer@localhost:5432/primer',
  },
  strict: true,
  verbose: true,
});
```

- [ ] **Step 2: DB client**

File: `apps/api/src/db/client.ts`

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from '@primer/shared/schema';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required');
}

export const sql = postgres(url, { max: 10 });
export const db = drizzle(sql, { schema });
export type Db = typeof db;
```

- [ ] **Step 3: Migration runner**

File: `apps/api/src/db/migrate.ts`

```ts
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error('DATABASE_URL is required');
}

const migrationClient = postgres(url, { max: 1 });
const db = drizzle(migrationClient);

await migrate(db, { migrationsFolder: './drizzle' });
console.log('Migrations applied.');
await migrationClient.end();
```

- [ ] **Step 4: Generate the first migration**

Run:
```bash
cp .env.example .env
cd apps/api
pnpm db:generate
cd ../..
ls apps/api/drizzle
```

Expected: a new file like `apps/api/drizzle/0000_<random-name>.sql` is present containing CREATE TABLE statements for users, documents, versions, threads, comments plus the unique index. Open and review the SQL to confirm it matches the schema.

- [ ] **Step 5: Add the seed migration**

The generated migration creates tables. We need a second migration that seeds the mock user. Create the seed migration manually so `drizzle-kit` doesn't try to regenerate it on schema changes.

File: `apps/api/drizzle/0001_seed_mock_user.sql`

```sql
-- Seed the single mock user used by Phase 1.
-- See sub-project 5 (Auth + ownership) for replacement with real Okta resolution.
INSERT INTO users (id, email, display_name)
VALUES ('mock-user-1', 'mock@polygon.technology', 'Mock User')
ON CONFLICT (id) DO NOTHING;
```

Also append a journal entry. Check the existing `apps/api/drizzle/meta/_journal.json` for the format. Add an entry mirroring the 0000 entry but with `idx: 1`, a new `tag: "0001_seed_mock_user"`, and the current timestamp in `when`. If you're unsure of the exact JSON shape, run `pnpm db:generate` once more after creating a trivial schema change, observe how it appends to `_journal.json`, then revert the trivial change. Do not commit a regenerated 0000 migration — only add 0001.

- [ ] **Step 6: Run migrations against both DBs**

Run:
```bash
pnpm db:migrate
pnpm db:migrate:test
```

Expected: each prints `Migrations applied.` The `db:migrate:test` script (defined in root `package.json`) overrides `DATABASE_URL` with the test DB URL for that one invocation, so both `primer` and `primer_test` get the same schema + mock-user seed.

- [ ] **Step 7: Verify seed row**

Run:
```bash
docker compose exec postgres psql -U primer -d primer -c "select id, email, display_name from users;"
```

Expected: one row with `mock-user-1`.

- [ ] **Step 8: Commit**

Run:
```bash
git add apps/api/drizzle.config.ts apps/api/src/db apps/api/drizzle .env.example
git commit -m "feat(api): Drizzle client, migration runner, initial migration + mock user seed"
```

---

### Task 9: Hono app skeleton + pino logger

**Files:**
- Create: `apps/api/src/logger.ts`
- Create: `apps/api/src/app.ts`
- Create: `apps/api/src/index.ts`

- [ ] **Step 1: Logger**

File: `apps/api/src/logger.ts`

```ts
import { pino } from 'pino';

const isDev = process.env.NODE_ENV !== 'production';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport: isDev
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } }
    : undefined,
});
```

- [ ] **Step 2: Hono app (no routes yet)**

File: `apps/api/src/app.ts`

```ts
import { Hono } from 'hono';
import { logger as appLogger } from './logger.ts';

export type AppVariables = {
  user: { id: string; email: string; displayName: string };
};

export function createApp(): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    appLogger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms,
        user_id: c.get('user')?.id,
      },
      'request'
    );
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  return app;
}
```

- [ ] **Step 3: Entrypoint**

File: `apps/api/src/index.ts`

```ts
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { logger } from './logger.ts';

const port = Number(process.env.PORT ?? 3000);
const app = createApp();

serve({ fetch: app.fetch, port }, () => {
  logger.info({ port }, 'primer api listening');
});
```

- [ ] **Step 4: Boot the API and hit health**

Run (in one terminal):
```bash
pnpm --filter @primer/api dev
```

In another terminal:
```bash
curl -s http://localhost:3000/api/health
```

Expected: `{"ok":true}`. The request is also logged in the dev terminal.

Stop the dev server (`Ctrl+C`) before continuing.

- [ ] **Step 5: Commit**

Run:
```bash
git add apps/api/src/app.ts apps/api/src/index.ts apps/api/src/logger.ts
git commit -m "feat(api): Hono app skeleton with health route and pino request logging"
```

---

### Task 10: Mock-user middleware (TDD)

**Files:**
- Create: `apps/api/src/middleware/mockUser.ts`
- Create: `apps/api/src/middleware/mockUser.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write the failing test**

File: `apps/api/src/middleware/mockUser.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { mockUserMiddleware, MOCK_USER } from './mockUser.ts';
import type { AppVariables } from '../app.ts';

describe('mockUserMiddleware', () => {
  it('sets the mock user on the request context', async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use('*', mockUserMiddleware);
    app.get('/whoami', (c) => c.json(c.get('user')));

    const res = await app.request('/whoami');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MOCK_USER);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
pnpm --filter @primer/api test
```

Expected: FAIL with `Cannot find module './mockUser.ts'` or similar.

- [ ] **Step 3: Implement**

File: `apps/api/src/middleware/mockUser.ts`

```ts
import type { MiddlewareHandler } from 'hono';
import type { AppVariables } from '../app.ts';

export const MOCK_USER: AppVariables['user'] = {
  id: 'mock-user-1',
  email: 'mock@polygon.technology',
  displayName: 'Mock User',
};

export const mockUserMiddleware: MiddlewareHandler<{ Variables: AppVariables }> = async (
  c,
  next
) => {
  c.set('user', MOCK_USER);
  await next();
};
```

- [ ] **Step 4: Mount the middleware globally**

Modify `apps/api/src/app.ts` — add the import and `app.use('*', mockUserMiddleware)` *before* the logging middleware (so logs see the user_id). Final shape:

```ts
import { Hono } from 'hono';
import { logger as appLogger } from './logger.ts';
import { mockUserMiddleware } from './middleware/mockUser.ts';

export type AppVariables = {
  user: { id: string; email: string; displayName: string };
};

export function createApp(): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use('*', mockUserMiddleware);

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    appLogger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms,
        user_id: c.get('user')?.id,
      },
      'request'
    );
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  return app;
}
```

- [ ] **Step 5: Run tests — verify pass**

Run:
```bash
pnpm --filter @primer/api test
```

Expected: 1 passing.

- [ ] **Step 6: Commit**

Run:
```bash
git add apps/api/src/middleware apps/api/src/app.ts
git commit -m "feat(api): mock-user middleware (single fixed user for Phase 1)"
```

---

### Task 11: DB round-trip test against the seed row

**Files:**
- Create: `apps/api/src/db/client.test.ts`

- [ ] **Step 1: Write the test**

File: `apps/api/src/db/client.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from './client.ts';
import { users } from '@primer/shared/schema';

describe('db client', () => {
  it('reads the seeded mock user', async () => {
    const rows = await db.select().from(users).where(eq(users.id, 'mock-user-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'mock-user-1',
      email: 'mock@polygon.technology',
      displayName: 'Mock User',
    });
  });
});
```

- [ ] **Step 2: Run**

Run:
```bash
pnpm --filter @primer/api test
```

Expected: passes. `vitest.config.ts` already pins `DATABASE_URL` to the test DB URL for tests, so no inline env override is needed. The mock user row exists in `primer_test` because Task 8 ran migrations against both DBs.

- [ ] **Step 3: Commit**

Run:
```bash
git add apps/api/src/db/client.test.ts
git commit -m "test(api): DB client round-trip against the seeded mock user"
```

---

## Phase 4 — Storage interface implementation

### Task 12: FilesystemStorage `put` (TDD)

**Files:**
- Create: `apps/api/src/storage/filesystem.ts`
- Create: `apps/api/src/storage/filesystem.test.ts`

- [ ] **Step 1: Failing test for `put` + readback**

File: `apps/api/src/storage/filesystem.test.ts`

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FilesystemStorage } from './filesystem.ts';

let root: string;
let storage: FilesystemStorage;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'primer-storage-test-'));
  storage = new FilesystemStorage(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('FilesystemStorage.put', () => {
  it('writes bytes under the configured root, creating parent dirs', async () => {
    const bytes = new TextEncoder().encode('<html></html>');
    await storage.put('v1/abc.html', bytes);

    const onDisk = await readFile(join(root, 'v1/abc.html'));
    expect(onDisk).toEqual(Buffer.from(bytes));
  });

  it('overwrites an existing file at the same key', async () => {
    await storage.put('v1/abc.html', new TextEncoder().encode('first'));
    await storage.put('v1/abc.html', new TextEncoder().encode('second'));

    const onDisk = await readFile(join(root, 'v1/abc.html'), 'utf8');
    expect(onDisk).toBe('second');
  });
});
```

- [ ] **Step 2: Verify it fails**

Run:
```bash
pnpm --filter @primer/api test storage
```

Expected: FAIL — file doesn't exist.

- [ ] **Step 3: Implement `put`**

File: `apps/api/src/storage/filesystem.ts`

```ts
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Storage } from '@primer/shared/storage';

export class FilesystemStorage implements Storage {
  constructor(private readonly root: string) {}

  async put(key: string, bytes: Uint8Array): Promise<void> {
    const target = this.resolve(key);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }

  // Other methods added in subsequent tasks.
  async get(_key: string): Promise<ReadableStream<Uint8Array>> {
    throw new Error('not implemented');
  }
  async delete(_key: string): Promise<void> {
    throw new Error('not implemented');
  }

  private resolve(key: string): string {
    if (key.startsWith('/') || key.includes('..')) {
      throw new Error(`invalid storage key: ${key}`);
    }
    return join(this.root, key);
  }
}
```

- [ ] **Step 4: Run — verify pass**

Run:
```bash
pnpm --filter @primer/api test storage
```

Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

Run:
```bash
git add apps/api/src/storage
git commit -m "feat(api): FilesystemStorage.put with parent dir creation and key safety check"
```

---

### Task 13: FilesystemStorage `get` (TDD)

**Files:**
- Modify: `apps/api/src/storage/filesystem.ts`
- Modify: `apps/api/src/storage/filesystem.test.ts`

- [ ] **Step 1: Add failing test**

Append to `apps/api/src/storage/filesystem.test.ts`:

```ts
describe('FilesystemStorage.get', () => {
  it('returns a ReadableStream of the file contents', async () => {
    const bytes = new TextEncoder().encode('<h1>hi</h1>');
    await storage.put('v1/abc.html', bytes);

    const stream = await storage.get('v1/abc.html');
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    const merged = Buffer.concat(chunks.map((c) => Buffer.from(c)));
    expect(merged.toString('utf8')).toBe('<h1>hi</h1>');
  });

  it('throws on missing key', async () => {
    await expect(storage.get('v1/nope.html')).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @primer/api test storage`

Expected: 2 new tests fail with `not implemented`.

- [ ] **Step 3: Implement**

In `apps/api/src/storage/filesystem.ts`, replace the placeholder `get` with:

```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { Readable } from 'node:stream';

// ... inside the class:
async get(key: string): Promise<ReadableStream<Uint8Array>> {
  const target = this.resolve(key);
  await stat(target); // throws ENOENT for missing files
  const nodeStream = createReadStream(target);
  return Readable.toWeb(nodeStream) as ReadableStream<Uint8Array>;
}
```

(Keep the existing imports at the top of the file — add `createReadStream`, `stat`, and `Readable` as new imports.)

- [ ] **Step 4: Verify pass**

Run: `pnpm --filter @primer/api test storage`

Expected: all 4 tests pass.

- [ ] **Step 5: Commit**

Run:
```bash
git add apps/api/src/storage
git commit -m "feat(api): FilesystemStorage.get returning a ReadableStream"
```

---

### Task 14: FilesystemStorage `delete` (TDD)

**Files:**
- Modify: `apps/api/src/storage/filesystem.ts`
- Modify: `apps/api/src/storage/filesystem.test.ts`

- [ ] **Step 1: Failing tests**

Append to `apps/api/src/storage/filesystem.test.ts`:

```ts
import { access } from 'node:fs/promises';

describe('FilesystemStorage.delete', () => {
  it('removes the file at the key', async () => {
    await storage.put('v1/abc.html', new TextEncoder().encode('x'));
    await storage.delete('v1/abc.html');
    await expect(access(join(root, 'v1/abc.html'))).rejects.toThrow();
  });

  it('does not throw when the key is missing (idempotent best-effort delete)', async () => {
    await expect(storage.delete('v1/nope.html')).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @primer/api test storage`

Expected: new tests fail.

- [ ] **Step 3: Implement**

Replace the placeholder `delete` in `apps/api/src/storage/filesystem.ts` with:

```ts
import { unlink } from 'node:fs/promises';

// ... inside the class:
async delete(key: string): Promise<void> {
  try {
    await unlink(this.resolve(key));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw err;
  }
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `pnpm --filter @primer/api test`

Expected: all storage tests + DB test + mock-user test all pass.

```bash
git add apps/api/src/storage
git commit -m "feat(api): FilesystemStorage.delete (idempotent best-effort)"
```

---

## Phase 5 — Upload pipeline pure functions

### Task 15: `validateUpload` (TDD)

**Files:**
- Create: `apps/api/src/upload/validate.ts`
- Create: `apps/api/src/upload/validate.test.ts`

- [ ] **Step 1: Tests**

File: `apps/api/src/upload/validate.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { validateUpload, MAX_BYTES } from './validate.ts';

const okFile = {
  filename: 'report.html',
  contentType: 'text/html',
  bytes: new Uint8Array(1024),
};

describe('validateUpload', () => {
  it('accepts a well-formed upload', () => {
    const r = validateUpload({ file: okFile, title: 'My Report', description: undefined });
    expect(r.ok).toBe(true);
  });

  it('rejects an oversize file', () => {
    const big = { ...okFile, bytes: new Uint8Array(MAX_BYTES + 1) };
    const r = validateUpload({ file: big, title: 't', description: undefined });
    expect(r).toEqual({ ok: false, error: 'too_large', message: expect.any(String) });
  });

  it('rejects non-.html filename', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'report.txt' },
      title: 't',
      description: undefined,
    });
    expect(r).toEqual({ ok: false, error: 'bad_extension', message: expect.any(String) });
  });

  it('accepts .HTML uppercase extension', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'REPORT.HTML' },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects an empty title (after trim)', () => {
    const r = validateUpload({ file: okFile, title: '   ', description: undefined });
    expect(r).toEqual({ ok: false, error: 'missing_title', message: expect.any(String) });
  });

  it('rejects when file is missing', () => {
    const r = validateUpload({ file: undefined, title: 't', description: undefined });
    expect(r).toEqual({ ok: false, error: 'missing_file', message: expect.any(String) });
  });

  it('rejects a bad content-type when one is provided', () => {
    const r = validateUpload({
      file: { ...okFile, contentType: 'application/pdf' },
      title: 't',
      description: undefined,
    });
    expect(r).toEqual({ ok: false, error: 'bad_content_type', message: expect.any(String) });
  });

  it('accepts missing content-type (browsers sometimes omit)', () => {
    const r = validateUpload({
      file: { ...okFile, contentType: undefined },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('caps title at 200 chars', () => {
    const r = validateUpload({ file: okFile, title: 'x'.repeat(201), description: undefined });
    expect(r).toEqual({ ok: false, error: 'validation_failed', message: expect.any(String) });
  });

  it('caps description at 2000 chars', () => {
    const r = validateUpload({ file: okFile, title: 't', description: 'x'.repeat(2001) });
    expect(r).toEqual({ ok: false, error: 'validation_failed', message: expect.any(String) });
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `pnpm --filter @primer/api test validate`

Expected: module not found.

- [ ] **Step 3: Implement**

File: `apps/api/src/upload/validate.ts`

```ts
import type { UploadErrorCode } from '@primer/shared/api';

export const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 2000;

export interface UploadInputFile {
  filename: string;
  contentType: string | undefined;
  bytes: Uint8Array;
}

export interface UploadInput {
  file: UploadInputFile | undefined;
  title: string;
  description: string | undefined;
}

export type ValidateResult =
  | { ok: true; title: string; description: string | null; file: UploadInputFile }
  | { ok: false; error: UploadErrorCode; message: string };

export function validateUpload(input: UploadInput): ValidateResult {
  if (!input.file) {
    return { ok: false, error: 'missing_file', message: 'A file is required.' };
  }

  const title = input.title.trim();
  if (title.length === 0) {
    return { ok: false, error: 'missing_title', message: 'Title is required.' };
  }
  if (title.length > MAX_TITLE) {
    return {
      ok: false,
      error: 'validation_failed',
      message: `Title must be ${MAX_TITLE} characters or fewer.`,
    };
  }

  const description = input.description?.trim() ?? '';
  if (description.length > MAX_DESCRIPTION) {
    return {
      ok: false,
      error: 'validation_failed',
      message: `Description must be ${MAX_DESCRIPTION} characters or fewer.`,
    };
  }

  if (input.file.bytes.byteLength > MAX_BYTES) {
    return {
      ok: false,
      error: 'too_large',
      message: `File exceeds the ${MAX_BYTES}-byte limit.`,
    };
  }

  if (!input.file.filename.toLowerCase().endsWith('.html')) {
    return {
      ok: false,
      error: 'bad_extension',
      message: 'File must have a .html extension.',
    };
  }

  if (input.file.contentType !== undefined && input.file.contentType !== 'text/html') {
    return {
      ok: false,
      error: 'bad_content_type',
      message: `Unexpected content-type: ${input.file.contentType}.`,
    };
  }

  return {
    ok: true,
    title,
    description: description.length === 0 ? null : description,
    file: input.file,
  };
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `pnpm --filter @primer/api test validate`

Expected: all tests pass.

```bash
git add apps/api/src/upload
git commit -m "feat(api): validateUpload pure function covering size, extension, content-type, title/desc lengths"
```

---

### Task 16: `sanitizeHtml` (TDD)

**Files:**
- Create: `apps/api/src/upload/sanitize.ts`
- Create: `apps/api/src/upload/sanitize.test.ts`

- [ ] **Step 1: Tests**

File: `apps/api/src/upload/sanitize.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parse, serialize } from 'parse5';
import { stripDisallowedElements } from './sanitize.ts';

function round(html: string): string {
  const doc = parse(html);
  stripDisallowedElements(doc);
  return serialize(doc);
}

describe('stripDisallowedElements', () => {
  it('removes nested <iframe>', () => {
    const out = round('<html><body><p>hi</p><iframe src="x"></iframe></body></html>');
    expect(out).toContain('<p>hi</p>');
    expect(out).not.toContain('<iframe');
  });

  it('removes <meta http-equiv="refresh">', () => {
    const out = round(
      '<html><head><meta http-equiv="refresh" content="0;url=evil"></head><body>ok</body></html>'
    );
    expect(out).not.toContain('http-equiv');
  });

  it('matches http-equiv case-insensitively', () => {
    const out = round(
      '<html><head><meta HTTP-EQUIV="Refresh" content="0;url=evil"></head><body>ok</body></html>'
    );
    expect(out.toLowerCase()).not.toContain('http-equiv');
  });

  it('preserves <script>, <form>, inline event handlers, <canvas>, and SVG', () => {
    const input = `<html><body>
      <script>alert(1)</script>
      <form action="/x" onsubmit="return false"><input name="a"></form>
      <div onclick="boom()">click</div>
      <canvas id="c"></canvas>
      <svg><g><rect /></g></svg>
    </body></html>`;
    const out = round(input);
    expect(out).toContain('<script>alert(1)</script>');
    expect(out).toContain('<form');
    expect(out).toContain('onsubmit');
    expect(out).toContain('onclick');
    expect(out).toContain('<canvas');
    expect(out).toContain('<svg');
    expect(out).toContain('<rect');
  });

  it('removes only meta tags whose http-equiv is refresh, not other meta tags', () => {
    const out = round(
      '<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0"></head><body></body></html>'
    );
    expect(out).toContain('charset');
    expect(out).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `pnpm --filter @primer/api test sanitize`

Expected: module not found.

- [ ] **Step 3: Implement**

File: `apps/api/src/upload/sanitize.ts`

```ts
import type { DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

function isElement(n: Node): n is Element {
  return (n as Element).tagName !== undefined;
}

function hasChildNodes(n: Node): n is ParentNode {
  return (n as ParentNode).childNodes !== undefined;
}

function isMetaRefresh(el: Element): boolean {
  if (el.tagName !== 'meta') return false;
  const attr = el.attrs.find((a) => a.name.toLowerCase() === 'http-equiv');
  return !!attr && attr.value.trim().toLowerCase() === 'refresh';
}

function shouldStrip(el: Element): boolean {
  return el.tagName === 'iframe' || isMetaRefresh(el);
}

export function stripDisallowedElements(root: Node): void {
  if (!hasChildNodes(root)) return;
  const keep: Node[] = [];
  for (const child of root.childNodes) {
    if (isElement(child) && shouldStrip(child)) continue;
    stripDisallowedElements(child);
    keep.push(child);
  }
  root.childNodes = keep;
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `pnpm --filter @primer/api test sanitize`

Expected: 5 tests pass.

```bash
git add apps/api/src/upload
git commit -m "feat(api): sanitizeHtml strips iframe and meta-refresh, preserves everything else"
```

---

### Task 17: `injectCompanionScript` (TDD)

**Files:**
- Create: `apps/api/src/upload/inject.ts`
- Create: `apps/api/src/upload/inject.test.ts`

- [ ] **Step 1: Tests**

File: `apps/api/src/upload/inject.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parse, serialize } from 'parse5';
import { injectCompanionScript } from './inject.ts';

function inject(html: string): string {
  const doc = parse(html);
  injectCompanionScript(doc);
  return serialize(doc);
}

describe('injectCompanionScript', () => {
  it('adds the script tag as the last child of <body>', () => {
    const out = inject('<html><body><p>hi</p></body></html>');
    expect(out).toMatch(
      /<p>hi<\/p><script src="\/companion\/v1\.js" defer=""><\/script><\/body>/
    );
  });

  it('works when source has no explicit <body> (parse5 normalizes)', () => {
    const out = inject('<p>standalone</p>');
    expect(out).toContain('<body>');
    expect(out).toContain('<script src="/companion/v1.js"');
  });

  it('adds exactly one script tag even when called once', () => {
    const out = inject('<html><body></body></html>');
    const matches = out.match(/<script src="\/companion\/v1\.js"/g);
    expect(matches?.length).toBe(1);
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `pnpm --filter @primer/api test inject`

Expected: module not found.

- [ ] **Step 3: Implement**

File: `apps/api/src/upload/inject.ts`

```ts
import type { DefaultTreeAdapterMap } from 'parse5';

type Document = DefaultTreeAdapterMap['document'];
type Element = DefaultTreeAdapterMap['element'];
type ChildNode = DefaultTreeAdapterMap['childNode'];

function findBody(doc: Document): Element | null {
  const html = doc.childNodes.find(
    (n): n is Element => (n as Element).tagName === 'html'
  );
  if (!html) return null;
  return (
    html.childNodes.find(
      (n): n is Element => (n as Element).tagName === 'body'
    ) ?? null
  );
}

export function injectCompanionScript(doc: Document): void {
  const body = findBody(doc);
  if (!body) {
    throw new Error('document has no <body> after parse5 normalization');
  }

  const scriptEl: Element = {
    nodeName: 'script',
    tagName: 'script',
    attrs: [
      { name: 'src', value: '/companion/v1.js' },
      { name: 'defer', value: '' },
    ],
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    childNodes: [],
    parentNode: body,
  } as unknown as Element;

  body.childNodes.push(scriptEl as ChildNode);
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `pnpm --filter @primer/api test inject`

Expected: 3 tests pass.

```bash
git add apps/api/src/upload
git commit -m "feat(api): injectCompanionScript adds <script src=/companion/v1.js> to <body>"
```

---

### Task 18: HTML pipeline orchestrator (parse → sanitize → inject → serialize)

**Files:**
- Create: `apps/api/src/upload/htmlPipeline.ts`
- Create: `apps/api/src/upload/htmlPipeline.test.ts`

- [ ] **Step 1: Tests**

File: `apps/api/src/upload/htmlPipeline.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { transformHtml } from './htmlPipeline.ts';

describe('transformHtml', () => {
  it('returns serialized HTML with iframe stripped and companion script injected', () => {
    const input = '<html><body><h1>Report</h1><iframe src="x"></iframe></body></html>';
    const out = transformHtml(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.html).toContain('<h1>Report</h1>');
    expect(out.html).not.toContain('<iframe');
    expect(out.html).toContain('<script src="/companion/v1.js"');
  });

  it('returns parse_failed when input is not parseable as HTML', () => {
    // parse5 is very forgiving; we trigger a failure by passing a non-string.
    // The function expects a string; we test the wider error path via try/catch.
    // For now, parse5 accepts essentially anything string-shaped, so we test a sentinel
    // empty-string input that produces no usable structure.
    const out = transformHtml('');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('parse_failed');
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `pnpm --filter @primer/api test htmlPipeline`

Expected: module not found.

- [ ] **Step 3: Implement**

File: `apps/api/src/upload/htmlPipeline.ts`

```ts
import { parse, serialize } from 'parse5';
import type { UploadErrorCode } from '@primer/shared/api';
import { stripDisallowedElements } from './sanitize.ts';
import { injectCompanionScript } from './inject.ts';

export type TransformResult =
  | { ok: true; html: string }
  | { ok: false; error: UploadErrorCode; message: string };

export function transformHtml(input: string): TransformResult {
  if (input.trim().length === 0) {
    return { ok: false, error: 'parse_failed', message: 'Empty document.' };
  }

  let doc;
  try {
    doc = parse(input);
  } catch (err) {
    return {
      ok: false,
      error: 'parse_failed',
      message: `HTML parse failed: ${(err as Error).message}`,
    };
  }

  const html = doc.childNodes.find(
    (n) => (n as { tagName?: string }).tagName === 'html'
  );
  if (!html) {
    return { ok: false, error: 'parse_failed', message: 'No <html> root after parse.' };
  }

  stripDisallowedElements(doc);
  injectCompanionScript(doc);

  return { ok: true, html: serialize(doc) };
}
```

- [ ] **Step 4: Verify pass + commit**

Run: `pnpm --filter @primer/api test htmlPipeline`

Expected: 2 tests pass.

```bash
git add apps/api/src/upload/htmlPipeline.ts apps/api/src/upload/htmlPipeline.test.ts
git commit -m "feat(api): transformHtml orchestrates parse → sanitize → inject → serialize"
```

---

## Phase 6 — Upload endpoint

### Task 19: Test infra for integration tests

**Files:**
- Create: `apps/api/src/testing/setup.ts`
- Modify: `apps/api/vitest.config.ts`

- [ ] **Step 1: Test setup file**

File: `apps/api/src/testing/setup.ts`

```ts
import { sql } from '../db/client.ts';
import { afterAll, beforeEach } from 'vitest';

beforeEach(async () => {
  // Wipe transactional tables between tests; keep the seeded mock user row.
  await sql`truncate table comments, threads, versions, documents restart identity cascade`;
});

afterAll(async () => {
  await sql.end({ timeout: 5 });
});
```

This deliberately does NOT truncate `users` — the seed row must remain for foreign-key references.

- [ ] **Step 2: Wire the setup into vitest config**

Modify `apps/api/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['src/testing/setup.ts'],
    coverage: { enabled: false },
  },
});
```

- [ ] **Step 3: Verify existing tests still pass**

Run:
```bash
pnpm --filter @primer/api test
```

Expected: all previously-passing tests still pass against `primer_test` (the truncate happens before each test, the seed row stays).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/testing apps/api/vitest.config.ts
git commit -m "test(api): integration-test setup that truncates between tests"
```

---

### Task 20: POST /api/upload — happy path (TDD)

**Files:**
- Create: `apps/api/src/routes/upload.ts`
- Create: `apps/api/src/routes/upload.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Failing integration test**

File: `apps/api/src/routes/upload.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { db } from '../db/client.ts';
import { documents, versions } from '@primer/shared/schema';
import type { UploadResponse } from '@primer/shared/api';

async function withTmpStorage<T>(fn: (storage: FilesystemStorage, root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-upload-test-'));
  try {
    return await fn(new FilesystemStorage(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function buildFormData(html: string, title: string, description?: string): FormData {
  const fd = new FormData();
  fd.append('file', new Blob([html], { type: 'text/html' }), 'report.html');
  fd.append('title', title);
  if (description) fd.append('description', description);
  return fd;
}

describe('POST /api/upload — happy path', () => {
  it('persists doc + version and stores the transformed HTML', async () => {
    await withTmpStorage(async (storage) => {
      const app = createApp({ storage });
      const fd = buildFormData(
        '<html><body><h1>Hi</h1><iframe src="x"></iframe></body></html>',
        'My Report'
      );

      const res = await app.request('/api/upload', { method: 'POST', body: fd });
      expect(res.status).toBe(200);
      const body = (await res.json()) as UploadResponse;
      expect(body.url).toBe(`/d/${body.documentId}`);

      const docRows = await db.select().from(documents).where(eq(documents.id, body.documentId));
      expect(docRows).toHaveLength(1);
      expect(docRows[0]).toMatchObject({
        title: 'My Report',
        uploaderId: 'mock-user-1',
      });

      const versionRows = await db.select().from(versions).where(eq(versions.id, body.versionId));
      expect(versionRows).toHaveLength(1);
      expect(versionRows[0]).toMatchObject({
        documentId: body.documentId,
        versionNumber: 1,
      });

      const stream = await storage.get(versionRows[0].storageKey);
      const reader = stream.getReader();
      let combined = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        combined += new TextDecoder().decode(value);
      }
      expect(combined).toContain('<h1>Hi</h1>');
      expect(combined).not.toContain('<iframe');
      expect(combined).toContain('<script src="/companion/v1.js"');
    });
  });
});
```

- [ ] **Step 2: Verify failure**

Run: `pnpm --filter @primer/api test upload`

Expected: fails because `createApp` doesn't take a storage option yet.

- [ ] **Step 3: Update `createApp` to accept dependencies**

Modify `apps/api/src/app.ts`:

```ts
import { Hono } from 'hono';
import { logger as appLogger } from './logger.ts';
import { mockUserMiddleware } from './middleware/mockUser.ts';
import { registerUploadRoute } from './routes/upload.ts';
import type { Storage } from '@primer/shared/storage';

export type AppVariables = {
  user: { id: string; email: string; displayName: string };
};

export interface AppDeps {
  storage: Storage;
}

export function createApp(deps: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  app.use('*', mockUserMiddleware);

  app.use('*', async (c, next) => {
    const start = Date.now();
    await next();
    const ms = Date.now() - start;
    appLogger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms,
        user_id: c.get('user')?.id,
      },
      'request'
    );
  });

  app.get('/api/health', (c) => c.json({ ok: true }));
  registerUploadRoute(app, deps);

  return app;
}
```

- [ ] **Step 4: Implement the upload route (happy path only — error paths in Task 21)**

File: `apps/api/src/routes/upload.ts`

```ts
import type { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables, AppDeps } from '../app.ts';
import type { UploadResponse } from '@primer/shared/api';
import { documents, versions } from '@primer/shared/schema';
import { validateUpload } from '../upload/validate.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { db } from '../db/client.ts';
import { logger } from '../logger.ts';

export function registerUploadRoute(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
  app.post('/api/upload', async (c) => {
    const form = await c.req.parseBody();
    const file = form['file'];
    const title = typeof form['title'] === 'string' ? form['title'] : '';
    const description =
      typeof form['description'] === 'string' ? form['description'] : undefined;

    let bytes: Uint8Array | undefined;
    let filename = '';
    let contentType: string | undefined;
    if (file instanceof File) {
      bytes = new Uint8Array(await file.arrayBuffer());
      filename = file.name;
      contentType = file.type === '' ? undefined : file.type;
    }

    const validated = validateUpload({
      file: bytes ? { filename, contentType, bytes } : undefined,
      title,
      description,
    });
    if (!validated.ok) {
      return c.json({ error: validated.error, message: validated.message }, 400);
    }

    const text = new TextDecoder('utf-8').decode(validated.file.bytes);
    const transformed = transformHtml(text);
    if (!transformed.ok) {
      return c.json({ error: transformed.error, message: transformed.message }, 400);
    }

    const documentId = uuidv7();
    const versionId = uuidv7();
    const storageKey = `v1/${versionId}.html`;
    const transformedBytes = new TextEncoder().encode(transformed.html);

    await deps.storage.put(storageKey, transformedBytes);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(documents).values({
          id: documentId,
          title: validated.title,
          description: validated.description,
          uploaderId: c.get('user').id,
        });
        await tx.insert(versions).values({
          id: versionId,
          documentId,
          versionNumber: 1,
          storageKey,
          sizeBytes: transformedBytes.byteLength,
          versionNote: null,
        });
      });
    } catch (err) {
      logger.warn({ err, storageKey }, 'db insert failed; attempting compensating delete');
      try {
        await deps.storage.delete(storageKey);
      } catch (cleanupErr) {
        logger.warn({ err: cleanupErr, storageKey }, 'compensating delete also failed');
      }
      return c.json({ error: 'internal', message: 'Failed to persist upload.' }, 500);
    }

    const body: UploadResponse = { documentId, versionId, url: `/d/${documentId}` };
    return c.json(body, 200);
  });
}
```

- [ ] **Step 5: Update entrypoint to inject the real Storage**

Modify `apps/api/src/index.ts`:

```ts
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { logger } from './logger.ts';
import { FilesystemStorage } from './storage/filesystem.ts';

const port = Number(process.env.PORT ?? 3000);
const storageRoot = process.env.STORAGE_ROOT ?? './storage';
const storage = new FilesystemStorage(storageRoot);
const app = createApp({ storage });

serve({ fetch: app.fetch, port }, () => {
  logger.info({ port, storageRoot }, 'primer api listening');
});
```

- [ ] **Step 6: Verify pass**

Run: `pnpm --filter @primer/api test upload`

Expected: happy path test passes.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): POST /api/upload happy path with storage put + transactional DB write"
```

---

### Task 21: Upload endpoint error paths

**Files:**
- Modify: `apps/api/src/routes/upload.test.ts`

- [ ] **Step 1: Add error-path tests**

Append to `apps/api/src/routes/upload.test.ts`:

```ts
describe('POST /api/upload — error paths', () => {
  const make = async () =>
    withTmpStorage(async (storage) => createApp({ storage }));

  it('rejects oversize file with too_large', async () => {
    const app = await make();
    const big = 'x'.repeat(10 * 1024 * 1024 + 1);
    const fd = buildFormData(big, 't');
    const res = await app.request('/api/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'too_large' });
  });

  it('rejects missing title', async () => {
    const app = await make();
    const fd = buildFormData('<html></html>', '   ');
    const res = await app.request('/api/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'missing_title' });
  });

  it('rejects bad extension', async () => {
    const app = await make();
    const fd = new FormData();
    fd.append('file', new Blob(['<html></html>'], { type: 'text/html' }), 'report.txt');
    fd.append('title', 't');
    const res = await app.request('/api/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_extension' });
  });

  it('rejects bad content-type', async () => {
    const app = await make();
    const fd = new FormData();
    fd.append('file', new Blob(['<html></html>'], { type: 'application/pdf' }), 'r.html');
    fd.append('title', 't');
    const res = await app.request('/api/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'bad_content_type' });
  });

  it('rejects missing file', async () => {
    const app = await make();
    const fd = new FormData();
    fd.append('title', 't');
    const res = await app.request('/api/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'missing_file' });
  });

  it('rejects empty (unparseable) HTML', async () => {
    const app = await make();
    const fd = buildFormData('', 't');
    const res = await app.request('/api/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'parse_failed' });
  });
});
```

`make` returns just the app, but `withTmpStorage` also cleans up the dir at the end of its callback. To keep storage alive for the duration of the test, refactor like this — change `make` to return both app and storage, or restructure each test to do `withTmpStorage(async (storage) => { const app = createApp({ storage }); ... })`. For clarity, prefer the inline form below:

Replace the `const make = async ...` block above with inline `withTmpStorage` usage per test, e.g.:

```ts
it('rejects oversize file with too_large', async () => {
  await withTmpStorage(async (storage) => {
    const app = createApp({ storage });
    const big = 'x'.repeat(10 * 1024 * 1024 + 1);
    const fd = buildFormData(big, 't');
    const res = await app.request('/api/upload', { method: 'POST', body: fd });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'too_large' });
  });
});
```

Apply the same wrapping to each error-path test.

- [ ] **Step 2: Run all upload tests**

Run: `pnpm --filter @primer/api test upload`

Expected: all happy + error tests pass. No new implementation needed — the route already returns 400 from validate/transform results.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/upload.test.ts
git commit -m "test(api): exhaustive error-path coverage on POST /api/upload"
```

---

### Task 22: Compensating delete on DB failure (TDD)

**Files:**
- Create: `apps/api/src/routes/upload.compensate.test.ts`

- [ ] **Step 1: Test**

This test forces the second insert to fail (UNIQUE violation on `(document_id, version_number)`) and verifies the storage file is cleaned up. Strategy: monkey-patch the storage `put` to record the key, then perform a second upload with a forced FK violation by pre-inserting a conflicting versions row using the same document/version pair.

Easier approach: monkey-patch the `db` import to make the transaction throw. We do this by stubbing the route's dependency surface via Vitest mocks.

File: `apps/api/src/routes/upload.compensate.test.ts`

```ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';

vi.mock('../db/client.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../db/client.ts')>();
  return {
    ...orig,
    db: {
      ...orig.db,
      transaction: vi.fn(async () => {
        throw new Error('forced DB failure');
      }),
    },
  };
});

describe('POST /api/upload — DB failure triggers compensating delete', () => {
  it('removes the storage file when the DB transaction throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-comp-test-'));
    try {
      const storage = new FilesystemStorage(root);
      const app = createApp({ storage });

      const fd = new FormData();
      fd.append('file', new Blob(['<html><body></body></html>'], { type: 'text/html' }), 'r.html');
      fd.append('title', 't');

      const res = await app.request('/api/upload', { method: 'POST', body: fd });
      expect(res.status).toBe(500);

      // No file should remain under root/v1/
      await expect(access(join(root, 'v1'))).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run + verify pass**

Run: `pnpm --filter @primer/api test compensate`

Expected: passes. The route already wires the compensating delete; this test exercises it.

If the test fails because the `vi.mock` factory doesn't intercept the import correctly with `verbatimModuleSyntax`, you may need to relax `verbatimModuleSyntax: false` in `tsconfig.json` (Vitest's mock hoisting can conflict with strict module syntax). Document the change in the commit message.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/upload.compensate.test.ts
git commit -m "test(api): compensating storage delete fires when DB transaction fails"
```

---

## Phase 7 — Read endpoints

### Task 23: GET /api/documents/:docId (TDD)

**Files:**
- Create: `apps/api/src/routes/documents.ts`
- Create: `apps/api/src/routes/documents.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Test**

File: `apps/api/src/routes/documents.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import type { DocumentDetailResponse, UploadResponse } from '@primer/shared/api';

async function uploadFixture(app: ReturnType<typeof createApp>): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append('file', new Blob(['<html><body><p>x</p></body></html>'], { type: 'text/html' }), 'r.html');
  fd.append('title', 'Fixture');
  fd.append('description', 'desc');
  const res = await app.request('/api/upload', { method: 'POST', body: fd });
  return (await res.json()) as UploadResponse;
}

describe('GET /api/documents/:docId', () => {
  it('returns document + latest version summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-docread-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root) });
      const upload = await uploadFixture(app);

      const res = await app.request(`/api/documents/${upload.documentId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DocumentDetailResponse;

      expect(body.document.id).toBe(upload.documentId);
      expect(body.document.title).toBe('Fixture');
      expect(body.document.description).toBe('desc');
      expect(body.document.uploaderDisplayName).toBe('Mock User');
      expect(body.latestVersion.id).toBe(upload.versionId);
      expect(body.latestVersion.versionNumber).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 for an unknown id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-docread-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root) });
      const res = await app.request('/api/documents/01234567-89ab-cdef-0123-456789abcdef');
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Verify fail**

Run: `pnpm --filter @primer/api test documents`

Expected: 404 test passes (route not registered → Hono default 404), but the happy path fails.

- [ ] **Step 3: Implement**

File: `apps/api/src/routes/documents.ts`

```ts
import type { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import type { DocumentDetailResponse } from '@primer/shared/api';
import { documents, versions, users } from '@primer/shared/schema';
import { db } from '../db/client.ts';

export function registerDocumentRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/documents/:docId', async (c) => {
    const docId = c.req.param('docId');

    const docRows = await db
      .select({
        id: documents.id,
        title: documents.title,
        description: documents.description,
        createdAt: documents.createdAt,
        uploaderDisplayName: users.displayName,
      })
      .from(documents)
      .innerJoin(users, eq(users.id, documents.uploaderId))
      .where(eq(documents.id, docId))
      .limit(1);

    if (docRows.length === 0) {
      return c.json({ error: 'not_found' }, 404);
    }

    const versionRows = await db
      .select()
      .from(versions)
      .where(eq(versions.documentId, docId))
      .orderBy(desc(versions.versionNumber))
      .limit(1);

    if (versionRows.length === 0) {
      return c.json({ error: 'not_found' }, 404);
    }

    const doc = docRows[0];
    const v = versionRows[0];

    const body: DocumentDetailResponse = {
      document: {
        id: doc.id,
        title: doc.title,
        description: doc.description,
        uploaderDisplayName: doc.uploaderDisplayName,
        createdAt: doc.createdAt.toISOString(),
      },
      latestVersion: {
        id: v.id,
        versionNumber: v.versionNumber,
        versionNote: v.versionNote,
        sizeBytes: v.sizeBytes,
        createdAt: v.createdAt.toISOString(),
      },
    };
    return c.json(body, 200);
  });
}
```

- [ ] **Step 4: Register the route**

Modify `apps/api/src/app.ts` — add `import { registerDocumentRoutes } from './routes/documents.ts';` and call `registerDocumentRoutes(app);` after `registerUploadRoute(app, deps);`.

- [ ] **Step 5: Verify pass + commit**

Run: `pnpm --filter @primer/api test documents`

Expected: 2 tests pass.

```bash
git add apps/api/src
git commit -m "feat(api): GET /api/documents/:docId returns doc + latest version summaries"
```

---

### Task 24: GET /api/versions/:versionId/content with locked CSP (TDD)

**Files:**
- Create: `apps/api/src/routes/versionContent.ts`
- Create: `apps/api/src/routes/versionContent.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: CSP constant**

We pin the CSP as a single source-of-truth string so tests and the route reference the same value.

Add to `apps/api/src/routes/versionContent.ts` (creating it now, will fill in handler in step 3):

```ts
export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' cdn.tailwindcss.com cdnjs.cloudflare.com unpkg.com cdn.jsdelivr.net esm.sh cdn.skypack.dev",
  "style-src 'self' 'unsafe-inline' cdn.tailwindcss.com cdnjs.cloudflare.com unpkg.com cdn.jsdelivr.net fonts.googleapis.com",
  "connect-src 'none'",
  "img-src data: blob: 'self' https:",
  "font-src 'self' fonts.gstatic.com",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');
```

- [ ] **Step 2: Failing tests**

File: `apps/api/src/routes/versionContent.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { ARTIFACT_CSP } from './versionContent.ts';

async function upload(app: ReturnType<typeof createApp>): Promise<string> {
  const fd = new FormData();
  fd.append(
    'file',
    new Blob(['<html><body><h1>Sample</h1></body></html>'], { type: 'text/html' }),
    'r.html'
  );
  fd.append('title', 'Sample');
  const res = await app.request('/api/upload', { method: 'POST', body: fd });
  const body = (await res.json()) as { versionId: string };
  return body.versionId;
}

describe('GET /api/versions/:versionId/content', () => {
  it('serves the stored HTML with the locked CSP, frame-ancestors, and content-type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-vc-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root) });
      const versionId = await upload(app);

      const res = await app.request(`/api/versions/${versionId}/content`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('content-security-policy')).toBe(ARTIFACT_CSP);
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');

      const html = await res.text();
      expect(html).toContain('<h1>Sample</h1>');
      expect(html).toContain('<script src="/companion/v1.js"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 for an unknown version id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-vc-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root) });
      const res = await app.request('/api/versions/01234567-89ab-cdef-0123-456789abcdef/content');
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Implement the route**

Replace `apps/api/src/routes/versionContent.ts` with:

```ts
import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables, AppDeps } from '../app.ts';
import { versions } from '@primer/shared/schema';
import { db } from '../db/client.ts';

export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' cdn.tailwindcss.com cdnjs.cloudflare.com unpkg.com cdn.jsdelivr.net esm.sh cdn.skypack.dev",
  "style-src 'self' 'unsafe-inline' cdn.tailwindcss.com cdnjs.cloudflare.com unpkg.com cdn.jsdelivr.net fonts.googleapis.com",
  "connect-src 'none'",
  "img-src data: blob: 'self' https:",
  "font-src 'self' fonts.gstatic.com",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

export function registerVersionContentRoute(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
  app.get('/api/versions/:versionId/content', async (c) => {
    const versionId = c.req.param('versionId');
    const rows = await db.select().from(versions).where(eq(versions.id, versionId)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: 'not_found' }, 404);
    }

    const stream = await deps.storage.get(rows[0].storageKey);

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': ARTIFACT_CSP,
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'private, max-age=300',
      },
    });
  });
}
```

- [ ] **Step 4: Register**

Modify `apps/api/src/app.ts`: add the import for `registerVersionContentRoute` and call it after the documents route.

- [ ] **Step 5: Verify pass + commit**

Run: `pnpm --filter @primer/api test versionContent`

Expected: 2 tests pass.

```bash
git add apps/api/src
git commit -m "feat(api): GET /api/versions/:versionId/content serves stored HTML with locked CSP"
```

---

### Task 25: GET /companion/v1.js (TDD)

**Files:**
- Create: `apps/api/src/companion/v1.js`
- Create: `apps/api/src/routes/companion.ts`
- Create: `apps/api/src/routes/companion.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Companion script stub**

File: `apps/api/src/companion/v1.js`

```js
// Companion script v1 — stub for sub-project 1.
// Real implementation (capture, postMessage, marker rendering) lands in sub-project 2.
console.log('[primer] companion v1 loaded');
```

- [ ] **Step 2: Test**

File: `apps/api/src/routes/companion.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('GET /companion/v1.js', () => {
  it('serves the companion stub with javascript content-type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-comp-route-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root) });
      const res = await app.request('/companion/v1.js');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
      const body = await res.text();
      expect(body).toContain('companion v1 loaded');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 3: Implement**

File: `apps/api/src/routes/companion.ts`

```ts
import type { Hono } from 'hono';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { AppVariables } from '../app.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const COMPANION_PATH = join(HERE, '..', 'companion', 'v1.js');

export function registerCompanionRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/companion/v1.js', async (c) => {
    const body = await readFile(COMPANION_PATH, 'utf8');
    return new Response(body, {
      status: 200,
      headers: {
        'content-type': 'application/javascript; charset=utf-8',
        'cache-control': 'public, max-age=3600',
      },
    });
  });
}
```

- [ ] **Step 4: Register**

Modify `apps/api/src/app.ts` to import and call `registerCompanionRoute(app)` after the other route registrations.

- [ ] **Step 5: Verify pass + commit**

Run: `pnpm --filter @primer/api test companion`

Expected: 1 test passes.

```bash
git add apps/api/src
git commit -m "feat(api): GET /companion/v1.js serves the v1 stub from disk"
```

---

## Phase 8 — Frontend scaffold

### Task 26: Scaffold `apps/web` with Vite + React + TS

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/vite.config.ts`
- Create: `apps/web/index.html`
- Create: `apps/web/src/main.tsx`
- Create: `apps/web/src/App.tsx`

- [ ] **Step 1: package.json**

File: `apps/web/package.json`

```json
{
  "name": "@primer/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "preview": "vite preview",
    "typecheck": "tsc --noEmit",
    "test": "echo 'no web tests in sub-project 1'"
  },
  "dependencies": {
    "@primer/shared": "workspace:*"
  }
}
```

- [ ] **Step 2: tsconfig.json**

File: `apps/web/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "verbatimModuleSyntax": true
  },
  "include": ["src/**/*", "vite.config.ts"]
}
```

- [ ] **Step 3: index.html**

File: `apps/web/index.html`

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Primer</title>
  </head>
  <body class="bg-neutral-50 text-neutral-900">
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 4: Vite config (with proxy)**

File: `apps/web/vite.config.ts`

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/companion': 'http://localhost:3000',
    },
  },
});
```

- [ ] **Step 5: main.tsx**

File: `apps/web/src/main.tsx`

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);
```

- [ ] **Step 6: App.tsx (placeholder for now; router added in Task 28)**

File: `apps/web/src/App.tsx`

```tsx
export function App() {
  return <div className="p-6 text-xl">Primer (frontend scaffold OK)</div>;
}
```

- [ ] **Step 7: Install deps**

Run:
```bash
pnpm --filter @primer/web add react react-dom react-router-dom @tanstack/react-query
pnpm --filter @primer/web add -D vite @vitejs/plugin-react typescript @types/react @types/react-dom tailwindcss @tailwindcss/vite
```

- [ ] **Step 8: Boot and verify**

Run (with API still off):
```bash
pnpm --filter @primer/web dev
```

Open `http://localhost:5173`. Expected: "Primer (frontend scaffold OK)" visible (Tailwind classes won't apply yet — that's fixed in Task 27). Stop with Ctrl+C.

- [ ] **Step 9: Commit**

```bash
git add apps/web package.json pnpm-lock.yaml
git commit -m "chore(web): scaffold Vite + React + TS app"
```

---

### Task 27: Tailwind 4 wiring

**Files:**
- Modify: `apps/web/vite.config.ts`
- Create: `apps/web/src/index.css`

- [ ] **Step 1: Add Tailwind to Vite**

Modify `apps/web/vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3000',
      '/companion': 'http://localhost:3000',
    },
  },
});
```

- [ ] **Step 2: index.css**

File: `apps/web/src/index.css`

```css
@import 'tailwindcss';
```

- [ ] **Step 3: Verify styles render**

Run `pnpm --filter @primer/web dev`, open `http://localhost:5173`. Expected: the placeholder text has padding (`p-6`) and looks visibly Tailwind-styled. Stop with Ctrl+C.

- [ ] **Step 4: Commit**

```bash
git add apps/web/vite.config.ts apps/web/src/index.css
git commit -m "chore(web): wire Tailwind 4 via the Vite plugin"
```

---

### Task 28: React Router setup with AppShell

**Files:**
- Create: `apps/web/src/AppShell.tsx`
- Create: `apps/web/src/routes/home.tsx`
- Create: `apps/web/src/routes/upload.tsx`
- Create: `apps/web/src/routes/document.tsx`
- Create: `apps/web/src/routes/notFound.tsx`
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Stub route components**

File: `apps/web/src/routes/home.tsx`

```tsx
import { Link } from 'react-router-dom';

export function HomePage() {
  return (
    <div className="space-y-4">
      <h1 className="text-3xl font-semibold">Primer</h1>
      <p className="text-neutral-600">
        Upload an LLM-generated HTML artifact and share it across Polygon.
      </p>
      <Link
        to="/upload"
        className="inline-block rounded-md bg-neutral-900 px-4 py-2 text-white hover:bg-neutral-800"
      >
        Upload a new document
      </Link>
    </div>
  );
}
```

File: `apps/web/src/routes/upload.tsx`

```tsx
export function UploadPage() {
  return <div>Upload (filled in Task 31)</div>;
}
```

File: `apps/web/src/routes/document.tsx`

```tsx
export function DocumentPage() {
  return <div>Document (filled in Task 32)</div>;
}
```

File: `apps/web/src/routes/notFound.tsx`

```tsx
export function NotFoundPage() {
  return <div className="text-neutral-600">Not found.</div>;
}
```

- [ ] **Step 2: AppShell**

File: `apps/web/src/AppShell.tsx`

```tsx
import { Outlet, Link } from 'react-router-dom';

export function AppShell() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-neutral-200 px-6 py-3 flex items-center justify-between">
        <Link to="/" className="font-semibold">
          Primer
        </Link>
      </header>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 3: Wire the router in App.tsx**

Modify `apps/web/src/App.tsx`:

```tsx
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { AppShell } from './AppShell.tsx';
import { HomePage } from './routes/home.tsx';
import { UploadPage } from './routes/upload.tsx';
import { DocumentPage } from './routes/document.tsx';
import { NotFoundPage } from './routes/notFound.tsx';

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/upload', element: <UploadPage /> },
      { path: '/d/:docId', element: <DocumentPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return <RouterProvider router={router} />;
}
```

- [ ] **Step 4: Verify each route loads**

Run `pnpm --filter @primer/web dev`. Visit `/`, `/upload`, `/d/abc`, `/garbage`. Confirm each renders the expected component shell.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): React Router with AppShell and route placeholders"
```

---

### Task 29: TanStack Query setup

**Files:**
- Create: `apps/web/src/queryClient.ts`
- Modify: `apps/web/src/main.tsx`

- [ ] **Step 1: Query client**

File: `apps/web/src/queryClient.ts`

```ts
import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
```

- [ ] **Step 2: Wire the provider**

Modify `apps/web/src/main.tsx`:

```tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClientProvider } from '@tanstack/react-query';
import { App } from './App.tsx';
import { queryClient } from './queryClient.ts';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('#root not found');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>
);
```

- [ ] **Step 3: Verify no regressions**

Run `pnpm --filter @primer/web dev`, confirm pages still render.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): TanStack Query provider"
```

---

## Phase 9 — Frontend pages

### Task 30: Document data hook

**Files:**
- Create: `apps/web/src/queries/documents.ts`

- [ ] **Step 1: Hook**

File: `apps/web/src/queries/documents.ts`

```ts
import { useQuery } from '@tanstack/react-query';
import type { DocumentDetailResponse } from '@primer/shared/api';

export function useDocument(docId: string) {
  return useQuery({
    queryKey: ['document', docId],
    queryFn: async (): Promise<DocumentDetailResponse> => {
      const res = await fetch(`/api/documents/${docId}`);
      if (res.status === 404) {
        throw new Error('not_found');
      }
      if (!res.ok) {
        throw new Error(`fetch failed: ${res.status}`);
      }
      return res.json();
    },
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/queries
git commit -m "feat(web): useDocument hook fetches /api/documents/:docId"
```

---

### Task 31: UploadPage with form

**Files:**
- Modify: `apps/web/src/routes/upload.tsx`

- [ ] **Step 1: Implementation**

File: `apps/web/src/routes/upload.tsx`

```tsx
import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import type { UploadErrorResponse, UploadResponse } from '@primer/shared/api';

export function UploadPage() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (!file) {
      setError('Please choose an .html file.');
      return;
    }
    setSubmitting(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('title', title);
      if (description) fd.append('description', description);

      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as Partial<UploadErrorResponse>;
        setError(body.message ?? `Upload failed (${res.status}).`);
        return;
      }
      const body = (await res.json()) as UploadResponse;
      navigate(body.url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="max-w-xl space-y-4">
      <h1 className="text-2xl font-semibold">Upload a document</h1>

      <label className="block">
        <span className="block text-sm font-medium">HTML file</span>
        <input
          type="file"
          accept=".html,text/html"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="mt-1 block w-full"
        />
      </label>

      <label className="block">
        <span className="block text-sm font-medium">Title</span>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          maxLength={200}
          required
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2"
        />
      </label>

      <label className="block">
        <span className="block text-sm font-medium">Description (optional)</span>
        <textarea
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          maxLength={2000}
          rows={3}
          className="mt-1 block w-full rounded-md border border-neutral-300 px-3 py-2"
        />
      </label>

      {error && <p className="text-sm text-red-600">{error}</p>}

      <button
        type="submit"
        disabled={submitting}
        className="rounded-md bg-neutral-900 px-4 py-2 text-white hover:bg-neutral-800 disabled:opacity-50"
      >
        {submitting ? 'Uploading…' : 'Upload'}
      </button>
    </form>
  );
}
```

- [ ] **Step 2: Manual verification**

Run both processes:
```bash
# Terminal 1
pnpm --filter @primer/api dev
# Terminal 2
pnpm --filter @primer/web dev
```

Open `http://localhost:5173/upload`. Choose a small HTML file, give it a title, submit. Expected: browser navigates to `/d/<uuid>` showing the placeholder.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/upload.tsx
git commit -m "feat(web): UploadPage with form, validation, and submit-and-navigate"
```

---

### Task 32: DocumentPage with sandboxed iframe

**Files:**
- Create: `apps/web/src/components/ArtifactIframe.tsx`
- Modify: `apps/web/src/routes/document.tsx`

- [ ] **Step 1: ArtifactIframe component**

File: `apps/web/src/components/ArtifactIframe.tsx`

```tsx
interface Props {
  versionId: string;
}

// SECURITY-CRITICAL: The sandbox value below is the primary defense against
// hostile JS inside uploaded artifacts. Do NOT add `allow-same-origin`,
// `allow-popups`, or `allow-popups-to-escape-sandbox`. Adding any of these
// would re-open phishing / cookie-theft / fake-SSO vectors described in
// docs/prd-primer.md ("Iframe sandboxing"). If you find yourself needing
// to widen the sandbox, stop and consult the threat model first.
export function ArtifactIframe({ versionId }: Props) {
  return (
    <iframe
      src={`/api/versions/${versionId}/content`}
      sandbox="allow-scripts allow-forms"
      title="Artifact"
      style={{ width: '100%', height: 'calc(100vh - 120px)', border: 0 }}
    />
  );
}
```

The `sandbox` value is the critical security primitive — keep it exactly `"allow-scripts allow-forms"`. The leading comment is intentional and should ship.

- [ ] **Step 2: DocumentPage**

File: `apps/web/src/routes/document.tsx`

```tsx
import { useParams } from 'react-router-dom';
import { useDocument } from '../queries/documents.ts';
import { ArtifactIframe } from '../components/ArtifactIframe.tsx';

export function DocumentPage() {
  const { docId } = useParams();
  const q = useDocument(docId ?? '');

  if (q.isLoading) return <div className="text-neutral-500">Loading…</div>;
  if (q.error) {
    return (
      <div className="text-red-600">
        Could not load document: {(q.error as Error).message}
      </div>
    );
  }
  if (!q.data) return null;

  const { document, latestVersion } = q.data;

  return (
    <div className="space-y-4">
      <header className="flex items-baseline justify-between border-b border-neutral-200 pb-2">
        <div>
          <h1 className="text-xl font-semibold">{document.title}</h1>
          {document.description && (
            <p className="text-sm text-neutral-600">{document.description}</p>
          )}
        </div>
        <div className="text-sm text-neutral-500">
          {document.uploaderDisplayName} ·{' '}
          {new Date(document.createdAt).toLocaleString()}
        </div>
      </header>
      <ArtifactIframe versionId={latestVersion.id} />
    </div>
  );
}
```

- [ ] **Step 3: Manual verification**

With both processes running, upload a small HTML fixture, navigate to `/d/<docId>`. Expected:
- Top bar shows the title, uploader (`Mock User`), and timestamp.
- The artifact renders inside an iframe.
- The browser DevTools Network tab shows the artifact response carries the locked CSP and `X-Frame-Options: SAMEORIGIN`.
- The iframe's console shows `[primer] companion v1 loaded`.
- The iframe element in the DOM has `sandbox="allow-scripts allow-forms"`.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): DocumentPage renders metadata + sandboxed ArtifactIframe"
```

---

## Phase 10 — Verification + docs

### Task 33: Flesh out the README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Full README**

Replace `README.md` with:

````markdown
# Primer

Internal Polygon tool for hosting and collaborating on LLM-generated HTML artifacts.

This repo is sub-project 1 (Local foundation). See:
- Product: `docs/prd-primer.md`
- Decomposition: `docs/superpowers/specs/2026-05-12-primer-decomposition-design.md`
- This sub-project's design spec: `docs/superpowers/specs/2026-05-13-primer-local-foundation-design.md`

## Quickstart

Prerequisites: Node 24 LTS, Docker, Corepack-enabled (Node ships with this; run `corepack enable` once).

```bash
git clone <repo> primer && cd primer
corepack use pnpm@11.1.0
cp .env.example .env
pnpm install --frozen-lockfile
pnpm db:up         # Postgres in Docker Compose
pnpm db:migrate    # apply migrations + seed mock user
pnpm dev           # boots API on :3000 and web on :5173
```

Open `http://localhost:5173`.

## Architecture

- `apps/api` — Hono API server (Node 24).
- `apps/web` — React + Vite frontend.
- `packages/shared` — Drizzle schema, Storage interface, API DTOs.
- `drizzle/` (under `apps/api`) — committed migration SQL.

In dev: two processes. Vite serves the React app at :5173 with a proxy to the API at :3000.

## Supply-chain hardening

`pnpm-workspace.yaml` enforces:
- `minimumReleaseAge: 20160` — no package version younger than 14 days will install.
- `allowBuilds: {}` — postinstall/preinstall scripts are denied by default. Use `pnpm approve-builds` to add a package after review.
- `blockExoticSubdeps: true` — no git/tarball/http deps in the transitive tree.
- `strictPeerDependencies: true` and `engineStrict: true`.

**Manual verification (run once after setup):**

```bash
pnpm add hono@4.12.18
# Expected: install fails with a minimumReleaseAge error.
git checkout -- package.json pnpm-workspace.yaml pnpm-lock.yaml
```

If the install **succeeds**, the supply-chain gate is not active — stop and investigate before continuing.

## Scripts

- `pnpm dev` — start API + web in parallel.
- `pnpm db:up` / `pnpm db:down` / `pnpm db:reset` — manage local Postgres.
- `pnpm db:migrate` / `pnpm db:generate` — apply / generate Drizzle migrations.
- `pnpm typecheck` — run `tsc --noEmit` across all workspaces.
- `pnpm test` — run Vitest across all workspaces.
- `pnpm verify` — typecheck + test + `pnpm audit --audit-level=high`.

## Out of scope here (deferred sub-projects)

- Companion script body (sub-project 2)
- Comments, sidebar, polling (sub-project 3)
- Versioning, version selector, soft-delete (sub-project 4)
- Real Okta auth, multi-user (sub-project 5)
- Slack notifications (sub-project 6)
- Element-path anchor fallback, drift indicator, alpha launch (sub-project 7)
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: full README with quickstart, scripts, and supply-chain verification steps"
```

---

### Task 34: Cross-cutting verification (typecheck, tests, audit)

**Files:** (none)

- [ ] **Step 1: Run full verify**

Ensure Postgres is up (`pnpm db:up`), then:
```bash
pnpm verify
```

Expected: all three commands pass.

If `pnpm audit --audit-level=high` reports a high vulnerability, investigate and decide whether to override (`pnpm.overrides`) or accept. Do not silently `--audit-level=critical` away high findings — record the decision in the commit message.

- [ ] **Step 2: Run the dev loop end-to-end against exit criteria**

For each exit criterion from the design spec:

1. **EC1 — fresh-clone boot.** In a separate shell:
   ```bash
   cd /tmp && rm -rf primer-fresh && git clone <local-repo-path> primer-fresh && cd primer-fresh
   cp .env.example .env
   pnpm install --frozen-lockfile
   pnpm db:up && pnpm db:migrate
   pnpm dev &
   sleep 5
   curl -s http://localhost:3000/api/health
   ```
   Expected: `{"ok":true}`. Then teardown: kill the background `pnpm dev`, `docker compose down`.

2. **EC2 — upload a real artifact.** With `pnpm dev` running, open `http://localhost:5173/upload`, choose an `.html` file, give it a title, submit.

3. **EC3 — iframe + CSP.** On `/d/<id>`, open DevTools Network. Click the artifact-content request. Confirm `Content-Security-Policy` matches the artifact-CSP string from the spec. Confirm `sandbox="allow-scripts allow-forms"` on the `<iframe>` element in the DOM.

4. **EC4 — companion stub.** In the iframe's console (DevTools → top-frame selector → switch to the iframe), confirm `[primer] companion v1 loaded` appears.

5. **EC5 — sanitization.** Use the test fixture that includes `<iframe>` and `<meta http-equiv="refresh">`; verify the rendered artifact does not contain either (View Page Source on the iframe doc).

6. **EC6 — `pnpm verify` green.** Already done above.

7. **EC7 — 14-day gate.** Run the manual verification from the README. Confirm install fails with a minimumReleaseAge error.

- [ ] **Step 3: Capture any deviations**

If anything fails: file a follow-up commit before moving on. Do not declare done with red criteria.

- [ ] **Step 4: Final commit (optional)**

If any small fixes were needed during verification:
```bash
git add -A
git commit -m "fix: verification cleanups"
```

If nothing was changed, skip.

---

### Task 35: Finalize the branch

**Files:** (none)

- [ ] **Step 1: Review the branch diff**

Run:
```bash
git log --oneline master..feat/local-foundation
git diff --stat master..feat/local-foundation
```

Expected: a clean sequence of ~30+ commits, each scoped to one concern.

- [ ] **Step 2: Hand off**

This plan ends with the implementer making the call: open a PR for review, or merge directly. The decision is outside the plan's scope.

---

## Known minor deviations from the spec

- **Test isolation method:** the spec calls for "transaction-rolls-back" per test; this plan uses TRUNCATE-between-tests against the separate `primer_test` database. Same correctness guarantee (no cross-test interference), simpler implementation, no need for the code under test to participate in an outer transaction. The separate-DB requirement is honored.
- **Parent-page CSP:** the spec's parent-page CSP is meant for the Hono-served SPA shell in the production path. Sub-project 1 only has Vite-served SPA in dev, so the parent-page CSP is not set anywhere in this plan. When the prod-serve path lands (Phase 2 / deploy work), Hono will set this CSP on the `index.html` response. The artifact endpoint CSP — the *load-bearing* one for the iframe — is fully implemented here (Task 24).
- **Iframe sandbox snapshot test:** the spec mentions a "quick component snapshot test" for the `ArtifactIframe` sandbox attribute, while also declaring Tier 3 (frontend) tests skipped. To resolve the contradiction, this plan keeps the sandbox literal in `ArtifactIframe.tsx` with an explicit comment warning that the value is security-critical (Task 32). No frontend test harness is set up. A formal snapshot test can be added when sub-project 3 introduces the frontend test infrastructure.

## Notes for the implementer

- **Commit cadence:** every task ends with a commit. Don't skip — sub-project 2 will branch off this work and bisect-friendly history matters.
- **When `pnpm approve-builds` prompts you:** read the package's `postinstall` script before approving. Do not approve sight-unseen.
- **If a step fails on NixOS:** Docker on NixOS sometimes needs `dockerd` configured to use a non-overlayfs storage driver. If `pnpm db:up` fails, check `docker info` and the docker daemon's storage driver; restart `dockerd` if needed.
- **If `verbatimModuleSyntax` causes friction with Vitest mock hoisting** (Task 22), relax it to `false` in `apps/api/tsconfig.json` and note the change. The supply-chain stance is unaffected.
- **The `_journal.json` file** that drizzle-kit maintains alongside generated migrations is sensitive to edits. The seed migration in Task 8 requires appending one entry manually; if that turns out to be brittle, prefer running `drizzle-kit generate --custom seed_mock_user` (which produces an empty SQL file you then fill in) so drizzle-kit owns the journal end-to-end.
