# Admin Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A read-only `/admin` page showing top-line Primer usage counts (users, documents, versions, threads, comments, document views) with last-7-day deltas, fetched from a new `GET /api/admin/stats` endpoint.

**Architecture:** One Hono endpoint runs twelve parallel Drizzle `count()` queries (one `total` + one `last7d` per metric) via `Promise.all`. A new React route renders the result in a 3×2 card grid using TanStack Query. No schema changes, no role check, no caching.

**Tech Stack:** Hono + Drizzle ORM (`count`, `gt`, `isNull`, `and`, `sql`), Vitest for backend tests, React 19 + TanStack Query 5 + Tailwind 4 on the frontend.

**Spec:** `docs/superpowers/specs/2026-05-21-primer-admin-dashboard-design.md`

---

## File map

**Backend (apps/api):**
- Create `apps/api/src/routes/admin.ts` — registers `GET /api/admin/stats`, runs the twelve counts, returns the `AdminStatsResponse` DTO.
- Create `apps/api/src/routes/admin.test.ts` — integration tests covering totals, soft-delete exclusions, and the 7-day window filter.
- Modify `apps/api/src/app.ts` — import and call `registerAdminRoute(app)` next to the other route registrations.

**Shared package (packages/shared):**
- Modify `packages/shared/src/api.ts` — add and export `AdminStatsResponse` and a small `AdminStatsBucket` interface.

**Frontend (apps/web):**
- Create `apps/web/src/queries/admin.ts` — `useAdminStats()` hook (mirrors `useDashboardQuery`).
- Create `apps/web/src/routes/admin.tsx` — admin page with stat-card grid, loading skeletons, error banner.
- Modify `apps/web/src/App.tsx` — register `/admin` route.

Each test in the API file uses the "snapshot delta" pattern: call the endpoint once for a baseline, insert known rows with controlled timestamps, call again, assert the delta. This keeps tests robust against the `mock-user-1` row that `beforeEach` (in `apps/api/src/testing/setup.ts`) preserves between tests.

---

## Task 1: Add the AdminStatsResponse DTO to the shared package

**Files:**
- Modify: `packages/shared/src/api.ts`

- [ ] **Step 1: Add the interfaces**

Open `packages/shared/src/api.ts` and append at the bottom of the file:

```ts
export interface AdminStatsBucket {
  total: number;
  last7d: number;
}

export interface AdminStatsResponse {
  users: AdminStatsBucket;
  documents: AdminStatsBucket;
  versions: AdminStatsBucket;
  threads: AdminStatsBucket;
  comments: AdminStatsBucket;
  documentViews: AdminStatsBucket;
}
```

- [ ] **Step 2: Run typecheck across the workspace**

Run: `pnpm -r typecheck`
Expected: all three projects (`packages/shared`, `apps/api`, `apps/web`) report `Done` with no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/api.ts
git commit -m "feat(shared): add AdminStatsResponse DTO"
```

---

## Task 2: Stub the admin route + wire it into the app

This task ships a minimal `/api/admin/stats` endpoint that returns all-zero counts. It exists so we can prove end-to-end wiring (auth middleware, JSON shape) before adding any DB code.

**Files:**
- Create: `apps/api/src/routes/admin.ts`
- Create: `apps/api/src/routes/admin.test.ts`
- Modify: `apps/api/src/app.ts`

- [ ] **Step 1: Write a failing wiring test**

Create `apps/api/src/routes/admin.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { db } from '../db/client.ts';
import { documents, versions, threads, comments, documentViews, users } from '@primer/shared/schema';
import type { AdminStatsResponse } from '@primer/shared';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-admin-test-'));
  try {
    const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function snapshot(app: ReturnType<typeof createApp>): Promise<AdminStatsResponse> {
  const res = await app.request('/api/admin/stats');
  expect(res.status).toBe(200);
  return (await res.json()) as AdminStatsResponse;
}

describe('GET /api/admin/stats', () => {
  it('returns the expected JSON shape', async () => {
    await withApp(async (app) => {
      const body = await snapshot(app);
      expect(body).toMatchObject({
        users:         { total: expect.any(Number), last7d: expect.any(Number) },
        documents:     { total: expect.any(Number), last7d: expect.any(Number) },
        versions:      { total: expect.any(Number), last7d: expect.any(Number) },
        threads:       { total: expect.any(Number), last7d: expect.any(Number) },
        comments:      { total: expect.any(Number), last7d: expect.any(Number) },
        documentViews: { total: expect.any(Number), last7d: expect.any(Number) },
      });
    });
  });
});
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter @primer/api test -- admin.test.ts`
Expected: FAIL — the request returns 404 because the route doesn't exist yet.

- [ ] **Step 3: Create the stub route file**

Create `apps/api/src/routes/admin.ts`:

```ts
import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import type { AdminStatsResponse } from '@primer/shared';

export function registerAdminRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/admin/stats', async (c) => {
    const body: AdminStatsResponse = {
      users:         { total: 0, last7d: 0 },
      documents:     { total: 0, last7d: 0 },
      versions:      { total: 0, last7d: 0 },
      threads:       { total: 0, last7d: 0 },
      comments:      { total: 0, last7d: 0 },
      documentViews: { total: 0, last7d: 0 },
    };
    return c.json(body, 200);
  });
}
```

- [ ] **Step 4: Wire the stub into `app.ts`**

Open `apps/api/src/app.ts`. Add the import next to the other route imports:

```ts
import { registerAdminRoute } from './routes/admin.ts';
```

Add the registration call next to the existing `registerDashboardRoute(app)` line (currently line 69):

```ts
  registerDashboardRoute(app);
  registerAdminRoute(app);
```

- [ ] **Step 5: Run the test, confirm it passes**

Run: `pnpm --filter @primer/api test -- admin.test.ts`
Expected: PASS — the shape test should now succeed.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin.ts apps/api/src/routes/admin.test.ts apps/api/src/app.ts
git commit -m "feat(api): stub /api/admin/stats endpoint"
```

---

## Task 3: Implement real `total` counts

This task replaces the hardcoded zeros with real Drizzle `count()` queries (no filters yet). We verify by seeding known rows and asserting that totals increase by the right amount.

**Files:**
- Modify: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/routes/admin.test.ts`

- [ ] **Step 1: Add the failing totals test**

Append a new `it()` block inside the existing `describe('GET /api/admin/stats', ...)` block in `apps/api/src/routes/admin.test.ts`:

```ts
  it('counts inserted rows in totals (delta from baseline)', async () => {
    await withApp(async (app) => {
      const before = await snapshot(app);

      const userId = `admin-test-user-${uuidv7()}`;
      const docId = uuidv7();
      const versionId = uuidv7();
      const threadId = uuidv7();
      const commentId = uuidv7();

      await db.insert(users).values({ id: userId, email: 'a@p.t', displayName: 'A' });
      await db.insert(documents).values({ id: docId, title: 'A', uploaderId: userId });
      await db.insert(versions).values({
        id: versionId, documentId: docId, versionNumber: 1,
        storageKey: `v1/${versionId}.html`, sizeBytes: 0, versionNote: null,
      });
      await db.insert(threads).values({
        id: threadId, versionId,
        anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      });
      await db.insert(comments).values({
        id: commentId, threadId, authorId: userId, body: 'hi',
      });
      await db.insert(documentViews).values({ userId, documentId: docId });

      const after = await snapshot(app);
      expect(after.users.total - before.users.total).toBe(1);
      expect(after.documents.total - before.documents.total).toBe(1);
      expect(after.versions.total - before.versions.total).toBe(1);
      expect(after.threads.total - before.threads.total).toBe(1);
      expect(after.comments.total - before.comments.total).toBe(1);
      expect(after.documentViews.total - before.documentViews.total).toBe(1);
    });
  });
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter @primer/api test -- admin.test.ts`
Expected: FAIL — the new test fails because every `after.X.total - before.X.total` is `0 - 0 = 0`, not `1`.

- [ ] **Step 3: Replace the stub with real count queries**

Rewrite `apps/api/src/routes/admin.ts` to use Drizzle counts:

```ts
import type { Hono } from 'hono';
import { count } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import type { AdminStatsResponse } from '@primer/shared';
import { db } from '../db/client.ts';
import { users, documents, versions, threads, comments, documentViews } from '@primer/shared/schema';

export function registerAdminRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/admin/stats', async (c) => {
    const [
      usersTotal,
      documentsTotal,
      versionsTotal,
      threadsTotal,
      commentsTotal,
      viewsTotal,
    ] = await Promise.all([
      db.select({ c: count() }).from(users),
      db.select({ c: count() }).from(documents),
      db.select({ c: count() }).from(versions),
      db.select({ c: count() }).from(threads),
      db.select({ c: count() }).from(comments),
      db.select({ c: count() }).from(documentViews),
    ]);

    const body: AdminStatsResponse = {
      users:         { total: usersTotal[0].c,     last7d: 0 },
      documents:     { total: documentsTotal[0].c, last7d: 0 },
      versions:      { total: versionsTotal[0].c,  last7d: 0 },
      threads:       { total: threadsTotal[0].c,   last7d: 0 },
      comments:      { total: commentsTotal[0].c,  last7d: 0 },
      documentViews: { total: viewsTotal[0].c,     last7d: 0 },
    };
    return c.json(body, 200);
  });
}
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `pnpm --filter @primer/api test -- admin.test.ts`
Expected: PASS — both `it()` blocks succeed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin.ts apps/api/src/routes/admin.test.ts
git commit -m "feat(api): admin stats — implement total counts"
```

---

## Task 4: Exclude soft-deleted documents and tombstoned comments from totals

The spec says `documents.total` skips rows with `deleted_at IS NOT NULL`, and `comments.total` skips rows with `deleted_at IS NOT NULL`. Same filters apply to those metrics' `last7d` buckets later.

**Files:**
- Modify: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/routes/admin.test.ts`

- [ ] **Step 1: Add the failing exclusion test**

Append another `it()` block inside the same `describe(...)` block:

```ts
  it('excludes soft-deleted documents and tombstoned comments from totals', async () => {
    await withApp(async (app) => {
      const before = await snapshot(app);

      const userId = `admin-test-user-${uuidv7()}`;
      const aliveDocId = uuidv7();
      const deletedDocId = uuidv7();
      const versionId = uuidv7();
      const threadId = uuidv7();
      const aliveCommentId = uuidv7();
      const tombstonedCommentId = uuidv7();
      const now = new Date();

      await db.insert(users).values({ id: userId, email: 'b@p.t', displayName: 'B' });
      await db.insert(documents).values({ id: aliveDocId, title: 'Alive', uploaderId: userId });
      await db.insert(documents).values({ id: deletedDocId, title: 'Gone', uploaderId: userId, deletedAt: now });
      await db.insert(versions).values({
        id: versionId, documentId: aliveDocId, versionNumber: 1,
        storageKey: `v1/${versionId}.html`, sizeBytes: 0, versionNote: null,
      });
      await db.insert(threads).values({
        id: threadId, versionId,
        anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      });
      await db.insert(comments).values({ id: aliveCommentId, threadId, authorId: userId, body: 'kept' });
      await db.insert(comments).values({ id: tombstonedCommentId, threadId, authorId: userId, body: 'gone', deletedAt: now });

      const after = await snapshot(app);
      expect(after.documents.total - before.documents.total).toBe(1);
      expect(after.comments.total - before.comments.total).toBe(1);
    });
  });
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter @primer/api test -- admin.test.ts`
Expected: FAIL — the new test fails with `Expected 1, received 2` for both `documents.total` and `comments.total`.

- [ ] **Step 3: Add the `isNull(deletedAt)` filter to docs and comments counts**

In `apps/api/src/routes/admin.ts`, change the import line to add `isNull`:

```ts
import { count, isNull } from 'drizzle-orm';
```

Change the `documents` and `comments` count queries inside `Promise.all` to filter on `deleted_at IS NULL`:

```ts
      db.select({ c: count() }).from(documents).where(isNull(documents.deletedAt)),
      ...
      db.select({ c: count() }).from(comments).where(isNull(comments.deletedAt)),
```

The full `Promise.all` block now reads:

```ts
    const [
      usersTotal,
      documentsTotal,
      versionsTotal,
      threadsTotal,
      commentsTotal,
      viewsTotal,
    ] = await Promise.all([
      db.select({ c: count() }).from(users),
      db.select({ c: count() }).from(documents).where(isNull(documents.deletedAt)),
      db.select({ c: count() }).from(versions),
      db.select({ c: count() }).from(threads),
      db.select({ c: count() }).from(comments).where(isNull(comments.deletedAt)),
      db.select({ c: count() }).from(documentViews),
    ]);
```

- [ ] **Step 4: Run the test, confirm it passes**

Run: `pnpm --filter @primer/api test -- admin.test.ts`
Expected: PASS — all three `it()` blocks succeed.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin.ts apps/api/src/routes/admin.test.ts
git commit -m "feat(api): admin stats — exclude soft-deleted rows from totals"
```

---

## Task 5: Add the `last7d` window for every metric

`last7d` counts rows with `created_at` (or `viewed_at` for `documentViews`) within the past 7 days, plus the same `deletedAt IS NULL` filters where they apply.

**Files:**
- Modify: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/routes/admin.test.ts`

- [ ] **Step 1: Add the failing 7-day test**

Append a final `it()` block inside the same `describe(...)` block:

```ts
  it('includes rows in last7d only when newer than 7 days; total counts both', async () => {
    await withApp(async (app) => {
      const before = await snapshot(app);

      const userId = `admin-test-user-${uuidv7()}`;
      await db.insert(users).values({ id: userId, email: 'c@p.t', displayName: 'C' });

      const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000); // 10 days ago
      const oldDocId = uuidv7();
      const newDocId = uuidv7();
      await db.insert(documents).values({ id: oldDocId, title: 'Old', uploaderId: userId, createdAt: oldDate });
      await db.insert(documents).values({ id: newDocId, title: 'New', uploaderId: userId });

      const oldVersionId = uuidv7();
      const newVersionId = uuidv7();
      await db.insert(versions).values({
        id: oldVersionId, documentId: newDocId, versionNumber: 1,
        storageKey: `v1/${oldVersionId}.html`, sizeBytes: 0, versionNote: null,
        createdAt: oldDate,
      });
      await db.insert(versions).values({
        id: newVersionId, documentId: newDocId, versionNumber: 2,
        storageKey: `v1/${newVersionId}.html`, sizeBytes: 0, versionNote: null,
      });

      const oldThreadId = uuidv7();
      const newThreadId = uuidv7();
      await db.insert(threads).values({
        id: oldThreadId, versionId: newVersionId,
        anchor: { type: 'text-range', selectorText: 'a', prefix: '', suffix: '', containerPath: 'body' },
        createdAt: oldDate,
      });
      await db.insert(threads).values({
        id: newThreadId, versionId: newVersionId,
        anchor: { type: 'text-range', selectorText: 'b', prefix: '', suffix: '', containerPath: 'body' },
      });

      await db.insert(comments).values({
        id: uuidv7(), threadId: newThreadId, authorId: userId, body: 'old', createdAt: oldDate,
      });
      await db.insert(comments).values({
        id: uuidv7(), threadId: newThreadId, authorId: userId, body: 'new',
      });

      await db.insert(documentViews).values({
        userId, documentId: oldDocId, viewedAt: oldDate,
      });
      // Same (userId, newDocId) pair as primary key — only one row per pair, so this is the "new" view.
      await db.insert(documentViews).values({ userId, documentId: newDocId });

      const after = await snapshot(app);

      // Totals see both rows.
      expect(after.documents.total - before.documents.total).toBe(2);
      expect(after.versions.total - before.versions.total).toBe(2);
      expect(after.threads.total - before.threads.total).toBe(2);
      expect(after.comments.total - before.comments.total).toBe(2);
      expect(after.documentViews.total - before.documentViews.total).toBe(2);

      // last7d sees only the new one.
      expect(after.documents.last7d - before.documents.last7d).toBe(1);
      expect(after.versions.last7d - before.versions.last7d).toBe(1);
      expect(after.threads.last7d - before.threads.last7d).toBe(1);
      expect(after.comments.last7d - before.comments.last7d).toBe(1);
      expect(after.documentViews.last7d - before.documentViews.last7d).toBe(1);

      // users.last7d should also see the newly inserted (default-timestamped) user.
      expect(after.users.last7d - before.users.last7d).toBe(1);
    });
  });
```

- [ ] **Step 2: Run the test, confirm it fails**

Run: `pnpm --filter @primer/api test -- admin.test.ts`
Expected: FAIL — every `last7d` delta is `0` because `last7d` is still hardcoded to `0` in the route.

- [ ] **Step 3: Add the six `last7d` count queries**

Open `apps/api/src/routes/admin.ts` and replace the entire file with this complete implementation:

```ts
import type { Hono } from 'hono';
import { count, isNull, gt, and, sql } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import type { AdminStatsResponse } from '@primer/shared';
import { db } from '../db/client.ts';
import { users, documents, versions, threads, comments, documentViews } from '@primer/shared/schema';

export function registerAdminRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/admin/stats', async (c) => {
    const since = sql<Date>`now() - interval '7 days'`;

    const [
      usersTotal,
      usersLast,
      documentsTotal,
      documentsLast,
      versionsTotal,
      versionsLast,
      threadsTotal,
      threadsLast,
      commentsTotal,
      commentsLast,
      viewsTotal,
      viewsLast,
    ] = await Promise.all([
      db.select({ c: count() }).from(users),
      db.select({ c: count() }).from(users).where(gt(users.createdAt, since)),

      db.select({ c: count() }).from(documents).where(isNull(documents.deletedAt)),
      db.select({ c: count() }).from(documents)
        .where(and(isNull(documents.deletedAt), gt(documents.createdAt, since))),

      db.select({ c: count() }).from(versions),
      db.select({ c: count() }).from(versions).where(gt(versions.createdAt, since)),

      db.select({ c: count() }).from(threads),
      db.select({ c: count() }).from(threads).where(gt(threads.createdAt, since)),

      db.select({ c: count() }).from(comments).where(isNull(comments.deletedAt)),
      db.select({ c: count() }).from(comments)
        .where(and(isNull(comments.deletedAt), gt(comments.createdAt, since))),

      db.select({ c: count() }).from(documentViews),
      db.select({ c: count() }).from(documentViews).where(gt(documentViews.viewedAt, since)),
    ]);

    const body: AdminStatsResponse = {
      users:         { total: usersTotal[0].c,     last7d: usersLast[0].c },
      documents:     { total: documentsTotal[0].c, last7d: documentsLast[0].c },
      versions:      { total: versionsTotal[0].c,  last7d: versionsLast[0].c },
      threads:       { total: threadsTotal[0].c,   last7d: threadsLast[0].c },
      comments:      { total: commentsTotal[0].c,  last7d: commentsLast[0].c },
      documentViews: { total: viewsTotal[0].c,     last7d: viewsLast[0].c },
    };
    return c.json(body, 200);
  });
}
```

- [ ] **Step 4: Run the full admin test file**

Run: `pnpm --filter @primer/api test -- admin.test.ts`
Expected: PASS — all four `it()` blocks succeed.

- [ ] **Step 5: Run the entire API test suite to make sure nothing else regressed**

Run: `pnpm --filter @primer/api test`
Expected: all test files pass (was 29 files / 198 tests before this plan).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/admin.ts apps/api/src/routes/admin.test.ts
git commit -m "feat(api): admin stats — add last7d deltas for every metric"
```

---

## Task 6: Frontend query hook

**Files:**
- Create: `apps/web/src/queries/admin.ts`

- [ ] **Step 1: Write the hook**

Create `apps/web/src/queries/admin.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import type { AdminStatsResponse } from '@primer/shared';
import { api } from '../lib/fetch.ts';

export function useAdminStats() {
  return useQuery({
    queryKey: ['admin', 'stats'],
    queryFn: async ({ signal }): Promise<AdminStatsResponse> => {
      const res = await api('/api/admin/stats', { signal });
      if (!res.ok) throw new Error(`admin stats fetch failed: ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });
}
```

- [ ] **Step 2: Run web typecheck**

Run: `pnpm --filter @primer/web typecheck`
Expected: `Done` with no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/queries/admin.ts
git commit -m "feat(web): useAdminStats query hook"
```

---

## Task 7: Admin page

**Files:**
- Create: `apps/web/src/routes/admin.tsx`

- [ ] **Step 1: Write the page**

Create `apps/web/src/routes/admin.tsx`:

```tsx
import { useAdminStats } from '../queries/admin.ts';
import type { AdminStatsBucket, AdminStatsResponse } from '@primer/shared';

interface StatCardProps {
  label: string;
  bucket: AdminStatsBucket;
}

function StatCard({ label, bucket }: StatCardProps) {
  const deltaClass = bucket.last7d > 0 ? 'text-neutral-500' : 'text-neutral-400';
  return (
    <div className="rounded border border-neutral-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wider text-neutral-600">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-neutral-900">
        {bucket.total.toLocaleString()}
      </div>
      <div className={`mt-1 text-xs ${deltaClass}`}>
        +{bucket.last7d.toLocaleString()} this week
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded border border-neutral-200 bg-white p-4">
      <div className="h-3 w-20 rounded bg-neutral-200" />
      <div className="mt-2 h-8 w-16 rounded bg-neutral-200" />
      <div className="mt-2 h-3 w-24 rounded bg-neutral-200" />
    </div>
  );
}

const METRICS: { key: keyof AdminStatsResponse; label: string }[] = [
  { key: 'users',         label: 'Users' },
  { key: 'documents',     label: 'Documents' },
  { key: 'versions',      label: 'Versions' },
  { key: 'threads',       label: 'Threads' },
  { key: 'comments',      label: 'Comments' },
  { key: 'documentViews', label: 'Document views' },
];

export function AdminPage() {
  const q = useAdminStats();

  return (
    <div className="max-w-3xl space-y-4">
      <header className="border-b border-neutral-200 pb-3">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="text-sm text-neutral-600">
          Top-line Primer usage. Read-only.
        </p>
      </header>

      {q.error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          Couldn't load stats — {(q.error as Error).message}.{' '}
          <button
            type="button"
            onClick={() => q.refetch()}
            className="underline hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {q.isLoading || !q.data
          ? METRICS.map((m) => <SkeletonCard key={m.key} />)
          : METRICS.map((m) => (
              <StatCard key={m.key} label={m.label} bucket={q.data[m.key]} />
            ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Run web typecheck**

Run: `pnpm --filter @primer/web typecheck`
Expected: `Done` with no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/admin.tsx
git commit -m "feat(web): admin stats page"
```

---

## Task 8: Wire `/admin` route + smoke test + final verification

**Files:**
- Modify: `apps/web/src/App.tsx`

- [ ] **Step 1: Register the route**

Open `apps/web/src/App.tsx`. Add the import next to the other route imports:

```tsx
import { AdminPage } from './routes/admin.tsx';
```

Add a route entry inside the `children: [...]` array, after the existing `/dev/harness` entry and before the catch-all `*`:

```tsx
      { path: '/admin', element: <AdminPage /> },
```

The resulting router config block should look like:

```tsx
const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: '/', element: <HomePage /> },
      { path: '/upload', element: <UploadPage /> },
      { path: '/d/:docId', element: <DocumentPage /> },
      { path: '/d/:docId/v/:versionNumber', element: <DocumentPage /> },
      { path: '/dev/harness', element: <DevHarnessPage /> },
      { path: '/admin', element: <AdminPage /> },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
```

- [ ] **Step 2: Workspace typecheck**

Run: `pnpm -r typecheck`
Expected: all three projects report `Done`.

- [ ] **Step 3: Full workspace test run**

Run: `pnpm -r test --run`
Expected: all suites pass (was 29 files / 198 tests; the admin file adds 4 more tests so expect ~30 files / ~202 tests).

- [ ] **Step 4: Workspace build**

Run: `pnpm -r build`
Expected: api build emits `dist/index.js` etc.; web build emits `dist/index.html` + assets. No errors.

- [ ] **Step 5: Manual smoke test in the dev environment**

Start the dev environment (whatever the developer normally uses — e.g., `pnpm dev` in the repo root if the project has a dev script, or otherwise the per-app dev scripts). Once both API and web are running and you're signed in:

1. Navigate to `/admin` directly in the browser.
2. Expect: header reads "Admin", followed by a 3×2 grid of six cards (Users, Documents, Versions, Threads, Comments, Document views).
3. Each card shows a number and a "+N this week" line.
4. Open DevTools Network tab and confirm `GET /api/admin/stats` returns 200 with the expected JSON shape.
5. Click the AppShell logo to return home — confirm the standard Primer home page renders normally (no regression).

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/App.tsx
git commit -m "feat(web): wire /admin route"
```

The branch is now ready for the user's explicit greenlight before any `git push`.

---

## Self-review notes (for the implementer)

Spec coverage checklist — every spec requirement is mapped to a task:

| Spec section                              | Task(s)         |
|-------------------------------------------|-----------------|
| `GET /api/admin/stats` endpoint           | Task 2, 3, 5    |
| Six metrics, each with `total` + `last7d` | Task 3, 5       |
| Drizzle `count()` + `Promise.all`         | Task 3, 5       |
| Soft-delete + tombstone exclusions        | Task 4          |
| 7-day window via `now() - interval '7 days'` + `viewed_at` for views | Task 5 |
| `AdminStatsResponse` DTO in `api.ts`      | Task 1          |
| `useAdminStats` TanStack Query hook       | Task 6          |
| `/admin` SPA route inside `AppShell`      | Task 7, 8       |
| 3×2 card grid, label / total / delta      | Task 7          |
| Loading skeletons + error banner          | Task 7          |
| No nav link (hidden URL)                  | Task 8 (asserted by absence) |
| Auth via inherited `authMiddleware`       | Task 2 (asserted indirectly — test goes through the full app) |
| Manual frontend testing                   | Task 8          |

Type consistency: `AdminStatsResponse` (Task 1) and `AdminStatsBucket` (Task 1) are used identically across the backend (Tasks 2/3/5) and frontend (Tasks 6/7). Property keys match: `users / documents / versions / threads / comments / documentViews`.
