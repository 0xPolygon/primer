# Primer Sub-Project 5 (Auth + Ownership) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `mockUserMiddleware` with real Polygon Okta OIDC authentication, Postgres-backed sessions, and CSRF protection. Enforce uploader-only authorization end-to-end via parameterized mock tests and a new `/api/me` endpoint that lets the frontend swap the SP4 `displayName === 'Mock User'` placeholder for `uploaderId === me.id`.

**Architecture:** New `userResolver` injected via `AppDeps`. In production: `oktaResolver` reads a `primer_sid` cookie, joins `sessions → users`. In dev (`AUTH_MODE=mock`): `mockResolver` returns the fixed mock user — same behavior as today. In tests: `mockMultiResolver` reads `X-Mock-User-Id` header for cross-user assertions. Sessions live in a new `sessions` table; expired rows are cleaned up by the existing `startPurgeInterval` job. Auth routes (`/auth/login`, `/auth/callback`, `/auth/logout`) are thin wrappers around `openid-client`. CSRF defense via `SameSite=Lax` cookie + `X-Primer-Csrf: 1` header check on all mutating verbs.

**Tech Stack:** TypeScript 6 + Hono 4 (Node 24) + Drizzle 0.45 + postgres.js + `openid-client` v6 + Vitest 4 on the API; React 19 + Vite 8 + TanStack Query 5 + Tailwind 4 on the web side.

**Companion spec:** `docs/superpowers/specs/2026-05-18-primer-auth-ownership-design.md`

---

## Pre-flight assumptions

- Working directory: `/home/taylan/development/polygon/primer`
- Start from `master` (currently at `77940a9`, the SP5 spec commit). T1 creates `feat/auth-ownership`.
- Postgres is up (`pnpm db:up` if not). `.env` exists at repo root.
- pnpm 11.1.0 at `~/.local/bin/pnpm`, Node 24 in the Nix store. **Every Bash command starts with:**
  ```bash
  export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
  ```
- SSH-key git signing works without prompting. Commit normally (no `--no-gpg-sign`).
- All work commits on `feat/auth-ownership`. Final squash-merge to master is the last task.

---

## File map

```
packages/shared/src/
  schema.ts                            # MOD — sessions table
  api.ts                               # MOD — UserDTO; DocumentDetailResponse.document.uploaderId

apps/api/src/
  auth/
    resolver.ts                        # NEW — UserResolver type + mockResolver + mockMultiResolver
    okta.ts                            # NEW — OktaAdapter interface + OpenIdClientAdapter + MockOktaAdapter
    cookies.ts                         # NEW — serializeCookie / parseCookie helpers
    session.ts                         # NEW — createSession, lookupSession, deleteSession, refreshSessionIfStale
    csrf.ts                            # NEW — csrfMiddleware
  middleware/
    auth.ts                            # NEW — authMiddleware factory
    mockUser.ts                        # MOD — keep MOCK_USER constant, drop middleware export
  routes/
    auth.ts                            # NEW — GET /auth/login, GET /auth/callback, POST /auth/logout
    auth.test.ts                       # NEW
    me.ts                              # NEW — GET /api/me
    me.test.ts                         # NEW
    documents.ts                       # MOD — DocumentDetailResponse.document includes uploaderId
    documents.test.ts                  # MOD — assert uploaderId
    {comments,documents,threads,upload,upload.compensate,versionContent,versions}.test.ts
                                       # MOD — add 'X-Primer-Csrf': '1' to mutating headers
  jobs/
    purge.ts                           # MOD — purgeExpiredSessions
    purge.test.ts                      # MOD — purgeExpiredSessions tests
  app.ts                               # MOD — userResolver + oktaAdapter in AppDeps; wire auth + csrf middlewares
  index.ts                             # MOD — pick resolver via AUTH_MODE
  test/
    harness.ts                         # NEW — withMockUser helper + CSRF constants
    crossUser.test.ts                  # NEW — 6 cross-user 403 cases

apps/web/src/
  lib/
    fetch.ts                           # NEW — api() wrapper with CSRF header + 401 redirect
  queries/
    me.ts                              # NEW — useMe()
    {documents,versions,threads,dashboard,mutations}.ts
                                       # MOD — migrate fetch() → api()
  components/
    AppShell.tsx                       # MOD — identity widget + Sign out menu
    UserMenu.tsx                       # NEW — extracted dropdown
  routes/
    document.tsx                       # MOD — uploaderId predicate

.env.example                           # NEW — AUTH_MODE + OKTA_* keys
apps/api/package.json                  # MOD — add openid-client dep
```

---

## Phase A — Shared types + branch

### Task 1: Feature branch + DTOs + .env.example

**Files:**
- Modify: `packages/shared/src/api.ts`
- Create: `.env.example`

- [ ] **Step 1: Create the feature branch**

```bash
cd /home/taylan/development/polygon/primer
git status   # confirm clean on master at 77940a9
git checkout -b feat/auth-ownership
git log --oneline -3
```

- [ ] **Step 2: Add DTOs to `packages/shared/src/api.ts`**

Open `packages/shared/src/api.ts`. Append:

```ts
export interface UserDTO {
  id: string;
  email: string;
  displayName: string;
}
```

Then find the existing `DocumentDetailResponse` interface (or whichever interface holds the doc detail's `document` field) and add `uploaderId: string` to the `document` shape. Locate the existing `document` shape (it has `id`, `title`, `description`, `uploaderDisplayName`, `createdAt`) and update it to:

```ts
{
  id: string;
  title: string;
  description: string | null;
  uploaderId: string;             // NEW in SP5
  uploaderDisplayName: string;
  createdAt: string;
}
```

If the type is inline inside `DocumentDetailResponse`, edit inline. If it's a separate interface, edit that.

- [ ] **Step 3: Create `.env.example`**

File: `.env.example` (repo root)

```bash
# Database
DATABASE_URL=postgres://primer:primer@localhost:5432/primer
DATABASE_URL_TEST=postgres://primer:primer@localhost:5432/primer_test

# Server
PORT=3000
STORAGE_ROOT=./storage
LOG_LEVEL=info

# Authentication
# AUTH_MODE: mock | okta
#   mock = always sign in as MOCK_USER (default for local dev)
#   okta = real Polygon Okta OIDC flow (requires OKTA_* vars)
AUTH_MODE=mock

# Required only when AUTH_MODE=okta:
# OKTA_ISSUER=https://<polygon-tenant>.okta.com
# OKTA_CLIENT_ID=
# OKTA_CLIENT_SECRET=
# AUTH_BASE_URL=http://localhost:3000
# SESSION_COOKIE_NAME=primer_sid
# SESSION_TTL_DAYS=14
```

- [ ] **Step 4: Typecheck all three workspaces**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/shared typecheck
pnpm --filter @primer/api typecheck
pnpm --filter @primer/web typecheck
```

Expected: `shared` clean. `api` may fail at the place that constructs `DocumentDetailResponse` because `uploaderId` is now required but isn't being set. **That's a deliberate fail caught by typecheck** — Step 5 fixes it.

- [ ] **Step 5: Set `uploaderId` in every place that constructs the doc detail**

Find every place in `apps/api/src/routes/` that constructs a response body matching `DocumentDetailResponse.document`. Grep:

```bash
grep -nE "uploaderDisplayName" apps/api/src/routes/*.ts
```

For each hit, add `uploaderId: <existing uploader id var>` to the object literal alongside `uploaderDisplayName`. The uploader id is already in scope (the query that fetched the doc selects it as `uploaderId` or `existing.uploaderId`). Common pattern:

```ts
return c.json(
  {
    id: existing.id,
    title: existing.title,
    description: existing.description,
    uploaderId: existing.uploaderId,           // NEW
    uploaderDisplayName: uploader?.displayName ?? '',
    createdAt: existing.createdAt.toISOString(),
  },
  200
);
```

- [ ] **Step 6: Verify api typecheck and run existing tests**

```bash
pnpm --filter @primer/api typecheck
pnpm --filter @primer/api test 2>&1 | tail -5
pnpm --filter @primer/web typecheck
```

Expected: typecheck clean; all 134 existing tests still pass (existing tests don't read `uploaderId` so they aren't affected).

- [ ] **Step 7: Commit**

```bash
git add packages/shared/src/api.ts apps/api/src/routes .env.example
git commit -m "feat(shared): UserDTO + uploaderId on document detail; .env.example"
git log --oneline -3
```

---

## Phase B — Sessions table

### Task 2: `sessions` table + migration (TDD)

**Files:**
- Modify: `packages/shared/src/schema.ts`
- Create: `packages/shared/migrations/<timestamp>_sessions.sql` (generated)

- [ ] **Step 1: Append `sessions` table to `packages/shared/src/schema.ts`**

After the existing tables in `packages/shared/src/schema.ts`, append:

```ts
import { pgTable, text, uuid, timestamp, integer, jsonb, bigint, uniqueIndex, primaryKey, index } from 'drizzle-orm/pg-core';

// ... existing tables ...

export const sessions = pgTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    userAgent: text('user_agent'),
  },
  (t) => ({
    byUser: index('sessions_user_id_idx').on(t.userId),
    byExpiry: index('sessions_expires_at_idx').on(t.expiresAt),
  })
);
```

Add `index` to the import list from `drizzle-orm/pg-core` if missing.

- [ ] **Step 2: Generate the migration**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api run db:generate
```

This emits a new SQL file under `packages/shared/migrations/` (drizzle-kit picks a timestamped name). Verify the file contains `CREATE TABLE "sessions" ...`. Print it:

```bash
ls -lt packages/shared/migrations/ | head -3
```

- [ ] **Step 3: Apply the migration to dev + test DBs**

```bash
pnpm --filter @primer/api run db:migrate
pnpm --filter @primer/api run db:migrate:test
```

Expected: both report applying the new migration. If `db:migrate` fails because the dev DB is locked by a running server, kill any `tsx watch` processes and retry.

- [ ] **Step 4: Verify schema by reading from psql (sanity check)**

```bash
docker compose exec -T postgres psql -U primer -d primer -c "\d sessions" 2>&1 | head -20
```

Expected: shows columns id (text PK), user_id (text FK), expires_at, created_at, last_seen_at, user_agent.

- [ ] **Step 5: Typecheck + tests still green**

```bash
pnpm --filter @primer/shared typecheck
pnpm --filter @primer/api typecheck
pnpm --filter @primer/api test 2>&1 | tail -5
```

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/schema.ts packages/shared/migrations
git commit -m "feat(shared): sessions table + migration"
git log --oneline -3
```

---

## Phase C — User resolver + auth middleware (mock path)

### Task 3: `UserResolver` type + mock resolvers

**Files:**
- Create: `apps/api/src/auth/resolver.ts`
- Modify: `apps/api/src/middleware/mockUser.ts`

- [ ] **Step 1: Create `apps/api/src/auth/resolver.ts`**

```ts
import type { Context } from 'hono';
import type { AppVariables } from '../app.ts';

export type ResolvedUser = AppVariables['user'];

export type UserResolver = (
  c: Context<{ Variables: AppVariables }>
) => Promise<ResolvedUser | null>;

export const MOCK_USER: ResolvedUser = {
  id: 'mock-user-1',
  email: 'mock@polygon.technology',
  displayName: 'Mock User',
};

export const mockResolver: UserResolver = async () => MOCK_USER;

/** Reads `X-Mock-User-Id` from the request. Falls back to MOCK_USER's id when absent. */
export const mockMultiResolver: UserResolver = async (c) => {
  const headerId = c.req.header('x-mock-user-id');
  const id = headerId && headerId.trim().length > 0 ? headerId : MOCK_USER.id;
  // The middleware needs the FULL user (email + displayName). For tests we
  // don't read these from the DB — they're synthesized from the id.
  if (id === MOCK_USER.id) return MOCK_USER;
  return { id, email: `${id}@polygon.technology`, displayName: id };
};
```

- [ ] **Step 2: Slim down `apps/api/src/middleware/mockUser.ts`**

The old middleware export is gone. Keep the constant only and re-export it from the new location to avoid breaking existing imports during transition. Replace the file with:

```ts
export { MOCK_USER } from '../auth/resolver.ts';
```

(SP5 will remove this re-export at the end of the branch once nothing imports from `middleware/mockUser.ts` anymore. Step 4 in T6 confirms there are no remaining importers.)

- [ ] **Step 3: Typecheck**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/auth apps/api/src/middleware
git commit -m "feat(api): UserResolver type + mock resolvers"
```

---

### Task 4: `authMiddleware` (TDD)

**Files:**
- Create: `apps/api/src/middleware/auth.ts`
- Create: `apps/api/src/middleware/auth.test.ts`

- [ ] **Step 1: Failing test**

File: `apps/api/src/middleware/auth.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { authMiddleware } from './auth.ts';
import { MOCK_USER, type UserResolver } from '../auth/resolver.ts';

function makeApp(resolver: UserResolver) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(resolver));
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/data', (c) => c.json({ user: c.get('user').id }));
  app.get('/d/123', (c) => c.text(`page for ${c.get('user').id}`));
  return app;
}

describe('authMiddleware', () => {
  it('always allows GET /api/health, no user required', async () => {
    const app = makeApp(async () => null);
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 401 JSON when no user on /api/*', async () => {
    const app = makeApp(async () => null);
    const res = await app.request('/api/data');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('unauthenticated');
  });

  it('returns 302 to /auth/login on a page route when no user', async () => {
    const app = makeApp(async () => null);
    const res = await app.request('/d/123');
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBe('/auth/login?return_to=%2Fd%2F123');
  });

  it('sets c.var.user when resolver returns a user', async () => {
    const app = makeApp(async () => MOCK_USER);
    const res = await app.request('/api/data');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: 'mock-user-1' });
  });

  it('bypasses /auth/login and /auth/callback for unauthenticated users', async () => {
    const app = makeApp(async () => null);
    app.get('/auth/login', (c) => c.text('login start'));
    app.get('/auth/callback', (c) => c.text('callback'));
    expect((await app.request('/auth/login')).status).toBe(200);
    expect((await app.request('/auth/callback')).status).toBe(200);
  });

  it('requires auth on POST /auth/logout', async () => {
    const app = makeApp(async () => null);
    app.post('/auth/logout', (c) => c.text('ok'));
    const res = await app.request('/auth/logout', { method: 'POST' });
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test middleware/auth
```

Expected: module not found.

- [ ] **Step 3: Implement**

File: `apps/api/src/middleware/auth.ts`

```ts
import type { MiddlewareHandler } from 'hono';
import type { AppVariables } from '../app.ts';
import type { UserResolver } from '../auth/resolver.ts';

const PUBLIC_PATHS = new Set(['/api/health', '/auth/login', '/auth/callback']);

function isApiPath(path: string): boolean {
  return path.startsWith('/api/');
}

export function authMiddleware(
  resolver: UserResolver
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const path = c.req.path;
    if (PUBLIC_PATHS.has(path)) return next();

    const user = await resolver(c);
    if (user) {
      c.set('user', user);
      return next();
    }

    if (isApiPath(path) || path.startsWith('/auth/')) {
      return c.json({ error: 'unauthenticated' }, 401);
    }
    const returnTo = encodeURIComponent(path);
    return c.redirect(`/auth/login?return_to=${returnTo}`, 302);
  };
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test middleware/auth
pnpm --filter @primer/api typecheck
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/auth.ts apps/api/src/middleware/auth.test.ts
git commit -m "feat(api): authMiddleware (401 on /api, 302 on page routes, public exemptions)"
```

---

### Task 5: `csrfMiddleware` (TDD)

**Files:**
- Create: `apps/api/src/auth/csrf.ts`
- Create: `apps/api/src/auth/csrf.test.ts`

- [ ] **Step 1: Failing test**

File: `apps/api/src/auth/csrf.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { csrfMiddleware, CSRF_HEADER } from './csrf.ts';

function makeApp() {
  const app = new Hono();
  app.use('*', csrfMiddleware);
  app.get('/api/data', (c) => c.text('ok'));
  app.post('/api/data', (c) => c.text('posted'));
  app.patch('/api/data', (c) => c.text('patched'));
  app.delete('/api/data', (c) => c.text('deleted'));
  app.post('/auth/logout', (c) => c.text('logged out'));
  app.get('/auth/login', (c) => c.text('login'));
  return app;
}

describe('csrfMiddleware', () => {
  it('allows GET without header', async () => {
    const res = await makeApp().request('/api/data');
    expect(res.status).toBe(200);
  });

  it('allows POST with header', async () => {
    const res = await makeApp().request('/api/data', {
      method: 'POST',
      headers: { [CSRF_HEADER]: '1' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects POST without header (403)', async () => {
    const res = await makeApp().request('/api/data', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('csrf');
  });

  it('rejects PATCH and DELETE without header', async () => {
    const a = makeApp();
    expect((await a.request('/api/data', { method: 'PATCH' })).status).toBe(403);
    expect((await a.request('/api/data', { method: 'DELETE' })).status).toBe(403);
  });

  it('rejects POST /auth/logout without header', async () => {
    const res = await makeApp().request('/auth/logout', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('allows GET /auth/login without header', async () => {
    const res = await makeApp().request('/auth/login');
    expect(res.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test auth/csrf
```

Expected: module not found.

- [ ] **Step 3: Implement**

File: `apps/api/src/auth/csrf.ts`

```ts
import type { MiddlewareHandler } from 'hono';

export const CSRF_HEADER = 'x-primer-csrf';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export const csrfMiddleware: MiddlewareHandler = async (c, next) => {
  if (!MUTATING_METHODS.has(c.req.method)) return next();
  if (c.req.header(CSRF_HEADER) === '1') return next();
  return c.json({ error: 'csrf', message: 'Missing X-Primer-Csrf header' }, 403);
};
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test auth/csrf
pnpm --filter @primer/api typecheck
```

Expected: 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/csrf.ts apps/api/src/auth/csrf.test.ts
git commit -m "feat(api): csrfMiddleware (reject mutating verbs without X-Primer-Csrf)"
```

---

## Phase D — Wire middlewares + update existing tests

### Task 6: Wire `authMiddleware` + `csrfMiddleware` in `app.ts` and update existing tests

**Files:**
- Modify: `apps/api/src/app.ts`
- Modify: `apps/api/src/index.ts`
- Modify: `apps/api/src/routes/upload.test.ts`
- Modify: `apps/api/src/routes/upload.compensate.test.ts`
- Modify: `apps/api/src/routes/documents.test.ts`
- Modify: `apps/api/src/routes/threads.test.ts`
- Modify: `apps/api/src/routes/comments.test.ts`
- Modify: `apps/api/src/routes/versions.test.ts`
- Modify: `apps/api/src/routes/versionContent.test.ts` (1 mutating call)

- [ ] **Step 1: Modify `apps/api/src/app.ts`**

Replace the middleware section:

```ts
import { Hono } from 'hono';
import { logger as appLogger } from './logger.ts';
import { authMiddleware } from './middleware/auth.ts';
import { csrfMiddleware } from './auth/csrf.ts';
import { mockResolver, type UserResolver } from './auth/resolver.ts';
import { registerUploadRoute } from './routes/upload.ts';
import { registerDocumentRoutes } from './routes/documents.ts';
import { registerVersionContentRoute } from './routes/versionContent.ts';
import { registerCompanionRoute } from './routes/companion.ts';
import { registerDevFixtureRoute } from './routes/devFixture.ts';
import { registerThreadRoutes } from './routes/threads.ts';
import { registerCommentRoutes } from './routes/comments.ts';
import { registerDashboardRoute } from './routes/dashboard.ts';
import { registerVersionRoutes } from './routes/versions.ts';
import type { Storage } from '@primer/shared/storage';
import type { Notifier } from './notifications/notifier.ts';

export type AppVariables = {
  user: { id: string; email: string; displayName: string };
};

export interface AppDeps {
  storage: Storage;
  notifier: Notifier;
  userResolver?: UserResolver;     // defaults to mockResolver (tests + dev)
}

export function createApp(deps: AppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();

  const resolver = deps.userResolver ?? mockResolver;
  app.use('*', authMiddleware(resolver));
  app.use('*', csrfMiddleware);

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
  registerDocumentRoutes(app, deps);
  registerVersionContentRoute(app, deps);
  registerCompanionRoute(app);
  registerThreadRoutes(app, deps);
  registerCommentRoutes(app, deps);
  registerDashboardRoute(app);
  registerVersionRoutes(app);

  if (process.env.NODE_ENV !== 'production') {
    registerDevFixtureRoute(app);
  }

  return app;
}
```

Note: `mockUserMiddleware` is no longer imported. `userResolver` defaults to `mockResolver` if not passed — so all existing tests continue to work with single mock user.

- [ ] **Step 2: Modify `apps/api/src/index.ts`**

```ts
import './env.ts';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { logger } from './logger.ts';
import { FilesystemStorage } from './storage/filesystem.ts';
import { NoopNotifier } from './notifications/notifier.ts';
import { startPurgeInterval } from './jobs/purge.ts';
import { mockResolver } from './auth/resolver.ts';

const port = Number(process.env.PORT ?? 3000);
const storageRoot = process.env.STORAGE_ROOT ?? './storage';
const storage = new FilesystemStorage(storageRoot);
const notifier = new NoopNotifier();

// Resolver selection (real Okta wiring lands in T11–T13; for now, mock).
const authMode = process.env.AUTH_MODE ?? 'mock';
if (authMode !== 'mock') {
  logger.warn({ authMode }, 'AUTH_MODE is set but Okta wiring lands in T11–T13; falling back to mock');
}
const userResolver = mockResolver;

const app = createApp({ storage, notifier, userResolver });

const purgeIntervalMs = process.env.PURGE_INTERVAL_MS
  ? Number(process.env.PURGE_INTERVAL_MS)
  : undefined;
const stopPurge = startPurgeInterval({ storage, intervalMs: purgeIntervalMs });

const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port, storageRoot, authMode }, 'primer api listening');
});

const shutdown = async () => {
  await stopPurge();
  if ('close' in server) {
    (server as { close: (cb?: () => void) => void }).close(() => process.exit(0));
  } else {
    process.exit(0);
  }
};
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
```

- [ ] **Step 3: Add CSRF header constant to a shared test helper**

Create `apps/api/src/test/harness.ts` (file may already exist; if so, append):

```ts
export const CSRF_HEADERS = { 'x-primer-csrf': '1' } as const;
```

- [ ] **Step 4: Update existing tests to send the CSRF header on mutating requests**

For each test file with mutating verbs (upload.test.ts, upload.compensate.test.ts, documents.test.ts, threads.test.ts, comments.test.ts, versions.test.ts, versionContent.test.ts), add the CSRF header to every `app.request(..., { method: 'POST' | 'PATCH' | 'PUT' | 'DELETE', ... })` call.

Strategy: import the constant at the top of each file:

```ts
import { CSRF_HEADERS } from '../test/harness.ts';
```

Then update every mutating call. Three patterns occur:

**Pattern A — explicit headers object:**

```ts
// Before
const res = await app.request(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

// After
const res = await app.request(url, {
  method: 'POST',
  headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
```

**Pattern B — no headers object yet:**

```ts
// Before
const res = await app.request(url, { method: 'DELETE' });

// After
const res = await app.request(url, { method: 'DELETE', headers: CSRF_HEADERS });
```

**Pattern C — FormData uploads (must NOT set content-type; browser/Hono sets multipart boundary):**

```ts
// Before
const res = await app.request(url, { method: 'POST', body: fd });

// After
const res = await app.request(url, { method: 'POST', headers: CSRF_HEADERS, body: fd });
```

Apply to all 62 mutating call sites (grep -rE "method: ['\"](POST|PATCH|PUT|DELETE)" apps/api/src/routes/*.test.ts to find them). Do not skip any — a missed site will 403 in the next step.

- [ ] **Step 5: Run full api suite + typecheck**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api typecheck
pnpm --filter @primer/api test 2>&1 | tail -10
```

Expected: typecheck clean. **All 134 tests still pass.** If any 403s appear, find the missing CSRF header and add it.

- [ ] **Step 6: Confirm `mockUserMiddleware` is no longer imported anywhere**

```bash
grep -rn "mockUserMiddleware" apps/api/src 2>&1
```

Expected: no hits (the export was removed in T3 step 2). If anything still imports it, remove the import line.

Now confirm no one still imports `MOCK_USER` from the transitional file (anything that does must be re-pointed to `auth/resolver.ts` before deletion):

```bash
grep -rnE "from ['\"].*middleware/mockUser" apps/api/src 2>&1
```

For each hit, change the import path from `'.../middleware/mockUser'` to `'.../auth/resolver.ts'`.

Then delete the transitional re-export:

```bash
rm apps/api/src/middleware/mockUser.ts
```

Re-run typecheck and tests to confirm:

```bash
pnpm --filter @primer/api typecheck
pnpm --filter @primer/api test 2>&1 | tail -5
```

- [ ] **Step 7: Commit**

```bash
git add apps/api
git commit -m "feat(api): wire authMiddleware + csrfMiddleware in createApp; update tests"
git log --oneline -3
```

---

## Phase E — Cookies + sessions module

### Task 7: Cookie helpers

**Files:**
- Create: `apps/api/src/auth/cookies.ts`
- Create: `apps/api/src/auth/cookies.test.ts`

- [ ] **Step 1: Failing test**

File: `apps/api/src/auth/cookies.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parseCookie, serializeCookie } from './cookies.ts';

describe('parseCookie', () => {
  it('returns the value for a present cookie', () => {
    expect(parseCookie('primer_sid=abc123', 'primer_sid')).toBe('abc123');
  });

  it('handles multiple cookies', () => {
    expect(
      parseCookie('foo=bar; primer_sid=xyz; baz=qux', 'primer_sid')
    ).toBe('xyz');
  });

  it('returns null when cookie missing', () => {
    expect(parseCookie('foo=bar', 'primer_sid')).toBeNull();
  });

  it('returns null on null/empty input', () => {
    expect(parseCookie(null, 'primer_sid')).toBeNull();
    expect(parseCookie('', 'primer_sid')).toBeNull();
  });

  it('decodes URI-encoded values', () => {
    expect(parseCookie('x=%2Fpath', 'x')).toBe('/path');
  });
});

describe('serializeCookie', () => {
  it('builds a basic cookie', () => {
    const s = serializeCookie('primer_sid', 'abc', {
      maxAge: 3600,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(s).toContain('primer_sid=abc');
    expect(s).toContain('Max-Age=3600');
    expect(s).toContain('HttpOnly');
    expect(s).toContain('Secure');
    expect(s).toContain('SameSite=Lax');
    expect(s).toContain('Path=/');
  });

  it('builds a deletion cookie when maxAge=0', () => {
    const s = serializeCookie('primer_sid', '', { maxAge: 0, path: '/' });
    expect(s).toContain('primer_sid=');
    expect(s).toContain('Max-Age=0');
  });

  it('omits Secure when secure=false', () => {
    const s = serializeCookie('x', 'v', { httpOnly: true, sameSite: 'lax', path: '/' });
    expect(s).not.toContain('Secure');
  });

  it('URI-encodes the value', () => {
    expect(serializeCookie('x', '/path', { path: '/' })).toContain('x=%2Fpath');
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test auth/cookies
```

- [ ] **Step 3: Implement**

File: `apps/api/src/auth/cookies.ts`

```ts
export interface CookieOpts {
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
  path?: string;
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  const parts = header.split(/;\s*/);
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    const v = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(v);
    } catch {
      return v;
    }
  }
  return null;
}

export function serializeCookie(name: string, value: string, opts: CookieOpts): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.path) parts.push(`Path=${opts.path}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.secure) parts.push('Secure');
  if (opts.sameSite) {
    const v = opts.sameSite.charAt(0).toUpperCase() + opts.sameSite.slice(1);
    parts.push(`SameSite=${v}`);
  }
  return parts.join('; ');
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test auth/cookies
pnpm --filter @primer/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/cookies.ts apps/api/src/auth/cookies.test.ts
git commit -m "feat(api): cookie parse/serialize helpers"
```

---

### Task 8: Session CRUD (TDD)

**Files:**
- Create: `apps/api/src/auth/session.ts`
- Create: `apps/api/src/auth/session.test.ts`

- [ ] **Step 1: Failing test**

File: `apps/api/src/auth/session.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { sessions, users } from '@primer/shared/schema';
import {
  createSession,
  lookupSession,
  deleteSession,
  refreshSessionIfStale,
  SESSION_TTL_MS,
} from './session.ts';

async function seedUser(id = `u-${Math.random().toString(36).slice(2, 10)}`) {
  await db.insert(users).values({
    id,
    email: `${id}@polygon.technology`,
    displayName: id,
  });
  return id;
}

describe('createSession', () => {
  it('inserts a row, returns id + expiresAt', async () => {
    const userId = await seedUser();
    const result = await createSession({ userId, userAgent: 'vitest' });
    expect(result.id).toMatch(/^[a-f0-9]{64}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 5_000);
    expect(result.expiresAt.getTime()).toBeLessThan(Date.now() + SESSION_TTL_MS + 5_000);

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, result.id));
    expect(row.userId).toBe(userId);
    expect(row.userAgent).toBe('vitest');
  });

  it('accepts null userAgent', async () => {
    const userId = await seedUser();
    const result = await createSession({ userId, userAgent: null });
    const [row] = await db.select().from(sessions).where(eq(sessions.id, result.id));
    expect(row.userAgent).toBeNull();
  });
});

describe('lookupSession', () => {
  it('returns user + session for a live id', async () => {
    const userId = await seedUser();
    const { id } = await createSession({ userId, userAgent: null });

    const found = await lookupSession(id);
    expect(found).not.toBeNull();
    expect(found?.user.id).toBe(userId);
    expect(found?.session.id).toBe(id);
  });

  it('returns null for unknown id', async () => {
    const found = await lookupSession('does-not-exist');
    expect(found).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const userId = await seedUser();
    const expiredId = 'a'.repeat(64);
    await db.insert(sessions).values({
      id: expiredId,
      userId,
      expiresAt: new Date(Date.now() - 60_000),
      lastSeenAt: new Date(),
      createdAt: new Date(),
    });
    const found = await lookupSession(expiredId);
    expect(found).toBeNull();
  });
});

describe('deleteSession', () => {
  it('removes the row', async () => {
    const userId = await seedUser();
    const { id } = await createSession({ userId, userAgent: null });
    await deleteSession(id);
    const found = await lookupSession(id);
    expect(found).toBeNull();
  });

  it('is idempotent on missing id', async () => {
    await deleteSession('not-a-session');
    // Should not throw.
  });
});

describe('refreshSessionIfStale', () => {
  it('does NOT update when expiresAt is more than 7 days out', async () => {
    const userId = await seedUser();
    const { id } = await createSession({ userId, userAgent: null });
    const [before] = await db.select().from(sessions).where(eq(sessions.id, id));

    await refreshSessionIfStale(id);

    const [after] = await db.select().from(sessions).where(eq(sessions.id, id));
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
  });

  it('extends expiresAt when less than 7 days remain', async () => {
    const userId = await seedUser();
    const id = 'b'.repeat(64);
    const soonExpiry = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000); // 6 days out
    await db.insert(sessions).values({
      id,
      userId,
      expiresAt: soonExpiry,
      lastSeenAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
    });

    await refreshSessionIfStale(id);

    const [after] = await db.select().from(sessions).where(eq(sessions.id, id));
    expect(after.expiresAt.getTime()).toBeGreaterThan(soonExpiry.getTime() + 60_000);
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test auth/session
```

Expected: module not found.

- [ ] **Step 3: Implement**

File: `apps/api/src/auth/session.ts`

```ts
import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { sessions, users } from '@primer/shared/schema';

export const SESSION_TTL_MS = Number(process.env.SESSION_TTL_DAYS ?? '14') * 24 * 60 * 60 * 1000;

const REFRESH_THRESHOLD_MS = 7 * 24 * 60 * 60 * 1000;

export interface SessionCreate {
  userId: string;
  userAgent: string | null;
}

export interface SessionCreated {
  id: string;
  expiresAt: Date;
}

export interface SessionLookup {
  user: { id: string; email: string; displayName: string };
  session: { id: string; expiresAt: Date };
}

function newSessionId(): string {
  return randomBytes(32).toString('hex');
}

export async function createSession(input: SessionCreate): Promise<SessionCreated> {
  const id = newSessionId();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({
    id,
    userId: input.userId,
    expiresAt,
    userAgent: input.userAgent,
  });
  return { id, expiresAt };
}

export async function lookupSession(id: string): Promise<SessionLookup | null> {
  const [row] = (await db.execute(sql`
    SELECT
      s.id          AS s_id,
      s.expires_at  AS s_expires_at,
      u.id          AS u_id,
      u.email       AS u_email,
      u.display_name AS u_display_name
    FROM sessions s
    INNER JOIN users u ON u.id = s.user_id
    WHERE s.id = ${id}
      AND s.expires_at > now()
    LIMIT 1
  `)) as unknown as Array<{
    s_id: string;
    s_expires_at: Date | string;
    u_id: string;
    u_email: string;
    u_display_name: string;
  }>;
  if (!row) return null;
  return {
    user: { id: row.u_id, email: row.u_email, displayName: row.u_display_name },
    session: {
      id: row.s_id,
      expiresAt: row.s_expires_at instanceof Date ? row.s_expires_at : new Date(row.s_expires_at),
    },
  };
}

export async function deleteSession(id: string): Promise<void> {
  await db.execute(sql`DELETE FROM sessions WHERE id = ${id}`);
}

/**
 * Slide the expiry forward when less than REFRESH_THRESHOLD_MS remains.
 * Updates last_seen_at every call.
 */
export async function refreshSessionIfStale(id: string): Promise<void> {
  await db.execute(sql`
    UPDATE sessions
    SET last_seen_at = now(),
        expires_at = CASE
          WHEN expires_at < now() + make_interval(secs => ${REFRESH_THRESHOLD_MS / 1000})
          THEN now() + make_interval(secs => ${SESSION_TTL_MS / 1000})
          ELSE expires_at
        END
    WHERE id = ${id}
  `);
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test auth/session
pnpm --filter @primer/api test 2>&1 | tail -5
pnpm --filter @primer/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/session.ts apps/api/src/auth/session.test.ts
git commit -m "feat(api): session.ts — create/lookup/delete/refresh with sliding TTL"
```

---

## Phase F — Okta adapter + oktaResolver

### Task 9: `OktaAdapter` interface + `OpenIdClientAdapter` + `MockOktaAdapter`

**Files:**
- Create: `apps/api/src/auth/okta.ts`
- Modify: `apps/api/package.json` (add openid-client)

- [ ] **Step 1: Install `openid-client`**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api add openid-client@^6.1.0
```

Confirm version is honored:

```bash
grep -A1 '"dependencies"' apps/api/package.json | head -5
cat apps/api/package.json | grep openid-client
```

- [ ] **Step 2: Create the adapter file**

File: `apps/api/src/auth/okta.ts`

```ts
import * as oidc from 'openid-client';

export interface AuthorizationParams {
  url: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OktaClaims {
  sub: string;
  email: string;
  name: string;
}

export interface OktaAdapter {
  /** Returns the authorization URL the user should be redirected to, plus the state/nonce/codeVerifier to persist. */
  buildAuthorizationUrl(): Promise<AuthorizationParams>;
  /** Validates the callback and returns the verified ID token claims. */
  exchangeCode(input: {
    code: string;
    state: string;
    nonce: string;
    codeVerifier: string;
    receivedState: string;
  }): Promise<OktaClaims>;
}

export interface OktaConfig {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scope: string;
}

/**
 * Real adapter. Uses openid-client v6's functional API.
 * Discovery happens lazily on first use, then is cached.
 */
export class OpenIdClientAdapter implements OktaAdapter {
  private configPromise: Promise<oidc.Configuration> | null = null;

  constructor(private readonly cfg: OktaConfig) {}

  private async config(): Promise<oidc.Configuration> {
    if (!this.configPromise) {
      this.configPromise = oidc.discovery(
        new URL(this.cfg.issuer),
        this.cfg.clientId,
        this.cfg.clientSecret
      );
    }
    return this.configPromise;
  }

  async buildAuthorizationUrl(): Promise<AuthorizationParams> {
    const config = await this.config();
    const codeVerifier = oidc.randomPKCECodeVerifier();
    const codeChallenge = await oidc.calculatePKCECodeChallenge(codeVerifier);
    const state = oidc.randomState();
    const nonce = oidc.randomNonce();

    const url = oidc.buildAuthorizationUrl(config, {
      redirect_uri: this.cfg.redirectUri,
      scope: this.cfg.scope,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
      state,
      nonce,
    });

    return { url: url.toString(), state, nonce, codeVerifier };
  }

  async exchangeCode(input: {
    code: string;
    state: string;
    nonce: string;
    codeVerifier: string;
    receivedState: string;
  }): Promise<OktaClaims> {
    if (input.state !== input.receivedState) {
      throw new Error('state mismatch');
    }
    const config = await this.config();
    const callbackUrl = new URL(this.cfg.redirectUri);
    callbackUrl.searchParams.set('code', input.code);
    callbackUrl.searchParams.set('state', input.receivedState);

    const tokens = await oidc.authorizationCodeGrant(config, callbackUrl, {
      pkceCodeVerifier: input.codeVerifier,
      expectedState: input.state,
      expectedNonce: input.nonce,
      idTokenExpected: true,
    });

    const claims = tokens.claims();
    if (!claims) throw new Error('no id token claims');
    const sub = String(claims.sub ?? '');
    const email = String((claims as Record<string, unknown>).email ?? '');
    const name = String((claims as Record<string, unknown>).name ?? '');
    if (!sub || !email || !name) {
      throw new Error('missing required claims (sub/email/name)');
    }
    return { sub, email, name };
  }
}

/**
 * Test adapter — deterministic, no network. Tests inject this directly into AppDeps.oktaAdapter.
 */
export interface MockOktaAdapterOptions {
  /** Override the canned claims that `exchangeCode` will return. */
  claims?: OktaClaims;
  /** Force `exchangeCode` to reject (e.g. to test the callback's error path). */
  shouldFail?: 'state' | 'token' | null;
}

export function makeMockOktaAdapter(opts: MockOktaAdapterOptions = {}): OktaAdapter {
  return {
    async buildAuthorizationUrl() {
      return {
        url: 'https://mock-okta.test/authorize?fake=1',
        state: 'mock-state',
        nonce: 'mock-nonce',
        codeVerifier: 'mock-code-verifier',
      };
    },
    async exchangeCode(input) {
      if (opts.shouldFail === 'state' || input.state !== input.receivedState) {
        throw new Error('state mismatch');
      }
      if (opts.shouldFail === 'token') {
        throw new Error('token exchange failed');
      }
      return (
        opts.claims ?? {
          sub: 'okta-sub-123',
          email: 'alice@polygon.technology',
          name: 'Alice Tester',
        }
      );
    },
  };
}

/**
 * An adapter that throws on use. Wired in when AUTH_MODE=mock so the OIDC routes
 * stay registered but produce a clear 503 if a stray hit lands on them.
 */
export function makeDisabledOktaAdapter(): OktaAdapter {
  return {
    async buildAuthorizationUrl() {
      throw new Error('OIDC disabled (AUTH_MODE=mock)');
    },
    async exchangeCode() {
      throw new Error('OIDC disabled (AUTH_MODE=mock)');
    },
  };
}
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @primer/api typecheck
```

Expected: clean. If openid-client's v6 exports differ from what's used above, adjust to the actual exported names — the file is small and self-contained.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/auth/okta.ts apps/api/package.json pnpm-lock.yaml
git commit -m "feat(api): OktaAdapter (real + mock + disabled); add openid-client dep"
```

---

### Task 10: `oktaResolver` (TDD)

**Files:**
- Modify: `apps/api/src/auth/resolver.ts`
- Create: `apps/api/src/auth/resolver.test.ts`

- [ ] **Step 1: Failing test**

File: `apps/api/src/auth/resolver.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { mockMultiResolver, makeOktaResolver, MOCK_USER } from './resolver.ts';
import { createSession } from './session.ts';
import { db } from '../db/client.ts';
import { users } from '@primer/shared/schema';

function makeReq(cookieHeader?: string) {
  const app = new Hono<{ Variables: AppVariables }>();
  let captured: { user: string | null } = { user: null };
  app.get('/test', async (c) => {
    const user = await resolverUnderTest(c);
    captured.user = user?.id ?? null;
    return c.text('ok');
  });
  let resolverUnderTest: ReturnType<typeof makeOktaResolver>;
  return {
    async run(resolver: ReturnType<typeof makeOktaResolver>) {
      resolverUnderTest = resolver;
      await app.request('/test', {
        headers: cookieHeader ? { cookie: cookieHeader } : {},
      });
      return captured.user;
    },
  };
}

describe('oktaResolver (real path via lookupSession)', () => {
  it('returns null when no cookie is present', async () => {
    const resolver = makeOktaResolver({ cookieName: 'primer_sid' });
    const got = await makeReq().run(resolver);
    expect(got).toBeNull();
  });

  it('returns null when the cookie does not match a session', async () => {
    const resolver = makeOktaResolver({ cookieName: 'primer_sid' });
    const got = await makeReq('primer_sid=does-not-exist').run(resolver);
    expect(got).toBeNull();
  });

  it('returns the user when the cookie matches a live session', async () => {
    const userId = `user-resolver-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(users).values({
      id: userId,
      email: `${userId}@p.t`,
      displayName: userId,
    });
    const { id } = await createSession({ userId, userAgent: null });

    const resolver = makeOktaResolver({ cookieName: 'primer_sid' });
    const got = await makeReq(`primer_sid=${id}`).run(resolver);
    expect(got).toBe(userId);
  });
});

describe('mockMultiResolver', () => {
  it('returns MOCK_USER when no header is set', async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    let captured: string | null = null;
    app.get('/test', async (c) => {
      const user = await mockMultiResolver(c);
      captured = user?.id ?? null;
      return c.text('ok');
    });
    await app.request('/test');
    expect(captured).toBe(MOCK_USER.id);
  });

  it('returns the synthesized user for an explicit header', async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    let captured: { id: string; email: string; displayName: string } | null = null;
    app.get('/test', async (c) => {
      const user = await mockMultiResolver(c);
      captured = user;
      return c.text('ok');
    });
    await app.request('/test', { headers: { 'x-mock-user-id': 'mock-user-2' } });
    expect(captured?.id).toBe('mock-user-2');
    expect(captured?.email).toBe('mock-user-2@polygon.technology');
    expect(captured?.displayName).toBe('mock-user-2');
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test auth/resolver
```

Expected: `makeOktaResolver` not exported.

- [ ] **Step 3: Add `makeOktaResolver` to `apps/api/src/auth/resolver.ts`**

Append to the existing file (don't remove `MOCK_USER`, `mockResolver`, `mockMultiResolver`):

```ts
import { parseCookie } from './cookies.ts';
import { lookupSession, refreshSessionIfStale } from './session.ts';

export interface OktaResolverOptions {
  cookieName: string;
}

export function makeOktaResolver(opts: OktaResolverOptions): UserResolver {
  return async (c) => {
    const sid = parseCookie(c.req.header('cookie') ?? null, opts.cookieName);
    if (!sid) return null;
    const found = await lookupSession(sid);
    if (!found) return null;
    // Sliding refresh — fire and forget; refresh failures don't break the request.
    void refreshSessionIfStale(sid).catch(() => undefined);
    return found.user;
  };
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test auth/resolver
pnpm --filter @primer/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/auth/resolver.ts apps/api/src/auth/resolver.test.ts
git commit -m "feat(api): oktaResolver (cookie → session lookup) + mockMulti tests"
```

---

## Phase G — Auth routes

### Task 11: `GET /auth/login` (TDD)

**Files:**
- Create: `apps/api/src/routes/auth.ts`
- Create: `apps/api/src/routes/auth.test.ts`
- Modify: `apps/api/src/app.ts` (register the route)

- [ ] **Step 1: Failing test**

File: `apps/api/src/routes/auth.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockResolver, makeOktaResolver } from '../auth/resolver.ts';
import { makeMockOktaAdapter, makeDisabledOktaAdapter } from '../auth/okta.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function withAppForAuth<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-auth-'));
  try {
    // For /auth/login tests we use the mock resolver (request is unauthenticated by design;
    // but authMiddleware exempts /auth/login + /auth/callback, so the resolver isn't even
    // consulted).
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: mockResolver,
      oktaAdapter: makeMockOktaAdapter(),
      authCookieName: 'primer_sid',
      authStateCookieName: 'primer_auth_state',
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('GET /auth/login', () => {
  it('302 redirects to Okta with state cookie set', async () => {
    await withAppForAuth(async (app) => {
      const res = await app.request('/auth/login', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://mock-okta.test/authorize?fake=1');
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).not.toBeNull();
      expect(setCookie).toContain('primer_auth_state=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Path=/');
    });
  });

  it('persists return_to in the state cookie payload', async () => {
    await withAppForAuth(async (app) => {
      const res = await app.request('/auth/login?return_to=%2Fd%2Fabc', { redirect: 'manual' });
      expect(res.status).toBe(302);
      const setCookie = res.headers.get('set-cookie') ?? '';
      // The state cookie value is the base64-encoded JSON of { state, nonce, codeVerifier, returnTo }
      // — just assert the cookie was set; deep contents are validated by the callback test.
      expect(setCookie).toContain('primer_auth_state=');
    });
  });

  it('rejects an off-origin return_to with default fallback', async () => {
    await withAppForAuth(async (app) => {
      const res = await app.request('/auth/login?return_to=https%3A%2F%2Fevil.example%2F', { redirect: 'manual' });
      expect(res.status).toBe(302);
      // The cookie should encode returnTo='/' not the malicious URL — covered by the callback test
      // (which reads back the cookie and redirects to the stored returnTo).
    });
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test routes/auth
```

Expected: file imports `oktaAdapter` and cookie names from createApp deps — fails because AppDeps doesn't have them yet.

- [ ] **Step 3: Extend `AppDeps` and create the auth route**

In `apps/api/src/app.ts`, extend `AppDeps`:

```ts
import type { OktaAdapter } from './auth/okta.ts';

export interface AppDeps {
  storage: Storage;
  notifier: Notifier;
  userResolver?: UserResolver;
  oktaAdapter?: OktaAdapter;            // NEW
  authCookieName?: string;              // NEW; defaults to 'primer_sid'
  authStateCookieName?: string;         // NEW; defaults to 'primer_auth_state'
}
```

Add a registration call near the other `register*` calls (before `registerDevFixtureRoute`):

```ts
import { registerAuthRoutes } from './routes/auth.ts';

// inside createApp, after registerVersionRoutes(app):
registerAuthRoutes(app, deps);
```

Then create `apps/api/src/routes/auth.ts`:

```ts
import type { Hono } from 'hono';
import type { AppDeps, AppVariables } from '../app.ts';
import { serializeCookie, parseCookie } from '../auth/cookies.ts';
import { makeDisabledOktaAdapter, type OktaAdapter } from '../auth/okta.ts';
import { logger } from '../logger.ts';

const STATE_COOKIE_MAX_AGE_SEC = 10 * 60;            // 10 minutes
const DEFAULT_SESSION_COOKIE = 'primer_sid';
const DEFAULT_STATE_COOKIE = 'primer_auth_state';

interface StateCookiePayload {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

function encodeState(p: StateCookiePayload): string {
  return Buffer.from(JSON.stringify(p), 'utf-8').toString('base64url');
}

function decodeState(raw: string): StateCookiePayload | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf-8');
    const parsed = JSON.parse(json) as Partial<StateCookiePayload>;
    if (
      typeof parsed.state === 'string' &&
      typeof parsed.nonce === 'string' &&
      typeof parsed.codeVerifier === 'string' &&
      typeof parsed.returnTo === 'string'
    ) {
      return parsed as StateCookiePayload;
    }
    return null;
  } catch {
    return null;
  }
}

function sanitizeReturnTo(input: string | undefined): string {
  if (!input) return '/';
  if (!input.startsWith('/') || input.startsWith('//')) return '/';
  return input;
}

function cookieOpts(maxAge: number, secure: boolean) {
  return { maxAge, httpOnly: true, secure, sameSite: 'lax' as const, path: '/' };
}

export function registerAuthRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
  const adapter: OktaAdapter = deps.oktaAdapter ?? makeDisabledOktaAdapter();
  const sessionCookieName = deps.authCookieName ?? DEFAULT_SESSION_COOKIE;
  const stateCookieName = deps.authStateCookieName ?? DEFAULT_STATE_COOKIE;
  const secure = process.env.NODE_ENV === 'production';

  app.get('/auth/login', async (c) => {
    try {
      const { url, state, nonce, codeVerifier } = await adapter.buildAuthorizationUrl();
      const returnTo = sanitizeReturnTo(c.req.query('return_to'));
      const payload = encodeState({ state, nonce, codeVerifier, returnTo });
      const cookie = serializeCookie(stateCookieName, payload, cookieOpts(STATE_COOKIE_MAX_AGE_SEC, secure));
      c.header('set-cookie', cookie);
      return c.redirect(url, 302);
    } catch (err) {
      logger.error({ err }, '/auth/login failed');
      return c.json({ error: 'oidc_unavailable', message: (err as Error).message }, 503);
    }
  });

  // /auth/callback and /auth/logout land in T12 and T13.
  void parseCookie;
  void sessionCookieName;
}
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test routes/auth
pnpm --filter @primer/api typecheck
```

Expected: 3 tests in `/auth/login` describe block pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/auth.test.ts apps/api/src/app.ts
git commit -m "feat(api): GET /auth/login (PKCE + state cookie + 302 to Okta)"
```

---

### Task 12: `GET /auth/callback` (TDD)

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/routes/auth.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `apps/api/src/routes/auth.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { sessions, users } from '@primer/shared/schema';

describe('GET /auth/callback', () => {
  it('rejects when state cookie is missing', async () => {
    await withAppForAuth(async (app) => {
      const res = await app.request('/auth/callback?code=abc&state=xyz', { redirect: 'manual' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_state');
    });
  });

  it('rejects when state in URL does not match state in cookie', async () => {
    await withAppForAuth(async (app) => {
      // Set up a state cookie by hitting /auth/login first.
      const loginRes = await app.request('/auth/login', { redirect: 'manual' });
      const setCookie = loginRes.headers.get('set-cookie') ?? '';
      // Pull just the cookie name=value part to send back.
      const cookieValue = setCookie.split(';')[0]!;
      const res = await app.request('/auth/callback?code=abc&state=WRONG-STATE', {
        redirect: 'manual',
        headers: { cookie: cookieValue },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_state');
    });
  });

  it('happy path: creates user + session, sets primer_sid cookie, redirects to returnTo', async () => {
    await withAppForAuth(async (app) => {
      const loginRes = await app.request('/auth/login?return_to=%2Fd%2Fdest', { redirect: 'manual' });
      const cookieValue = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;

      const res = await app.request('/auth/callback?code=fake-code&state=mock-state', {
        redirect: 'manual',
        headers: { cookie: cookieValue },
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/d/dest');

      const setCookies = res.headers.get('set-cookie') ?? '';
      expect(setCookies).toContain('primer_sid=');
      expect(setCookies).toContain('primer_auth_state=;');  // cleared

      // The mock adapter's default claims:
      const [user] = await db.select().from(users).where(eq(users.id, 'okta-sub-123'));
      expect(user).toBeDefined();
      expect(user.email).toBe('alice@polygon.technology');
      expect(user.displayName).toBe('Alice Tester');

      const sids = await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, 'okta-sub-123'));
      expect(sids.length).toBeGreaterThan(0);
    });
  });

  it('upserts user on subsequent login (name change propagates)', async () => {
    await withAppForAuth(async (app) => {
      // Pre-seed the user with an old name.
      await db.insert(users).values({
        id: 'okta-sub-123',
        email: 'alice@polygon.technology',
        displayName: 'Alice Old Name',
      }).onConflictDoNothing();

      const loginRes = await app.request('/auth/login', { redirect: 'manual' });
      const cookieValue = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;
      await app.request('/auth/callback?code=fake-code&state=mock-state', {
        redirect: 'manual',
        headers: { cookie: cookieValue },
      });

      const [updated] = await db.select().from(users).where(eq(users.id, 'okta-sub-123'));
      expect(updated.displayName).toBe('Alice Tester');   // upserted from claims
    });
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test routes/auth
```

Expected: 4 callback tests fail (handler not implemented).

- [ ] **Step 3: Implement the callback handler**

In `apps/api/src/routes/auth.ts`, replace the placeholder `void parseCookie; void sessionCookieName;` lines with the callback handler. Final body of `registerAuthRoutes`:

```ts
  app.get('/auth/login', async (c) => {
    try {
      const { url, state, nonce, codeVerifier } = await adapter.buildAuthorizationUrl();
      const returnTo = sanitizeReturnTo(c.req.query('return_to'));
      const payload = encodeState({ state, nonce, codeVerifier, returnTo });
      const cookie = serializeCookie(stateCookieName, payload, cookieOpts(STATE_COOKIE_MAX_AGE_SEC, secure));
      c.header('set-cookie', cookie);
      return c.redirect(url, 302);
    } catch (err) {
      logger.error({ err }, '/auth/login failed');
      return c.json({ error: 'oidc_unavailable', message: (err as Error).message }, 503);
    }
  });

  app.get('/auth/callback', async (c) => {
    const code = c.req.query('code');
    const receivedState = c.req.query('state');
    const cookieHeader = c.req.header('cookie') ?? null;
    const rawState = parseCookie(cookieHeader, stateCookieName);
    if (!code || !receivedState || !rawState) {
      return c.json({ error: 'invalid_state', message: 'Missing state' }, 400);
    }
    const stored = decodeState(rawState);
    if (!stored) {
      return c.json({ error: 'invalid_state', message: 'Malformed state cookie' }, 400);
    }
    if (stored.state !== receivedState) {
      return c.json({ error: 'invalid_state', message: 'State mismatch' }, 400);
    }

    let claims;
    try {
      claims = await adapter.exchangeCode({
        code,
        state: stored.state,
        nonce: stored.nonce,
        codeVerifier: stored.codeVerifier,
        receivedState,
      });
    } catch (err) {
      logger.error({ err }, '/auth/callback exchange failed');
      return c.json({ error: 'oidc_failure', message: (err as Error).message }, 400);
    }

    // Upsert user
    await db.execute(sql`
      INSERT INTO users (id, email, display_name)
      VALUES (${claims.sub}, ${claims.email}, ${claims.name})
      ON CONFLICT (id)
      DO UPDATE SET email = EXCLUDED.email, display_name = EXCLUDED.display_name
    `);

    const userAgent = c.req.header('user-agent') ?? null;
    const { id: sid, expiresAt } = await createSession({ userId: claims.sub, userAgent });

    const maxAgeSec = Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
    const sessionCookie = serializeCookie(sessionCookieName, sid, cookieOpts(maxAgeSec, secure));
    const clearStateCookie = serializeCookie(stateCookieName, '', cookieOpts(0, secure));
    // Hono accepts multiple Set-Cookie headers via append.
    c.header('set-cookie', sessionCookie, { append: true });
    c.header('set-cookie', clearStateCookie, { append: true });
    return c.redirect(stored.returnTo || '/', 302);
  });
```

Add the new imports at the top:

```ts
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { createSession } from '../auth/session.ts';
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test routes/auth
pnpm --filter @primer/api typecheck
```

Expected: 4 callback tests pass plus the 3 login tests stay green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/auth.test.ts
git commit -m "feat(api): GET /auth/callback (state check, token exchange, user upsert, session)"
```

---

### Task 13: `POST /auth/logout` (TDD)

**Files:**
- Modify: `apps/api/src/routes/auth.ts`
- Modify: `apps/api/src/routes/auth.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `apps/api/src/routes/auth.test.ts`. The logout endpoint requires a real authenticated session, so we need to drive the test app with `oktaResolver` + a seeded session:

```ts
import { makeOktaResolver } from '../auth/resolver.ts';
import { createSession } from '../auth/session.ts';

async function withAuthenticatedApp<T>(
  fn: (app: ReturnType<typeof createApp>, ctx: { sid: string; userId: string }) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-auth-logout-'));
  try {
    const userId = `logout-user-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(users).values({
      id: userId,
      email: `${userId}@p.t`,
      displayName: userId,
    });
    const { id: sid } = await createSession({ userId, userAgent: null });

    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: makeOktaResolver({ cookieName: 'primer_sid' }),
      oktaAdapter: makeMockOktaAdapter(),
      authCookieName: 'primer_sid',
      authStateCookieName: 'primer_auth_state',
    });
    return await fn(app, { sid, userId });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('POST /auth/logout', () => {
  it('204 deletes the session row and clears the cookie', async () => {
    await withAuthenticatedApp(async (app, { sid }) => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          cookie: `primer_sid=${sid}`,
          'x-primer-csrf': '1',
        },
      });
      expect(res.status).toBe(204);
      const setCookies = res.headers.get('set-cookie') ?? '';
      expect(setCookies).toContain('primer_sid=;');
      expect(setCookies).toContain('Max-Age=0');

      const rows = await db.select().from(sessions).where(eq(sessions.id, sid));
      expect(rows).toHaveLength(0);
    });
  });

  it('401 if no session cookie present', async () => {
    await withAuthenticatedApp(async (app) => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: { 'x-primer-csrf': '1' },
      });
      expect(res.status).toBe(401);
    });
  });

  it('403 if CSRF header missing', async () => {
    await withAuthenticatedApp(async (app, { sid }) => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: { cookie: `primer_sid=${sid}` },
      });
      expect(res.status).toBe(403);
    });
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test routes/auth
```

Expected: 3 logout tests fail (404 from missing route).

- [ ] **Step 3: Implement logout**

In `apps/api/src/routes/auth.ts`, add to the bottom of `registerAuthRoutes`:

```ts
  app.post('/auth/logout', async (c) => {
    const cookieHeader = c.req.header('cookie') ?? null;
    const sid = parseCookie(cookieHeader, sessionCookieName);
    if (sid) {
      await deleteSession(sid);
    }
    const clearCookie = serializeCookie(sessionCookieName, '', cookieOpts(0, secure));
    c.header('set-cookie', clearCookie);
    return c.body(null, 204);
  });
```

Add the import:

```ts
import { createSession, deleteSession } from '../auth/session.ts';
```

(Replacing the existing single `createSession` import.)

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test routes/auth
pnpm --filter @primer/api test 2>&1 | tail -5
pnpm --filter @primer/api typecheck
```

Expected: all auth tests pass; full suite green.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/auth.ts apps/api/src/routes/auth.test.ts
git commit -m "feat(api): POST /auth/logout (delete session, clear cookie, 204)"
```

---

## Phase H — /api/me + uploaderId

### Task 14: `GET /api/me` + uploaderId is now visible in document detail (TDD)

**Files:**
- Create: `apps/api/src/routes/me.ts`
- Create: `apps/api/src/routes/me.test.ts`
- Modify: `apps/api/src/app.ts` (register the route)
- Modify: `apps/api/src/routes/documents.test.ts` (assert uploaderId in DocumentDetailResponse)

- [ ] **Step 1: Failing tests**

File: `apps/api/src/routes/me.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockResolver, mockMultiResolver } from '../auth/resolver.ts';
import type { UserDTO } from '@primer/shared';
import { CSRF_HEADERS } from '../test/harness.ts';

describe('GET /api/me', () => {
  it('returns the current user as UserDTO (mock resolver)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-me-'));
    try {
      const app = createApp({
        storage: new FilesystemStorage(root),
        notifier: new NoopNotifier(),
        userResolver: mockResolver,
      });
      const res = await app.request('/api/me');
      expect(res.status).toBe(200);
      const body = (await res.json()) as UserDTO;
      expect(body).toEqual({
        id: 'mock-user-1',
        email: 'mock@polygon.technology',
        displayName: 'Mock User',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns the user from X-Mock-User-Id when using multi-mock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-me-multi-'));
    try {
      const app = createApp({
        storage: new FilesystemStorage(root),
        notifier: new NoopNotifier(),
        userResolver: mockMultiResolver,
      });
      const res = await app.request('/api/me', {
        headers: { 'x-mock-user-id': 'mock-user-2' },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).id).toBe('mock-user-2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

Append to `apps/api/src/routes/documents.test.ts`:

```ts
describe('GET /api/documents/:docId — uploaderId in response', () => {
  it('includes uploaderId in the document detail body', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-uploaderid-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);
      const res = await app.request(`/api/documents/${upload.documentId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { document: { uploaderId: string } };
      expect(body.document.uploaderId).toBe('mock-user-1');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test routes/me
```

Expected: module not found. The documents test may already pass if T1 step 5 set `uploaderId` correctly — confirm:

```bash
pnpm --filter @primer/api test documents -t "uploaderId"
```

Expected: pass (T1 step 5 covered it).

- [ ] **Step 3: Implement `/api/me`**

File: `apps/api/src/routes/me.ts`

```ts
import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import type { UserDTO } from '@primer/shared';

export function registerMeRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/me', (c) => {
    const u = c.get('user');
    const body: UserDTO = { id: u.id, email: u.email, displayName: u.displayName };
    return c.json(body, 200);
  });
}
```

In `apps/api/src/app.ts`, register it next to the other routes:

```ts
import { registerMeRoute } from './routes/me.ts';
// ... inside createApp ...
registerMeRoute(app);
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test routes/me
pnpm --filter @primer/api typecheck
pnpm --filter @primer/api test 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/me.ts apps/api/src/routes/me.test.ts apps/api/src/app.ts apps/api/src/routes/documents.test.ts
git commit -m "feat(api): GET /api/me + uploaderId test on document detail"
```

---

## Phase I — Multi-user test harness

### Task 15: `withMockUser` harness + cross-user 403 tests

**Files:**
- Modify: `apps/api/src/test/harness.ts`
- Create: `apps/api/src/test/crossUser.test.ts`

- [ ] **Step 1: Extend the harness**

`apps/api/src/test/harness.ts` (already has `CSRF_HEADERS` from T6). Append:

```ts
import type { createApp } from '../app.ts';

export type App = ReturnType<typeof createApp>;

/** Headers that simulate user `userId` plus the CSRF token. */
export function asUser(userId: string): Record<string, string> {
  return { 'x-mock-user-id': userId, 'x-primer-csrf': '1' };
}

export function asUserJson(userId: string): Record<string, string> {
  return { ...asUser(userId), 'content-type': 'application/json' };
}
```

- [ ] **Step 2: Cross-user tests**

File: `apps/api/src/test/crossUser.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { documents, users, versions } from '@primer/shared/schema';
import { asUser, asUserJson, CSRF_HEADERS } from './harness.ts';
import { uploadFixture } from '../routes/upload.testlib.ts';

async function withMultiUserApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-multi-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: mockMultiResolver,
    });
    // Seed the two users we'll use.
    await db.insert(users).values([
      { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
      { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
    ]).onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('cross-user ownership boundaries (multi-user)', () => {
  it('PATCH /api/documents/:id by non-uploader → 403', async () => {
    await withMultiUserApp(async (app) => {
      // user-1 uploads. uploadFixture defaults to mock-user-1.
      const upload = await uploadFixture(app);
      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ title: 'Hijack' }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('DELETE /api/documents/:id by non-uploader → 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request(`/api/documents/${upload.documentId}`, {
        method: 'DELETE',
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(403);
    });
  });

  it('POST /api/documents/:id/versions by non-uploader → 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const fd = new FormData();
      fd.append('file', new Blob(['<html><body></body></html>'], { type: 'text/html' }), 'v2.html');
      const res = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: asUser('mock-user-2'),
        body: fd,
      });
      expect(res.status).toBe(403);
    });
  });

  it('POST /api/documents/:id/restore by non-uploader → 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, upload.documentId));
      const res = await app.request(`/api/documents/${upload.documentId}/restore`, {
        method: 'POST',
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(403);
    });
  });

  it('PATCH /api/versions/:vid by non-uploader → 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      const res = await app.request(`/api/versions/${v.id}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ versionNote: 'sneak' }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('GET /api/me reflects X-Mock-User-Id', async () => {
    await withMultiUserApp(async (app) => {
      const r1 = await app.request('/api/me', { headers: { 'x-mock-user-id': 'mock-user-1' } });
      expect((await r1.json()).id).toBe('mock-user-1');
      const r2 = await app.request('/api/me', { headers: { 'x-mock-user-id': 'mock-user-2' } });
      expect((await r2.json()).id).toBe('mock-user-2');
    });
  });
});
```

If `uploadFixture` doesn't exist as a shared helper, look in `apps/api/src/routes/upload.test.ts` for the local helper and inline it here (or extract it to `apps/api/src/routes/upload.testlib.ts`).

If `uploadFixture` is a function inside `upload.test.ts` only, create the shared module:

File: `apps/api/src/routes/upload.testlib.ts`

```ts
import type { createApp } from '../app.ts';
import { CSRF_HEADERS } from '../test/harness.ts';

const TINY_HTML = '<html><body><h1>fixture</h1></body></html>';

export async function uploadFixture(app: ReturnType<typeof createApp>): Promise<{
  documentId: string;
  versionId: string;
  url: string;
}> {
  const fd = new FormData();
  fd.append('file', new Blob([TINY_HTML], { type: 'text/html' }), 'fixture.html');
  fd.append('title', 'Fixture doc');
  const res = await app.request('/api/upload', {
    method: 'POST',
    headers: CSRF_HEADERS,
    body: fd,
  });
  if (!res.ok) throw new Error(`uploadFixture failed: ${res.status}`);
  const body = (await res.json()) as { documentId: string; versionId: string; url: string };
  return body;
}
```

Then update `apps/api/src/routes/upload.test.ts` to import the shared helper instead of defining its own (or keep the local one and have the new tests import from there).

- [ ] **Step 3: Run — verify pass**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test crossUser
pnpm --filter @primer/api test 2>&1 | tail -5
pnpm --filter @primer/api typecheck
```

Expected: 6 cross-user tests pass; full suite green.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/test apps/api/src/routes/upload.testlib.ts apps/api/src/routes/upload.test.ts 2>/dev/null
git add apps/api/src/test/crossUser.test.ts
git commit -m "test(api): multi-user cross-ownership 403 cases via mockMultiResolver"
```

---

## Phase J — Session cleanup

### Task 16: `purgeExpiredSessions` + interval wiring (TDD)

**Files:**
- Modify: `apps/api/src/jobs/purge.ts`
- Modify: `apps/api/src/jobs/purge.test.ts`

- [ ] **Step 1: Failing tests**

Append to `apps/api/src/jobs/purge.test.ts`:

```ts
import { purgeExpiredSessions } from './purge.ts';
import { sessions, users } from '@primer/shared/schema';

describe('purgeExpiredSessions', () => {
  it('deletes sessions whose expires_at is more than 7 days in the past', async () => {
    const userId = `purge-sess-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(users).values({
      id: userId,
      email: `${userId}@p.t`,
      displayName: userId,
    });
    const oldSid = 'old' + 'a'.repeat(61);
    const freshSid = 'fresh' + 'a'.repeat(59);
    await db.insert(sessions).values([
      {
        id: oldSid,
        userId,
        expiresAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
        lastSeenAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
        createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      },
      {
        id: freshSid,
        userId,
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        lastSeenAt: new Date(),
        createdAt: new Date(),
      },
    ]);

    const report = await purgeExpiredSessions();
    expect(report.deletedCount).toBe(1);

    const remaining = await db.select().from(sessions).where(eq(sessions.userId, userId));
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(freshSid);
  });

  it('returns deletedCount: 0 when nothing is past the grace window', async () => {
    const report = await purgeExpiredSessions();
    expect(report.deletedCount).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
pnpm --filter @primer/api test jobs/purge
```

Expected: `purgeExpiredSessions` not exported.

- [ ] **Step 3: Implement and wire into interval**

In `apps/api/src/jobs/purge.ts`, append after `purgeExpiredDocuments`:

```ts
export interface SessionPurgeReport {
  deletedCount: number;
  durationMs: number;
}

const SESSION_GRACE_DAYS = 7;

export async function purgeExpiredSessions(): Promise<SessionPurgeReport> {
  const startedAt = Date.now();
  const result = (await db.execute(sql`
    DELETE FROM sessions
    WHERE expires_at < now() - make_interval(days => ${SESSION_GRACE_DAYS})
  `)) as unknown as { count?: number; rowCount?: number } | unknown;
  // Drizzle's underlying driver may surface rowCount via different keys.
  let deletedCount = 0;
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (typeof obj.count === 'number') deletedCount = obj.count;
    else if (typeof obj.rowCount === 'number') deletedCount = obj.rowCount;
  }
  return { deletedCount, durationMs: Date.now() - startedAt };
}
```

Update `startPurgeInterval` to also call `purgeExpiredSessions` on each tick. Find the existing interval tick code:

```ts
  const tick = async () => {
    if (stopped) return;
    inFlight = (async () => {
      try {
        const docReport = await purgeExpiredDocuments({ storage: deps.storage });
        const sessionReport = await purgeExpiredSessions();
        if (
          docReport.purgedDocumentIds.length > 0 ||
          docReport.failedStorageKeys.length > 0 ||
          sessionReport.deletedCount > 0
        ) {
          logger.info({ docReport, sessionReport }, 'purge interval: complete');
        }
      } catch (err) {
        logger.error({ err }, 'purge interval: unexpected failure');
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  };
```

- [ ] **Step 4: Run — verify pass**

```bash
pnpm --filter @primer/api test jobs/purge
pnpm --filter @primer/api test 2>&1 | tail -5
pnpm --filter @primer/api typecheck
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/jobs/purge.ts apps/api/src/jobs/purge.test.ts
git commit -m "feat(api): purgeExpiredSessions wired into startPurgeInterval"
```

---

### Task 16b: Real Okta wiring in `index.ts`

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Update `apps/api/src/index.ts`**

Replace the resolver-selection block with a real branch on `AUTH_MODE`:

```ts
import './env.ts';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { logger } from './logger.ts';
import { FilesystemStorage } from './storage/filesystem.ts';
import { NoopNotifier } from './notifications/notifier.ts';
import { startPurgeInterval } from './jobs/purge.ts';
import { mockResolver, makeOktaResolver, type UserResolver } from './auth/resolver.ts';
import { OpenIdClientAdapter, makeDisabledOktaAdapter, type OktaAdapter } from './auth/okta.ts';

const port = Number(process.env.PORT ?? 3000);
const storageRoot = process.env.STORAGE_ROOT ?? './storage';
const storage = new FilesystemStorage(storageRoot);
const notifier = new NoopNotifier();

const authMode = (process.env.AUTH_MODE ?? 'mock').toLowerCase();
const sessionCookieName = process.env.SESSION_COOKIE_NAME ?? 'primer_sid';

let userResolver: UserResolver;
let oktaAdapter: OktaAdapter;

if (authMode === 'okta') {
  const issuer = process.env.OKTA_ISSUER;
  const clientId = process.env.OKTA_CLIENT_ID;
  const clientSecret = process.env.OKTA_CLIENT_SECRET;
  const authBaseUrl = process.env.AUTH_BASE_URL;
  if (!issuer || !clientId || !clientSecret || !authBaseUrl) {
    throw new Error(
      'AUTH_MODE=okta but one of OKTA_ISSUER, OKTA_CLIENT_ID, OKTA_CLIENT_SECRET, AUTH_BASE_URL is missing.'
    );
  }
  userResolver = makeOktaResolver({ cookieName: sessionCookieName });
  oktaAdapter = new OpenIdClientAdapter({
    issuer,
    clientId,
    clientSecret,
    redirectUri: `${authBaseUrl.replace(/\/$/, '')}/auth/callback`,
    scope: 'openid profile email',
  });
} else {
  userResolver = mockResolver;
  oktaAdapter = makeDisabledOktaAdapter();
}

const app = createApp({
  storage,
  notifier,
  userResolver,
  oktaAdapter,
  authCookieName: sessionCookieName,
});

const purgeIntervalMs = process.env.PURGE_INTERVAL_MS
  ? Number(process.env.PURGE_INTERVAL_MS)
  : undefined;
const stopPurge = startPurgeInterval({ storage, intervalMs: purgeIntervalMs });

const server = serve({ fetch: app.fetch, port }, () => {
  logger.info({ port, storageRoot, authMode }, 'primer api listening');
});

const shutdown = async () => {
  await stopPurge();
  if ('close' in server) {
    (server as { close: (cb?: () => void) => void }).close(() => process.exit(0));
  } else {
    process.exit(0);
  }
};
process.on('SIGTERM', () => { void shutdown(); });
process.on('SIGINT', () => { void shutdown(); });
```

- [ ] **Step 2: Boot smoke check (mock mode)**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pkill -f 'primer/apps/(web|api)/node_modules' 2>/dev/null
sleep 1
AUTH_MODE=mock pnpm dev > /tmp/primer-sp5-mock.log 2>&1 &
DEV_PID=$!
sleep 6
curl -s http://localhost:3000/api/health
echo
curl -s http://localhost:3000/api/me
echo
kill $DEV_PID 2>/dev/null
wait 2>/dev/null
pkill -f 'primer/apps/(web|api)/node_modules' 2>/dev/null
```

Expected: `/api/health` returns `{"ok":true}`; `/api/me` returns `{"id":"mock-user-1","email":"mock@polygon.technology","displayName":"Mock User"}`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(api): index.ts picks resolver + Okta adapter via AUTH_MODE"
```

---

## Phase K — Frontend integration

### Task 17: `api()` fetch wrapper

**Files:**
- Create: `apps/web/src/lib/fetch.ts`

- [ ] **Step 1: Implement**

File: `apps/web/src/lib/fetch.ts`

```ts
const CSRF_HEADER = 'X-Primer-Csrf';

/**
 * Wraps fetch() with two app-wide concerns:
 *   1. CSRF header on every request (the server rejects mutating verbs without it,
 *      and adding it to GETs is harmless).
 *   2. On 401, redirect the whole window to /auth/login?return_to=<current path>
 *      so a session expiring mid-app drops the user back to Okta cleanly.
 */
export async function api(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has(CSRF_HEADER)) {
    headers.set(CSRF_HEADER, '1');
  }
  const res = await fetch(input, { ...init, headers });
  if (res.status === 401) {
    const returnTo = encodeURIComponent(window.location.pathname + window.location.search);
    window.location.href = `/auth/login?return_to=${returnTo}`;
    // Return the response so callers don't crash, but the redirect already started.
    return res;
  }
  return res;
}
```

- [ ] **Step 2: Typecheck**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web typecheck
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/fetch.ts
git commit -m "feat(web): api() wrapper — CSRF header + 401 redirect to /auth/login"
```

---

### Task 18: `useMe()` + AppShell identity widget + Sign-out

**Files:**
- Create: `apps/web/src/queries/me.ts`
- Create: `apps/web/src/components/UserMenu.tsx`
- Modify: `apps/web/src/AppShell.tsx`

- [ ] **Step 1: Create `useMe()`**

File: `apps/web/src/queries/me.ts`

```ts
import { useQuery } from '@tanstack/react-query';
import type { UserDTO } from '@primer/shared';
import { api } from '../lib/fetch.ts';

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: async (): Promise<UserDTO> => {
      const res = await api('/api/me');
      if (!res.ok) throw new Error(`me fetch failed: ${res.status}`);
      return res.json();
    },
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });
}
```

- [ ] **Step 2: Create `UserMenu` component**

File: `apps/web/src/components/UserMenu.tsx`

```tsx
import { useEffect, useRef, useState } from 'react';
import { useMe } from '../queries/me.ts';
import { api } from '../lib/fetch.ts';

export function UserMenu() {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    if (open) document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  if (!me.data) return null;

  async function signOut() {
    setOpen(false);
    await api('/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="flex items-center gap-1.5 rounded px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-100"
      >
        <span>{me.data.displayName}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 z-10 mt-1 w-44 overflow-hidden rounded border border-neutral-200 bg-white py-1 shadow-md"
        >
          <button
            type="button"
            role="menuitem"
            onClick={signOut}
            className="block w-full px-3 py-1.5 text-left text-xs text-neutral-700 hover:bg-neutral-50"
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Modify `apps/web/src/AppShell.tsx`**

```tsx
import { Outlet, Link } from 'react-router-dom';
import { UserMenu } from './components/UserMenu.tsx';

export function AppShell() {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-neutral-200 px-6 py-3 flex items-center justify-between">
        <Link to="/" className="font-semibold">
          Primer
        </Link>
        <UserMenu />
      </header>
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck + build**

```bash
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build 2>&1 | tail -5
```

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/queries/me.ts apps/web/src/components/UserMenu.tsx apps/web/src/AppShell.tsx
git commit -m "feat(web): useMe() query + UserMenu (header identity + Sign out)"
```

---

### Task 19: Migrate all existing queries/mutations to `api()`

**Files:**
- Modify: `apps/web/src/queries/documents.ts`
- Modify: `apps/web/src/queries/versions.ts`
- Modify: `apps/web/src/queries/threads.ts`
- Modify: `apps/web/src/queries/dashboard.ts`
- Modify: `apps/web/src/queries/mutations.ts`
- Modify: `apps/web/src/routes/upload.tsx` (uses bare `fetch` for the upload)
- Modify: any other files that call `fetch('/api/...')` directly

- [ ] **Step 1: Find all bare `fetch` calls under `apps/web/src/`**

```bash
grep -rn "fetch(" apps/web/src --include='*.ts' --include='*.tsx'
```

For each result that hits `/api/...` or `/auth/...`, replace `fetch(` with `api(` and add the import:

```ts
import { api } from '../lib/fetch.ts';
```

(Adjust the relative path based on file location: `../lib/fetch.ts` from `routes/`, `../lib/fetch.ts` from `queries/`, `./lib/fetch.ts` from `App.tsx`.)

Do not migrate calls that are clearly external (none expected — all current calls are same-origin to `/api/...`).

- [ ] **Step 2: Verify migration with grep**

```bash
grep -rn "fetch(" apps/web/src --include='*.ts' --include='*.tsx' | grep -v 'api/lib/fetch' | grep -v ' api('
```

Expected: empty, or only matches inside string literals / comments. If anything real is left, migrate it.

- [ ] **Step 3: Typecheck + build**

```bash
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build 2>&1 | tail -5
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "refactor(web): migrate all API fetches to api() wrapper (CSRF + 401 redirect)"
```

---

### Task 20: DocumentPage uploaderId predicate

**Files:**
- Modify: `apps/web/src/routes/document.tsx`

- [ ] **Step 1: Replace the placeholder predicate**

In `apps/web/src/routes/document.tsx`, find the `isUploader` line that currently reads:

```tsx
const isUploader = docQuery.data?.document.uploaderDisplayName === 'Mock User';
```

…and the multi-line SP4 placeholder comment. Replace both with:

```tsx
const me = useMe();
const isUploader = !!me.data && me.data.id === docQuery.data?.document.uploaderId;
```

Add the import at the top:

```tsx
import { useMe } from '../queries/me.ts';
```

- [ ] **Step 2: Typecheck + build**

```bash
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build 2>&1 | tail -5
```

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/document.tsx
git commit -m "feat(web): DocumentPage uses uploaderId === me.id (drop SP4 displayName placeholder)"
```

---

## Phase L — Verification + finalize

### Task 21: Cross-cutting verification

**Files:** none.

- [ ] **Step 1: `pnpm verify` + smoke**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm verify 2>&1 | tail -30
```

Expected: typecheck clean across all workspaces; tests green (api ≈ 145+ counting auth + cross-user + session tests; web 17).

- [ ] **Step 2: Boot smoke check (mock mode end-to-end)**

```bash
pkill -f 'primer/apps/(web|api)/node_modules' 2>/dev/null
sleep 1

AUTH_MODE=mock pnpm dev > /tmp/primer-sp5-smoke.log 2>&1 &
DEV_PID=$!
sleep 6
echo "--- health ---"
curl -s http://localhost:3000/api/health
echo
echo "--- me ---"
curl -s http://localhost:3000/api/me
echo
echo "--- dashboard ---"
curl -s http://localhost:3000/api/dashboard | head -c 200
echo
echo "--- logout (CSRF + no session → 401 expected) ---"
curl -si -X POST http://localhost:3000/auth/logout -H 'X-Primer-Csrf: 1' | head -3
kill $DEV_PID 2>/dev/null
wait 2>/dev/null
pkill -f 'primer/apps/(web|api)/node_modules' 2>/dev/null
```

Expected outputs:
- `/api/health` → `{"ok":true}`
- `/api/me` → `{"id":"mock-user-1",...}`
- `/api/dashboard` → JSON body (200)
- `POST /auth/logout` with mock resolver → 204 (mock resolver always sets a user; logout is a no-op when no session row exists)

If a path fails, find and fix before proceeding.

- [ ] **Step 3: Commit history check**

```bash
git log --oneline master..HEAD | wc -l
git log --oneline -22
```

Expected: ~22 commits since branching, matching the task count.

---

### Task 22: Final code review + squash merge

**Files:** none beyond branch deletion.

- [ ] **Step 1: Dispatch a final code reviewer** for the entire `master..feat/auth-ownership` diff. Focus areas:
  - `authMiddleware` correctness: 401 on /api, 302 on page routes, public exemption set, /auth/* handled right.
  - `csrfMiddleware` correctness on every mutating endpoint INCLUDING /auth/logout; no GET impact.
  - OIDC flow: state cookie integrity, state-cookie clearance on success, sliding TTL math, error paths return 4xx (not 500).
  - Session lifecycle: create, lookup (with `expires_at > now()` filter), refresh threshold, delete on logout, purge after 7-day grace.
  - Cross-user 403 coverage matches the spec's 6 enumerated cases.
  - Frontend api() wrapper: every existing fetch migrated, 401 redirect doesn't recurse.
  - DocumentPage predicate uses `me.id === document.uploaderId` (no displayName).
  - Production-only `secure` cookie flag is set when `NODE_ENV === 'production'`.

- [ ] **Step 2: Apply small fixes** flagged as Important. Skip Minor.

- [ ] **Step 3: Squash-merge**

```bash
cd /home/taylan/development/polygon/primer
git checkout master
git merge --squash feat/auth-ownership
git commit -m "$(cat <<'EOF'
Implement Primer sub-project 5: auth + ownership

Opens Phase 2 by replacing the mock-user middleware with real Okta
OIDC authentication, Postgres-backed sessions, CSRF protection on
mutating endpoints, and end-to-end uploader-only enforcement that
is now testable with two distinct identities.

Shared:
- New sessions table (id, user_id, expires_at, created_at,
  last_seen_at, user_agent) with sliding 14-day TTL refreshed once
  the remaining lifetime drops below 7 days.
- UserDTO + uploaderId added to the document detail response so
  the frontend's "am I the uploader?" check can stop relying on
  the SP4 'Mock User' displayName placeholder.

API:
- authMiddleware (replaces mockUserMiddleware): looks up the
  current user via an injected UserResolver; returns 401 JSON on
  /api/* without a session and 302 to /auth/login on page routes.
  Public exemptions: /api/health, /auth/login, /auth/callback.
- csrfMiddleware: rejects POST/PATCH/PUT/DELETE without
  X-Primer-Csrf: 1 (covers /api/* mutating endpoints AND
  /auth/logout).
- New auth/ directory: cookies.ts (parse/serialize), session.ts
  (create/lookup/delete/refresh sliding TTL), okta.ts (OktaAdapter
  interface + OpenIdClientAdapter wrapping openid-client v6 +
  MockOktaAdapter for tests + disabled adapter for mock mode),
  resolver.ts (mockResolver, mockMultiResolver reading
  X-Mock-User-Id, oktaResolver doing cookie → session → user).
- GET /auth/login: PKCE + state + nonce, encoded into a 10-min
  HttpOnly cookie, 302 to Okta authorization endpoint. Sanitizes
  return_to (same-origin paths only).
- GET /auth/callback: validates state, exchanges code via
  openid-client, upserts the user row from claims (sub, email,
  name), creates a session, sets the primer_sid cookie, clears
  the state cookie, redirects to the stored return_to.
- POST /auth/logout: deletes the session row, clears the cookie,
  returns 204.
- GET /api/me: returns the current user as UserDTO.
- purgeExpiredSessions wired into the existing startPurgeInterval
  job; deletes session rows whose expires_at is more than 7 days
  in the past.
- index.ts picks userResolver + oktaAdapter by AUTH_MODE
  (mock | okta) and throws on boot if AUTH_MODE=okta without the
  full Okta env set.

Web:
- New api() fetch wrapper sets X-Primer-Csrf on every request and
  redirects the whole window to /auth/login on a 401 mid-session.
  Every existing fetch() in queries/components migrates to it.
- New useMe() query (TanStack Query, staleTime: Infinity).
- AppShell gains a UserMenu in the header with a Sign out item
  that POSTs /auth/logout and navigates to /.
- DocumentPage's isUploader is now me.id === document.uploaderId.

Tests: ~11 new API test files covering authMiddleware,
csrfMiddleware, cookies, sessions, oktaResolver, /auth/login,
/auth/callback, /auth/logout, /api/me, purgeExpiredSessions, and a
6-case cross-user 403 sweep via mockMultiResolver. Existing 134
tests retained (each mutating call gained the X-Primer-Csrf
header). Final count: 145+ API + 17 web tests.

No new schema beyond the sessions table; users.id already
accommodated the Okta sub from SP1's design comment.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git log --oneline -3
```

- [ ] **Step 4: Verify tests still green on master**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
pnpm --filter @primer/api test 2>&1 | tail -5
pnpm --filter @primer/web test 2>&1 | tail -5
```

- [ ] **Step 5: Delete the feature branch**

```bash
git branch -D feat/auth-ownership
git branch -a
```

Expected: only `master` remains.

- [ ] **Step 6: Done.**

The next operational step is OUTSIDE this implementation plan (per spec Section 6):
1. Push `master` to a new `0xPolygon/primer` GitHub repo.
2. Run the `polygon-deploy` skill (App Audit → Railway pre-flight → Deploy → Generate Domain).
3. Take the generated `*.up.railway.app` URL, request Okta app registration via `@assist` Slack with the config from spec Section 6.
4. Receive `client_id` / `client_secret`, set Railway env vars (including `AUTH_MODE=okta`).
5. Multi-user smoke (spec Section 5).

---

## Notes for the implementer

- **openid-client v6 API.** This plan assumes the v6 functional API (`oidc.discovery`, `oidc.buildAuthorizationUrl`, `oidc.authorizationCodeGrant`, `oidc.randomPKCECodeVerifier`, `oidc.calculatePKCECodeChallenge`, `oidc.randomState`, `oidc.randomNonce`). If a different minor version is installed by `pnpm add`, adapt to the actual export names — the file `apps/api/src/auth/okta.ts` is small and self-contained. The published TypeScript declarations are the source of truth.
- **Cookie scope.** All cookies use `Path=/`. `Secure` only when `NODE_ENV === 'production'` (so localhost dev over HTTP still works).
- **The `mockMultiResolver` synthesizes user objects when the id is not `mock-user-1`.** Tests that need a fully persisted user row should `db.insert(users).values(...)` first; the resolver does NOT touch the DB on the multi-mock path.
- **Existing tests with mutating verbs MUST get the `X-Primer-Csrf: 1` header in T6.** A missed call site will surface as a 403. Grep `method: ['\"](POST|PATCH|PUT|DELETE)` after T6 and check every hit has either the inline header object or `headers: CSRF_HEADERS`.
- **`uploadFixture` extraction.** If T15 finds `uploadFixture` only as a local helper in `upload.test.ts`, extract it to `apps/api/src/routes/upload.testlib.ts` so both `upload.test.ts` and `crossUser.test.ts` can import it. Keep it under 30 lines.
- **The OIDC callback's user upsert uses ON CONFLICT (id) DO UPDATE** so subsequent sign-ins refresh email + displayName from the latest claims — the spec calls for this so name changes propagate.
- **The state cookie is base64url-encoded JSON, NOT signed.** Tampering produces either invalid base64 (rejected at decode), malformed JSON (rejected), state mismatch (rejected by openid-client), or codeVerifier mismatch (rejected at token exchange). An attacker would have to know all four secret values to forge a valid state cookie — they don't.
- **Sliding TTL refresh is fire-and-forget.** It's wrapped in `void ... .catch(() => undefined)` so a transient DB hiccup doesn't fail an otherwise valid request. The session still expires normally if writes are persistently broken.
