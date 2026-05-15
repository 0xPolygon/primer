# Primer Sub-Project 3 (Comments + Threading + Dashboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the SP2 anchoring substrate to real DB-backed comment threads, ship a 360px-collapsible-to-36px sidebar UI, replace the home placeholder with a real "My documents" + "Recently viewed" dashboard, and lay a `Notifier` interface that SP6 will swap for Slack dispatch.

**Architecture:** New `document_views` table for activity tracking; eight REST endpoints (six CRUD + one polling target with ETag/304 + one dashboard aggregation); typed `Notifier` interface with `NoopNotifier` default; TanStack Query polling at 10s with manual ETag preservation; React sidebar with compact thread cards and an inline composer driven by the existing SP2 selection/pick protocol.

**Tech Stack:** TypeScript 6 + Hono 4 (Node 24) + Drizzle 0.45 + postgres.js + Vitest 4 on the API; React 19 + Vite 8 + TanStack Query 5 + Tailwind 4 on the web side.

**Companion spec:** `docs/superpowers/specs/2026-05-16-primer-comments-threading-design.md`

---

## Pre-flight assumptions

- Working directory: `/home/taylan/development/polygon/primer`
- Start from `master`. The first task creates a feature branch `feat/comments-threading`.
- Postgres is up (`pnpm db:up` if not). `.env` exists at repo root.
- pnpm 11.1.0 at `~/.local/bin/pnpm`, Node 24 in the Nix store. **Every Bash command begins with:**
  ```bash
  export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
  ```
- SSH-key git signing works without prompting. Commit normally (no `--no-gpg-sign`).
- All work commits on `feat/comments-threading`. Final squash-merge to master is the last task.

---

## File map

```
packages/shared/src/
  schema.ts                            # MOD — add documentViews + typed threads.anchor
  api.ts                               # MOD — Thread/Comment/Dashboard DTOs
  companion-protocol.ts                # MOD — export isTextRangeAnchor + isElementPathAnchor

apps/api/src/
  notifications/
    notifier.ts                        # NEW — Notifier interface + NoopNotifier
    notifier.test.ts                   # NEW
  routes/
    threads.ts                         # NEW
    threads.test.ts                    # NEW
    comments.ts                        # NEW
    comments.test.ts                   # NEW
    dashboard.ts                       # NEW
    dashboard.test.ts                  # NEW
    documents.ts                       # MOD — view-tracking upsert side-effect
    documents.test.ts                  # MOD — assert upsert
  app.ts                               # MOD — register routes, inject notifier
  index.ts                             # MOD — instantiate NoopNotifier
  drizzle/000X_document_views.sql      # NEW — generated migration

apps/web/src/
  queries/
    threads.ts                         # NEW — useThreadsQuery (polled, conditional)
    mutations.ts                       # NEW — useCreateThread, useReply, useResolveThread,
                                       #        useReopenThread, useEditComment, useDeleteComment
    dashboard.ts                       # NEW — useDashboardQuery
  components/
    NewThreadComposer.tsx              # NEW
    ThreadCard.tsx                     # NEW
    CommentSidebar.tsx                 # NEW
    DocumentListRow.tsx                # NEW
  routes/
    document.tsx                       # MOD — drop SP2 ephemeral state, mount sidebar
    home.tsx                           # MOD — replace placeholder with real lists
```

---

## Phase A — Shared types + schema

### Task 1: Create feature branch + add `document_views` table + migration

**Files:**
- Modify: `packages/shared/src/schema.ts`
- Create: `apps/api/drizzle/000X_*.sql` (generated)

- [ ] **Step 1: Create the feature branch**

```bash
cd /home/taylan/development/polygon/primer
git status   # confirm clean
git checkout -b feat/comments-threading
git log --oneline -3
```

- [ ] **Step 2: Append the new table to the schema**

Append to `packages/shared/src/schema.ts` (keep existing exports intact). Add `primaryKey` to the existing `drizzle-orm/pg-core` import line, then append the table at the bottom of the file:

```ts
// Update the import on the existing line:
import {
  pgTable,
  text,
  uuid,
  timestamp,
  integer,
  jsonb,
  bigint,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core';

// Append at the bottom of the file:
export const documentViews = pgTable(
  'document_views',
  {
    userId: text('user_id').notNull().references(() => users.id),
    documentId: uuid('document_id')
      .notNull()
      .references(() => documents.id, { onDelete: 'cascade' }),
    viewedAt: timestamp('viewed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.documentId] }),
  })
);
```

- [ ] **Step 3: Generate the migration**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer/apps/api
pnpm db:generate
ls drizzle/
```

Expected: a new migration file (e.g., `drizzle/0002_<adjective>_<noun>.sql`) appears with a `CREATE TABLE document_views (...)` statement and the composite PK. Open the generated file and confirm it has:

```sql
CREATE TABLE IF NOT EXISTS "document_views" (
  "user_id" text NOT NULL,
  "document_id" uuid NOT NULL,
  "viewed_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "document_views_user_id_document_id_pk" PRIMARY KEY("user_id","document_id")
);
```

(Foreign keys may be emitted as separate `ALTER TABLE` statements — that's fine.)

- [ ] **Step 4: Apply to both databases**

```bash
cd /home/taylan/development/polygon/primer
pnpm db:migrate
pnpm db:migrate:test
```

Expected: both print "Migrations applied."

- [ ] **Step 5: Verify with psql**

```bash
docker compose exec postgres psql -U primer -d primer -c "\d document_views"
docker compose exec postgres psql -U primer -d primer_test -c "\d document_views"
```

Expected: table exists in both, composite PK shown.

- [ ] **Step 6: Commit**

```bash
cd /home/taylan/development/polygon/primer
git add packages/shared/src/schema.ts apps/api/drizzle/
git status
git commit -m "feat(shared): document_views table for activity tracking"
git log --oneline -3
```

---

### Task 2: Refine `threads.anchor` type, export type guards, add API DTOs

**Files:**
- Modify: `packages/shared/src/schema.ts`
- Modify: `packages/shared/src/companion-protocol.ts`
- Modify: `packages/shared/src/api.ts`

- [ ] **Step 1: Refine `threads.anchor` typing (no SQL change)**

In `packages/shared/src/schema.ts`, change the `threads.anchor` definition:

```ts
// At the top, add this import:
import type { AnchorData } from './companion-protocol.ts';
```

Then locate the `threads` table definition and change ONLY this one line:

```ts
// BEFORE
anchor: jsonb('anchor').notNull(),

// AFTER
anchor: jsonb('anchor').$type<AnchorData>().notNull(),
```

Leave every other field on `threads` untouched. This is a TS-only refinement; no SQL migration needed.

- [ ] **Step 2: Export the existing type guards**

In `packages/shared/src/companion-protocol.ts`, the file already defines `isTextRangeAnchor` and `isElementPathAnchor` as local functions used by `parseInboundMessage`. Add `export` to each:

```ts
// BEFORE
function isTextRangeAnchor(v: unknown): v is TextRangeAnchor {

// AFTER
export function isTextRangeAnchor(v: unknown): v is TextRangeAnchor {
```

```ts
// BEFORE
function isElementPathAnchor(v: unknown): v is ElementPathAnchor {

// AFTER
export function isElementPathAnchor(v: unknown): v is ElementPathAnchor {
```

- [ ] **Step 3: Add DTOs to `api.ts`**

Append to `packages/shared/src/api.ts`:

```ts
import type { AnchorData } from './companion-protocol.ts';

export interface CommentDTO {
  id: string;
  threadId: string;
  authorId: string;
  authorDisplayName: string;
  body: string;             // empty string when deletedAt is set (tombstone)
  createdAt: string;
  updatedAt: string | null;
  deletedAt: string | null;
  mentions: string[];       // always [] in SP3
}

export interface ThreadDTO {
  id: string;
  versionId: string;
  anchor: AnchorData;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolvedByDisplayName: string | null;
  createdAt: string;
  comments: CommentDTO[];
}

export interface ThreadsListResponse {
  threads: ThreadDTO[];
  asOf: string;
}

export interface CreateThreadRequest {
  anchor: AnchorData;
  body: string;
}

export interface CommentBodyRequest {
  body: string;
}

export interface DashboardDocumentSummary {
  id: string;
  title: string;
  description: string | null;
  uploaderDisplayName: string;
  threadCount: number;
  activeThreadCount: number;
  lastActivityAt: string;
}

export interface DashboardActivityEntry extends DashboardDocumentSummary {
  signal: 'viewed' | 'commented';
  signalAt: string;
}

export interface DashboardResponse {
  myDocuments: DashboardDocumentSummary[];
  recentlyViewedOrCommented: DashboardActivityEntry[];
}
```

- [ ] **Step 4: Typecheck**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/shared typecheck
pnpm --filter @primer/api typecheck
pnpm --filter @primer/web typecheck
```

Expected: all three clean.

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src
git commit -m "feat(shared): typed threads.anchor + comment/thread/dashboard DTOs"
git log --oneline -3
```

---

## Phase B — Notifier interface

### Task 3: `Notifier` interface + `NoopNotifier` (TDD)

**Files:**
- Create: `apps/api/src/notifications/notifier.ts`
- Create: `apps/api/src/notifications/notifier.test.ts`

- [ ] **Step 1: Write the failing test**

File: `apps/api/src/notifications/notifier.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { NoopNotifier } from './notifier.ts';

describe('NoopNotifier', () => {
  it('notifyMentions resolves without throwing', async () => {
    const n = new NoopNotifier();
    await expect(
      n.notifyMentions({
        mentions: ['user-2'],
        threadId: 'thread-1',
        commentId: 'comment-1',
        actorUserId: 'mock-user-1',
      })
    ).resolves.toBeUndefined();
  });

  it('notifyReplyParticipants resolves without throwing', async () => {
    const n = new NoopNotifier();
    await expect(
      n.notifyReplyParticipants({
        participantUserIds: ['user-2', 'user-3'],
        threadId: 'thread-1',
        commentId: 'comment-1',
        actorUserId: 'mock-user-1',
      })
    ).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — verify fail**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test notifier
```

Expected: module not found.

- [ ] **Step 3: Implement**

File: `apps/api/src/notifications/notifier.ts`

```ts
import { logger } from '../logger.ts';

export interface NotifyMentionsArgs {
  mentions: string[];
  threadId: string;
  commentId: string;
  actorUserId: string;
}

export interface NotifyReplyParticipantsArgs {
  participantUserIds: string[];
  threadId: string;
  commentId: string;
  actorUserId: string;
}

export interface Notifier {
  notifyMentions(args: NotifyMentionsArgs): Promise<void>;
  notifyReplyParticipants(args: NotifyReplyParticipantsArgs): Promise<void>;
}

export class NoopNotifier implements Notifier {
  async notifyMentions(args: NotifyMentionsArgs): Promise<void> {
    logger.debug({ args }, 'notifyMentions (no-op)');
  }
  async notifyReplyParticipants(args: NotifyReplyParticipantsArgs): Promise<void> {
    logger.debug({ args }, 'notifyReplyParticipants (no-op)');
  }
}
```

- [ ] **Step 4: Verify pass**

```bash
pnpm --filter @primer/api test notifier
pnpm --filter @primer/api typecheck
```

Expected: 2 passing; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/notifications
git commit -m "feat(api): Notifier interface + NoopNotifier default"
```

---

## Phase C — Thread + comment API routes

### Task 4: `GET /api/versions/:vid/threads` happy path (TDD)

**Files:**
- Create: `apps/api/src/routes/threads.ts`
- Create: `apps/api/src/routes/threads.test.ts`
- Modify: `apps/api/src/app.ts` (register route + add notifier to AppDeps)

This task scaffolds the threads route AND extends `createApp` to take a `Notifier`. Subsequent tasks add ETag handling, more endpoints, etc.

- [ ] **Step 1: Failing test**

File: `apps/api/src/routes/threads.test.ts`

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
import { documents, versions, threads, comments } from '@primer/shared/schema';
import type { ThreadsListResponse } from '@primer/shared';

async function seedDocument() {
  const documentId = uuidv7();
  const versionId = uuidv7();
  await db.insert(documents).values({
    id: documentId,
    title: 'Seed Doc',
    description: null,
    uploaderId: 'mock-user-1',
  });
  await db.insert(versions).values({
    id: versionId,
    documentId,
    versionNumber: 1,
    storageKey: `v1/${versionId}.html`,
    sizeBytes: 0,
    versionNote: null,
  });
  return { documentId, versionId };
}

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-threads-test-'));
  try {
    const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('GET /api/versions/:versionId/threads — happy path', () => {
  it('returns empty list with 200 when no threads exist', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ThreadsListResponse;
      expect(body.threads).toEqual([]);
      expect(typeof body.asOf).toBe('string');
      expect(res.headers.get('etag')).toBeTruthy();
    });
  });

  it('returns existing threads + comments inlined', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const threadId = uuidv7();
      const commentId = uuidv7();
      await db.insert(threads).values({
        id: threadId,
        versionId,
        anchor: { type: 'text-range', selectorText: 't', prefix: '', suffix: '', containerPath: 'body' },
      });
      await db.insert(comments).values({
        id: commentId,
        threadId,
        authorId: 'mock-user-1',
        body: 'first comment',
        mentions: [],
      });

      const res = await app.request(`/api/versions/${versionId}/threads`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ThreadsListResponse;
      expect(body.threads).toHaveLength(1);
      expect(body.threads[0].id).toBe(threadId);
      expect(body.threads[0].comments).toHaveLength(1);
      expect(body.threads[0].comments[0].body).toBe('first comment');
      expect(body.threads[0].comments[0].authorDisplayName).toBe('Mock User');
    });
  });
});
```

- [ ] **Step 2: Watch fail**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test threads
```

Expected: fails because `createApp` doesn't take `notifier` and `routes/threads.ts` doesn't exist.

- [ ] **Step 3: Extend `AppDeps` and `createApp` to accept a `Notifier`**

Modify `apps/api/src/app.ts`. Find the existing `AppDeps` interface and add `notifier: Notifier`:

```ts
// Update imports
import type { Notifier } from './notifications/notifier.ts';

// Update interface
export interface AppDeps {
  storage: Storage;
  notifier: Notifier;
}
```

The `createApp` signature stays the same (it already accepts `AppDeps`). The new field is now available via `deps.notifier`.

- [ ] **Step 4: Implement the GET endpoint**

File: `apps/api/src/routes/threads.ts`

```ts
import type { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, AppDeps } from '../app.ts';
import type { CommentDTO, ThreadDTO, ThreadsListResponse } from '@primer/shared';
import { threads, comments, users } from '@primer/shared/schema';
import { db } from '../db/client.ts';

interface ThreadRow {
  id: string;
  versionId: string;
  anchor: unknown;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolvedByDisplayName: string | null;
  createdAt: Date;
}

interface CommentRow {
  id: string;
  threadId: string;
  authorId: string;
  authorDisplayName: string;
  body: string;
  mentions: string[];
  createdAt: Date;
  updatedAt: Date | null;
  deletedAt: Date | null;
}

function commentToDTO(row: CommentRow): CommentDTO {
  const isTombstoned = row.deletedAt !== null;
  return {
    id: row.id,
    threadId: row.threadId,
    authorId: row.authorId,
    authorDisplayName: row.authorDisplayName,
    body: isTombstoned ? '' : row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    mentions: row.mentions,
  };
}

function threadToDTO(row: ThreadRow, threadComments: CommentRow[]): ThreadDTO {
  return {
    id: row.id,
    versionId: row.versionId,
    anchor: row.anchor as ThreadDTO['anchor'],
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    resolvedByDisplayName: row.resolvedByDisplayName,
    createdAt: row.createdAt.toISOString(),
    comments: threadComments.map(commentToDTO),
  };
}

export function registerThreadRoutes(
  app: Hono<{ Variables: AppVariables }>,
  _deps: AppDeps
): void {
  app.get('/api/versions/:versionId/threads', async (c) => {
    const versionId = c.req.param('versionId');

    const threadRows = (await db
      .select({
        id: threads.id,
        versionId: threads.versionId,
        anchor: threads.anchor,
        resolvedAt: threads.resolvedAt,
        resolvedBy: threads.resolvedBy,
        resolvedByDisplayName: users.displayName,
        createdAt: threads.createdAt,
      })
      .from(threads)
      .leftJoin(users, eq(users.id, threads.resolvedBy))
      .where(eq(threads.versionId, versionId))
      .orderBy(threads.createdAt)) as ThreadRow[];

    const commentRows =
      threadRows.length === 0
        ? []
        : ((await db
            .select({
              id: comments.id,
              threadId: comments.threadId,
              authorId: comments.authorId,
              authorDisplayName: users.displayName,
              body: comments.body,
              mentions: comments.mentions,
              createdAt: comments.createdAt,
              updatedAt: comments.updatedAt,
              deletedAt: comments.deletedAt,
            })
            .from(comments)
            .innerJoin(users, eq(users.id, comments.authorId))
            .where(
              sql`${comments.threadId} IN (${sql.join(
                threadRows.map((t) => sql`${t.id}`),
                sql`, `
              )})`
            )
            .orderBy(comments.createdAt)) as CommentRow[]);

    const commentsByThread = new Map<string, CommentRow[]>();
    for (const c of commentRows) {
      const list = commentsByThread.get(c.threadId);
      if (list) list.push(c);
      else commentsByThread.set(c.threadId, [c]);
    }

    const body: ThreadsListResponse = {
      threads: threadRows.map((t) => threadToDTO(t, commentsByThread.get(t.id) ?? [])),
      asOf: new Date().toISOString(),
    };

    // ETag computation is added in Task 5. For now, set a no-cache marker so the test passes.
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        etag: 'W/"placeholder"',
      },
    });
  });
}
```

- [ ] **Step 5: Register the route in `app.ts`**

In `apps/api/src/app.ts`, add the import and registration. Inside `createApp`, after `registerCompanionRoute(app)`:

```ts
import { registerThreadRoutes } from './routes/threads.ts';

// inside createApp, after the existing route registrations and before any conditional dev route:
registerThreadRoutes(app, deps);
```

- [ ] **Step 6: Update `index.ts` to instantiate `NoopNotifier`**

In `apps/api/src/index.ts`, modify the `createApp` call to include the notifier:

```ts
import { NoopNotifier } from './notifications/notifier.ts';

// existing code …
const storage = new FilesystemStorage(storageRoot);
const notifier = new NoopNotifier();
const app = createApp({ storage, notifier });
```

- [ ] **Step 7: Update existing tests that call `createApp`**

The existing tests in `apps/api/src/routes/upload.test.ts`, `upload.compensate.test.ts`, `documents.test.ts`, `versionContent.test.ts`, `companion.test.ts`, `devFixture.test.ts`, `mockUser.test.ts` (if it calls createApp) all need to pass `notifier`. Use a single helper if helpful, otherwise add `notifier: new NoopNotifier()` to every `createApp({ ... })` invocation in test files.

Search and update:

```bash
cd /home/taylan/development/polygon/primer
grep -rn "createApp({" apps/api/src --include="*.test.ts"
```

For each line found, update from:

```ts
createApp({ storage: new FilesystemStorage(root) })
// or
createApp({ storage })
```

To:

```ts
createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() })
// or
createApp({ storage, notifier: new NoopNotifier() })
```

Add the `NoopNotifier` import at the top of each test file. The `mockUser.test.ts` file constructs its own `Hono` instance directly without `createApp`, so it should NOT need changes — verify by reading it.

- [ ] **Step 8: Run all tests**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

Expected: 2 new threads tests pass, all existing tests still pass, typecheck clean. Total approx 47.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): GET /api/versions/:vid/threads happy path + Notifier injection"
git log --oneline -3
```

---

### Task 5: ETag + 304 on the threads list endpoint (TDD)

**Files:**
- Modify: `apps/api/src/routes/threads.ts`
- Modify: `apps/api/src/routes/threads.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `apps/api/src/routes/threads.test.ts`:

```ts
describe('GET /api/versions/:versionId/threads — ETag/304', () => {
  it('returns 304 when If-None-Match matches the current ETag', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      // First call: get the ETag.
      const r1 = await app.request(`/api/versions/${versionId}/threads`);
      expect(r1.status).toBe(200);
      const etag = r1.headers.get('etag');
      expect(etag).toBeTruthy();

      // Second call with If-None-Match → 304 + same ETag, empty body.
      const r2 = await app.request(`/api/versions/${versionId}/threads`, {
        headers: { 'if-none-match': etag! },
      });
      expect(r2.status).toBe(304);
      expect(r2.headers.get('etag')).toBe(etag);
    });
  });

  it('returns a fresh ETag and 200 after any thread/comment change', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const r1 = await app.request(`/api/versions/${versionId}/threads`);
      const etag1 = r1.headers.get('etag');

      // Insert a thread + comment manually to simulate a change.
      const threadId = uuidv7();
      await db.insert(threads).values({
        id: threadId,
        versionId,
        anchor: { type: 'text-range', selectorText: 't', prefix: '', suffix: '', containerPath: 'body' },
      });
      await db.insert(comments).values({
        id: uuidv7(),
        threadId,
        authorId: 'mock-user-1',
        body: 'fresh',
        mentions: [],
      });

      const r2 = await app.request(`/api/versions/${versionId}/threads`, {
        headers: { 'if-none-match': etag1! },
      });
      expect(r2.status).toBe(200);
      const etag2 = r2.headers.get('etag');
      expect(etag2).toBeTruthy();
      expect(etag2).not.toBe(etag1);
    });
  });
});
```

- [ ] **Step 2: Watch fail**

```bash
pnpm --filter @primer/api test threads
```

Expected: 2 new tests fail (current handler always returns 200 with placeholder ETag).

- [ ] **Step 3: Implement real ETag computation**

Update the handler in `apps/api/src/routes/threads.ts`. Add a helper function near the top of the file (after the type aliases but before `registerThreadRoutes`):

```ts
import { createHash } from 'node:crypto';

async function computeVersionEtag(versionId: string): Promise<string> {
  const result = await db.execute(sql`
    SELECT
      COALESCE(GREATEST(
        MAX(t.created_at), MAX(t.resolved_at),
        MAX(c.created_at), MAX(c.updated_at), MAX(c.deleted_at)
      ), 'epoch'::timestamptz) AS max_ts,
      COUNT(DISTINCT t.id)::int AS thread_count,
      COUNT(c.id)::int AS comment_count
    FROM threads t
    LEFT JOIN comments c ON c.thread_id = t.id
    WHERE t.version_id = ${versionId}
  `);
  // postgres.js result row shape varies by driver — fields are lowercased.
  const row = (result as unknown as { max_ts: string | Date; thread_count: number; comment_count: number }[])[0];
  const maxTsIso = row.max_ts instanceof Date ? row.max_ts.toISOString() : new Date(row.max_ts).toISOString();
  const hash = createHash('sha256')
    .update(`${maxTsIso}|${row.thread_count}|${row.comment_count}`)
    .digest('hex')
    .slice(0, 16);
  return `W/"${hash}"`;
}
```

Then update the handler:

```ts
app.get('/api/versions/:versionId/threads', async (c) => {
  const versionId = c.req.param('versionId');

  const currentEtag = await computeVersionEtag(versionId);
  const ifNoneMatch = c.req.header('if-none-match');
  if (ifNoneMatch && ifNoneMatch === currentEtag) {
    return new Response(null, {
      status: 304,
      headers: { etag: currentEtag },
    });
  }

  const threadRows = /* ... same query as before ... */;
  const commentRows = /* ... same query as before ... */;
  /* ... same assembly ... */

  const body: ThreadsListResponse = {
    threads: threadRows.map((t) => threadToDTO(t, commentsByThread.get(t.id) ?? [])),
    asOf: new Date().toISOString(),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      etag: currentEtag,
    },
  });
});
```

Keep the existing imports and the rest of the file structure.

- [ ] **Step 4: Run all tests**

```bash
pnpm --filter @primer/api test threads
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

Expected: 4/4 threads tests pass, full suite still green, typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/threads.ts apps/api/src/routes/threads.test.ts
git commit -m "feat(api): ETag/304 conditional polling on threads list endpoint"
```

---

### Task 6: `POST /api/versions/:vid/threads` (create thread + first comment) (TDD)

**Files:**
- Modify: `apps/api/src/routes/threads.ts`
- Modify: `apps/api/src/routes/threads.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `apps/api/src/routes/threads.test.ts`:

```ts
import type { ThreadDTO, CreateThreadRequest } from '@primer/shared';

describe('POST /api/versions/:versionId/threads', () => {
  it('creates a thread + first comment in one transaction', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const body: CreateThreadRequest = {
        anchor: {
          type: 'text-range',
          selectorText: 'churn jumped',
          prefix: 'see how ',
          suffix: ' last week',
          containerPath: 'body > p:nth-of-type(2)',
        },
        body: 'is this the same metric as before?',
      };
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(201);
      const thread = (await res.json()) as ThreadDTO;
      expect(thread.id).toBeTruthy();
      expect(thread.versionId).toBe(versionId);
      expect(thread.anchor).toEqual(body.anchor);
      expect(thread.comments).toHaveLength(1);
      expect(thread.comments[0].body).toBe(body.body);
      expect(thread.comments[0].authorId).toBe('mock-user-1');
      expect(thread.comments[0].mentions).toEqual([]);

      // Verify rows landed.
      const threadCount = await db.select().from(threads).where(eq(threads.id, thread.id));
      expect(threadCount).toHaveLength(1);
      const commentCount = await db.select().from(comments).where(eq(comments.threadId, thread.id));
      expect(commentCount).toHaveLength(1);
    });
  });

  it('rejects invalid_body for empty body', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: {
            type: 'text-range',
            selectorText: 't',
            prefix: '',
            suffix: '',
            containerPath: 'body',
          },
          body: '   ',
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('invalid_body');
    });
  });

  it('rejects invalid_body for body over 5000 chars', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: {
            type: 'text-range',
            selectorText: 't',
            prefix: '',
            suffix: '',
            containerPath: 'body',
          },
          body: 'x'.repeat(5001),
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    });
  });

  it('rejects invalid_anchor for malformed anchor', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const res = await app.request(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          anchor: { type: 'text-range', selectorText: 'x' /* missing fields */ },
          body: 'hi',
        }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_anchor');
    });
  });
});
```

- [ ] **Step 2: Watch fail**

```bash
pnpm --filter @primer/api test threads
```

Expected: 4 new tests fail (POST not handled).

- [ ] **Step 3: Implement POST**

In `apps/api/src/routes/threads.ts`, add the import for the type guards and `uuidv7`, plus a body-validation helper:

```ts
// Add to imports
import { v7 as uuidv7 } from 'uuid';
import { isTextRangeAnchor, isElementPathAnchor } from '@primer/shared';
import type { CreateThreadRequest } from '@primer/shared';

// Helper near the top of registerThreadRoutes file (before registerThreadRoutes):
const MAX_BODY = 5000;

function validateBody(raw: unknown): { ok: true; body: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BODY) return { ok: false };
  return { ok: true, body: trimmed };
}

function validateAnchor(raw: unknown): boolean {
  return isTextRangeAnchor(raw) || isElementPathAnchor(raw);
}
```

Then add the POST handler inside `registerThreadRoutes`:

```ts
  app.post('/api/versions/:versionId/threads', async (c) => {
    const versionId = c.req.param('versionId');
    let payload: Partial<CreateThreadRequest>;
    try {
      payload = (await c.req.json()) as Partial<CreateThreadRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }

    if (!validateAnchor(payload.anchor)) {
      return c.json({ error: 'invalid_anchor', message: 'Anchor must be a TextRangeAnchor or ElementPathAnchor.' }, 400);
    }

    const bodyValidation = validateBody(payload.body);
    if (!bodyValidation.ok) {
      return c.json({ error: 'invalid_body', message: `Body must be 1–${MAX_BODY} chars after trim.` }, 400);
    }

    const threadId = uuidv7();
    const commentId = uuidv7();
    const user = c.get('user');

    await db.transaction(async (tx) => {
      await tx.insert(threads).values({
        id: threadId,
        versionId,
        anchor: payload.anchor,
      });
      await tx.insert(comments).values({
        id: commentId,
        threadId,
        authorId: user.id,
        body: bodyValidation.body,
        mentions: [],
      });
    });

    await _deps.notifier.notifyMentions({
      mentions: [],
      threadId,
      commentId,
      actorUserId: user.id,
    });

    // Re-read the inserted rows to build the DTO with author display name.
    const [insertedThread] = (await db
      .select({
        id: threads.id,
        versionId: threads.versionId,
        anchor: threads.anchor,
        resolvedAt: threads.resolvedAt,
        resolvedBy: threads.resolvedBy,
        resolvedByDisplayName: users.displayName,
        createdAt: threads.createdAt,
      })
      .from(threads)
      .leftJoin(users, eq(users.id, threads.resolvedBy))
      .where(eq(threads.id, threadId))) as ThreadRow[];

    const insertedComments = (await db
      .select({
        id: comments.id,
        threadId: comments.threadId,
        authorId: comments.authorId,
        authorDisplayName: users.displayName,
        body: comments.body,
        mentions: comments.mentions,
        createdAt: comments.createdAt,
        updatedAt: comments.updatedAt,
        deletedAt: comments.deletedAt,
      })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.threadId, threadId))
      .orderBy(comments.createdAt)) as CommentRow[];

    return c.json(threadToDTO(insertedThread, insertedComments), 201);
  });
```

The handler references `_deps.notifier` — rename the `_deps` parameter on `registerThreadRoutes` to `deps` so it can be used (or use `deps` directly). Update the signature:

```ts
export function registerThreadRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
  // ... use deps.notifier
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @primer/api test threads
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

Expected: 4 new tests pass; all suite green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/threads.ts apps/api/src/routes/threads.test.ts
git commit -m "feat(api): POST /api/versions/:vid/threads creates thread + first comment"
```

---

### Task 7: `POST /api/threads/:tid/resolve` + `POST /api/threads/:tid/reopen` (TDD)

**Files:**
- Modify: `apps/api/src/routes/threads.ts`
- Modify: `apps/api/src/routes/threads.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `apps/api/src/routes/threads.test.ts`:

```ts
async function seedThread(versionId: string) {
  const threadId = uuidv7();
  await db.insert(threads).values({
    id: threadId,
    versionId,
    anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
  });
  await db.insert(comments).values({
    id: uuidv7(),
    threadId,
    authorId: 'mock-user-1',
    body: 'seed',
    mentions: [],
  });
  return threadId;
}

describe('POST /api/threads/:tid/resolve', () => {
  it('sets resolvedAt + resolvedBy and is idempotent', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const threadId = await seedThread(versionId);
      const r1 = await app.request(`/api/threads/${threadId}/resolve`, { method: 'POST' });
      expect(r1.status).toBe(200);
      const t1 = (await r1.json()) as ThreadDTO;
      expect(t1.resolvedAt).not.toBeNull();
      expect(t1.resolvedBy).toBe('mock-user-1');
      expect(t1.resolvedByDisplayName).toBe('Mock User');

      // Idempotent — re-stamps.
      const r2 = await app.request(`/api/threads/${threadId}/resolve`, { method: 'POST' });
      expect(r2.status).toBe(200);
      const t2 = (await r2.json()) as ThreadDTO;
      expect(t2.resolvedAt).not.toBeNull();
    });
  });
});

describe('POST /api/threads/:tid/reopen', () => {
  it('clears resolvedAt + resolvedBy and is idempotent', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocument();
      const threadId = await seedThread(versionId);
      await app.request(`/api/threads/${threadId}/resolve`, { method: 'POST' });

      const r1 = await app.request(`/api/threads/${threadId}/reopen`, { method: 'POST' });
      expect(r1.status).toBe(200);
      const t1 = (await r1.json()) as ThreadDTO;
      expect(t1.resolvedAt).toBeNull();
      expect(t1.resolvedBy).toBeNull();

      // Idempotent.
      const r2 = await app.request(`/api/threads/${threadId}/reopen`, { method: 'POST' });
      expect(r2.status).toBe(200);
      expect(((await r2.json()) as ThreadDTO).resolvedAt).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Watch fail**

```bash
pnpm --filter @primer/api test threads
```

Expected: new tests 404 (route not registered).

- [ ] **Step 3: Implement**

In `apps/api/src/routes/threads.ts`, add a small helper and the two handlers (inside `registerThreadRoutes`):

```ts
async function loadThreadDTO(threadId: string): Promise<ThreadDTO | null> {
  const [row] = (await db
    .select({
      id: threads.id,
      versionId: threads.versionId,
      anchor: threads.anchor,
      resolvedAt: threads.resolvedAt,
      resolvedBy: threads.resolvedBy,
      resolvedByDisplayName: users.displayName,
      createdAt: threads.createdAt,
    })
    .from(threads)
    .leftJoin(users, eq(users.id, threads.resolvedBy))
    .where(eq(threads.id, threadId))) as ThreadRow[];
  if (!row) return null;

  const commentRows = (await db
    .select({
      id: comments.id,
      threadId: comments.threadId,
      authorId: comments.authorId,
      authorDisplayName: users.displayName,
      body: comments.body,
      mentions: comments.mentions,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      deletedAt: comments.deletedAt,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(eq(comments.threadId, threadId))
    .orderBy(comments.createdAt)) as CommentRow[];

  return threadToDTO(row, commentRows);
}
```

Move `loadThreadDTO` to be defined ONCE in the file (e.g., near `threadToDTO`). Then in `registerThreadRoutes`:

```ts
  app.post('/api/threads/:threadId/resolve', async (c) => {
    const threadId = c.req.param('threadId');
    const user = c.get('user');
    await db
      .update(threads)
      .set({ resolvedAt: new Date(), resolvedBy: user.id })
      .where(eq(threads.id, threadId));
    const dto = await loadThreadDTO(threadId);
    if (!dto) return c.json({ error: 'not_found' }, 404);
    return c.json(dto, 200);
  });

  app.post('/api/threads/:threadId/reopen', async (c) => {
    const threadId = c.req.param('threadId');
    await db
      .update(threads)
      .set({ resolvedAt: null, resolvedBy: null })
      .where(eq(threads.id, threadId));
    const dto = await loadThreadDTO(threadId);
    if (!dto) return c.json({ error: 'not_found' }, 404);
    return c.json(dto, 200);
  });
```

Refactor `loadThreadDTO` into the create-thread response path too — replace the manual re-read with `return c.json((await loadThreadDTO(threadId))!, 201);` to avoid duplicating the query.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @primer/api test threads
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

Expected: 2 new tests pass; full suite green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/threads.ts apps/api/src/routes/threads.test.ts
git commit -m "feat(api): thread resolve + reopen endpoints (idempotent)"
```

---

### Task 8: `POST /api/threads/:tid/comments` reply + auto-reopen (TDD)

**Files:**
- Create: `apps/api/src/routes/comments.ts`
- Create: `apps/api/src/routes/comments.test.ts`
- Modify: `apps/api/src/app.ts` (register comments routes)

- [ ] **Step 1: Failing tests**

File: `apps/api/src/routes/comments.test.ts`

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
import { db } from '../db/client.ts';
import { documents, versions, threads, comments } from '@primer/shared/schema';
import type { CommentDTO, ThreadDTO } from '@primer/shared';

async function seedDocVersionThread() {
  const documentId = uuidv7();
  const versionId = uuidv7();
  const threadId = uuidv7();
  await db.insert(documents).values({
    id: documentId,
    title: 'Seed',
    description: null,
    uploaderId: 'mock-user-1',
  });
  await db.insert(versions).values({
    id: versionId,
    documentId,
    versionNumber: 1,
    storageKey: `v1/${versionId}.html`,
    sizeBytes: 0,
    versionNote: null,
  });
  await db.insert(threads).values({
    id: threadId,
    versionId,
    anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
  });
  await db.insert(comments).values({
    id: uuidv7(),
    threadId,
    authorId: 'mock-user-1',
    body: 'first',
    mentions: [],
  });
  return { documentId, versionId, threadId };
}

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-comments-test-'));
  try {
    const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('POST /api/threads/:tid/comments — reply', () => {
  it('appends a comment to an existing thread', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const res = await app.request(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'a reply' }),
      });
      expect(res.status).toBe(201);
      const out = (await res.json()) as { comment: CommentDTO; thread: ThreadDTO };
      expect(out.comment.body).toBe('a reply');
      expect(out.thread.comments).toHaveLength(2);
      expect(out.thread.resolvedAt).toBeNull();
    });
  });

  it('auto-reopens a resolved thread on reply', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      // Resolve the thread.
      await db
        .update(threads)
        .set({ resolvedAt: new Date(), resolvedBy: 'mock-user-1' })
        .where(eq(threads.id, threadId));

      const res = await app.request(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'I have more thoughts' }),
      });
      expect(res.status).toBe(201);
      const out = (await res.json()) as { comment: CommentDTO; thread: ThreadDTO };
      expect(out.thread.resolvedAt).toBeNull();
      expect(out.thread.resolvedBy).toBeNull();
      expect(out.thread.comments).toHaveLength(2);
    });
  });

  it('rejects empty body', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const res = await app.request(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: '  ' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_body');
    });
  });
});
```

- [ ] **Step 2: Watch fail**

```bash
pnpm --filter @primer/api test comments
```

Expected: tests 404 (route not registered).

- [ ] **Step 3: Implement the reply endpoint**

File: `apps/api/src/routes/comments.ts`

```ts
import type { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { eq } from 'drizzle-orm';
import type { AppVariables, AppDeps } from '../app.ts';
import type { CommentBodyRequest, CommentDTO, ThreadDTO } from '@primer/shared';
import { threads, comments, users } from '@primer/shared/schema';
import { db } from '../db/client.ts';

const MAX_BODY = 5000;

function validateBody(raw: unknown): { ok: true; body: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BODY) return { ok: false };
  return { ok: true, body: trimmed };
}

interface ThreadRow {
  id: string;
  versionId: string;
  anchor: unknown;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolvedByDisplayName: string | null;
  createdAt: Date;
}

interface CommentRow {
  id: string;
  threadId: string;
  authorId: string;
  authorDisplayName: string;
  body: string;
  mentions: string[];
  createdAt: Date;
  updatedAt: Date | null;
  deletedAt: Date | null;
}

function commentToDTO(row: CommentRow): CommentDTO {
  const isTombstoned = row.deletedAt !== null;
  return {
    id: row.id,
    threadId: row.threadId,
    authorId: row.authorId,
    authorDisplayName: row.authorDisplayName,
    body: isTombstoned ? '' : row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    mentions: row.mentions,
  };
}

async function loadThreadDTO(threadId: string): Promise<ThreadDTO | null> {
  const [row] = (await db
    .select({
      id: threads.id,
      versionId: threads.versionId,
      anchor: threads.anchor,
      resolvedAt: threads.resolvedAt,
      resolvedBy: threads.resolvedBy,
      resolvedByDisplayName: users.displayName,
      createdAt: threads.createdAt,
    })
    .from(threads)
    .leftJoin(users, eq(users.id, threads.resolvedBy))
    .where(eq(threads.id, threadId))) as ThreadRow[];
  if (!row) return null;

  const commentRows = (await db
    .select({
      id: comments.id,
      threadId: comments.threadId,
      authorId: comments.authorId,
      authorDisplayName: users.displayName,
      body: comments.body,
      mentions: comments.mentions,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      deletedAt: comments.deletedAt,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(eq(comments.threadId, threadId))
    .orderBy(comments.createdAt)) as CommentRow[];

  return {
    id: row.id,
    versionId: row.versionId,
    anchor: row.anchor as ThreadDTO['anchor'],
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    resolvedByDisplayName: row.resolvedByDisplayName,
    createdAt: row.createdAt.toISOString(),
    comments: commentRows.map(commentToDTO),
  };
}

export function registerCommentRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
  app.post('/api/threads/:threadId/comments', async (c) => {
    const threadId = c.req.param('threadId');
    let payload: Partial<CommentBodyRequest>;
    try {
      payload = (await c.req.json()) as Partial<CommentBodyRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    const validation = validateBody(payload.body);
    if (!validation.ok) {
      return c.json({ error: 'invalid_body', message: `Body must be 1–${MAX_BODY} chars after trim.` }, 400);
    }

    const commentId = uuidv7();
    const user = c.get('user');

    // Snapshot prior comment authors for the reply-participant notification.
    const priorAuthors = (await db
      .select({ authorId: comments.authorId })
      .from(comments)
      .where(eq(comments.threadId, threadId))) as { authorId: string }[];
    const participantUserIds = Array.from(
      new Set(priorAuthors.map((r) => r.authorId).filter((id) => id !== user.id))
    );

    await db.transaction(async (tx) => {
      await tx.insert(comments).values({
        id: commentId,
        threadId,
        authorId: user.id,
        body: validation.body,
        mentions: [],
      });
      // Auto-reopen if resolved.
      await tx
        .update(threads)
        .set({ resolvedAt: null, resolvedBy: null })
        .where(eq(threads.id, threadId));
    });

    await deps.notifier.notifyReplyParticipants({
      participantUserIds,
      threadId,
      commentId,
      actorUserId: user.id,
    });
    await deps.notifier.notifyMentions({
      mentions: [],
      threadId,
      commentId,
      actorUserId: user.id,
    });

    const dto = await loadThreadDTO(threadId);
    if (!dto) return c.json({ error: 'not_found' }, 404);
    const newComment = dto.comments.find((c) => c.id === commentId)!;
    return c.json({ comment: newComment, thread: dto }, 201);
  });
}
```

- [ ] **Step 4: Register in `app.ts`**

In `apps/api/src/app.ts`, add:

```ts
import { registerCommentRoutes } from './routes/comments.ts';

// inside createApp, after registerThreadRoutes(app, deps):
registerCommentRoutes(app, deps);
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @primer/api test comments
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

Expected: 3 new tests pass; full suite green; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): reply endpoint with auto-reopen on resolved threads"
```

---

### Task 9: `PATCH /api/comments/:cid` + `DELETE /api/comments/:cid` (TDD)

**Files:**
- Modify: `apps/api/src/routes/comments.ts`
- Modify: `apps/api/src/routes/comments.test.ts`

- [ ] **Step 1: Append failing tests**

Append to `apps/api/src/routes/comments.test.ts`:

```ts
describe('PATCH /api/comments/:cid', () => {
  it('updates body and sets updatedAt when called by author', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const firstCommentId = (await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.threadId, threadId)))[0].id;

      const res = await app.request(`/api/comments/${firstCommentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'edited body' }),
      });
      expect(res.status).toBe(200);
      const c = (await res.json()) as CommentDTO;
      expect(c.body).toBe('edited body');
      expect(c.updatedAt).not.toBeNull();
    });
  });

  it('returns 403 when called by non-author', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      // Insert a comment owned by a different user.
      const otherUserId = 'other-user-test';
      await db.insert(users).values({ id: otherUserId, email: 'o@p.t', displayName: 'Other' });
      const otherCommentId = uuidv7();
      await db.insert(comments).values({
        id: otherCommentId,
        threadId,
        authorId: otherUserId,
        body: 'theirs',
        mentions: [],
      });

      const res = await app.request(`/api/comments/${otherCommentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'sneaky edit' }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('returns 409 when patching a tombstoned comment', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const firstCommentId = (await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.threadId, threadId)))[0].id;
      await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, firstCommentId));

      const res = await app.request(`/api/comments/${firstCommentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'too late' }),
      });
      expect(res.status).toBe(409);
    });
  });
});

describe('DELETE /api/comments/:cid', () => {
  it('soft-deletes by author and returns tombstone', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const firstCommentId = (await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.threadId, threadId)))[0].id;
      const res = await app.request(`/api/comments/${firstCommentId}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      const c = (await res.json()) as CommentDTO;
      expect(c.body).toBe('');
      expect(c.deletedAt).not.toBeNull();

      // Row still exists.
      const stillThere = await db.select().from(comments).where(eq(comments.id, firstCommentId));
      expect(stillThere).toHaveLength(1);
      expect(stillThere[0].body).toBe('first'); // raw body preserved in DB
    });
  });

  it('returns 403 when called by non-author', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const otherUserId = 'other-user-test-2';
      await db.insert(users).values({ id: otherUserId, email: 'o2@p.t', displayName: 'Other2' });
      const otherCommentId = uuidv7();
      await db.insert(comments).values({
        id: otherCommentId,
        threadId,
        authorId: otherUserId,
        body: 'theirs',
        mentions: [],
      });
      const res = await app.request(`/api/comments/${otherCommentId}`, { method: 'DELETE' });
      expect(res.status).toBe(403);
    });
  });

  it('is idempotent on already-tombstoned comment', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const firstCommentId = (await db
        .select({ id: comments.id })
        .from(comments)
        .where(eq(comments.threadId, threadId)))[0].id;
      await app.request(`/api/comments/${firstCommentId}`, { method: 'DELETE' });
      const res = await app.request(`/api/comments/${firstCommentId}`, { method: 'DELETE' });
      expect(res.status).toBe(200);
      expect(((await res.json()) as CommentDTO).deletedAt).not.toBeNull();
    });
  });
});
```

Add the `users` import to the test file imports:

```ts
import { documents, versions, threads, comments, users } from '@primer/shared/schema';
```

- [ ] **Step 2: Watch fail**

```bash
pnpm --filter @primer/api test comments
```

Expected: 6 new tests fail.

- [ ] **Step 3: Implement PATCH + DELETE**

In `apps/api/src/routes/comments.ts`, append to `registerCommentRoutes`:

```ts
  app.patch('/api/comments/:commentId', async (c) => {
    const commentId = c.req.param('commentId');
    let payload: Partial<CommentBodyRequest>;
    try {
      payload = (await c.req.json()) as Partial<CommentBodyRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    const validation = validateBody(payload.body);
    if (!validation.ok) {
      return c.json({ error: 'invalid_body', message: `Body must be 1–${MAX_BODY} chars after trim.` }, 400);
    }
    const user = c.get('user');

    const [existing] = await db.select().from(comments).where(eq(comments.id, commentId));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.authorId !== user.id) return c.json({ error: 'forbidden' }, 403);
    if (existing.deletedAt !== null) return c.json({ error: 'conflict' }, 409);

    await db
      .update(comments)
      .set({ body: validation.body, updatedAt: new Date() })
      .where(eq(comments.id, commentId));

    await deps.notifier.notifyMentions({
      mentions: [],
      threadId: existing.threadId,
      commentId,
      actorUserId: user.id,
    });

    const [row] = (await db
      .select({
        id: comments.id,
        threadId: comments.threadId,
        authorId: comments.authorId,
        authorDisplayName: users.displayName,
        body: comments.body,
        mentions: comments.mentions,
        createdAt: comments.createdAt,
        updatedAt: comments.updatedAt,
        deletedAt: comments.deletedAt,
      })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.id, commentId))) as CommentRow[];
    return c.json(commentToDTO(row), 200);
  });

  app.delete('/api/comments/:commentId', async (c) => {
    const commentId = c.req.param('commentId');
    const user = c.get('user');
    const [existing] = await db.select().from(comments).where(eq(comments.id, commentId));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.authorId !== user.id) return c.json({ error: 'forbidden' }, 403);
    if (existing.deletedAt === null) {
      await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, commentId));
    }
    const [row] = (await db
      .select({
        id: comments.id,
        threadId: comments.threadId,
        authorId: comments.authorId,
        authorDisplayName: users.displayName,
        body: comments.body,
        mentions: comments.mentions,
        createdAt: comments.createdAt,
        updatedAt: comments.updatedAt,
        deletedAt: comments.deletedAt,
      })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.id, commentId))) as CommentRow[];
    return c.json(commentToDTO(row), 200);
  });
```

Add `users` to the imports in `comments.ts`:

```ts
import { threads, comments, users } from '@primer/shared/schema';
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

Expected: full suite green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): comment edit (PATCH) + delete (soft, tombstone) with author-only auth"
```

---

## Phase D — Documents view-tracking + dashboard

### Task 10: Document view-tracking upsert (TDD)

**Files:**
- Modify: `apps/api/src/routes/documents.ts`
- Modify: `apps/api/src/routes/documents.test.ts`

- [ ] **Step 1: Append failing test**

Append to `apps/api/src/routes/documents.test.ts`:

```ts
import { documentViews } from '@primer/shared/schema';

describe('GET /api/documents/:docId — view tracking', () => {
  it('upserts document_views on every hit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-docview-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);
      // First hit creates the view row.
      const r1 = await app.request(`/api/documents/${upload.documentId}`);
      expect(r1.status).toBe(200);
      const rows1 = await db
        .select()
        .from(documentViews)
        .where(eq(documentViews.documentId, upload.documentId));
      expect(rows1).toHaveLength(1);
      const firstViewedAt = rows1[0].viewedAt;

      // Wait a bit so the next viewedAt is provably later.
      await new Promise((r) => setTimeout(r, 50));
      const r2 = await app.request(`/api/documents/${upload.documentId}`);
      expect(r2.status).toBe(200);
      const rows2 = await db
        .select()
        .from(documentViews)
        .where(eq(documentViews.documentId, upload.documentId));
      expect(rows2).toHaveLength(1); // still only one row
      expect(rows2[0].viewedAt.getTime()).toBeGreaterThan(firstViewedAt.getTime());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

The `uploadFixture` helper already exists in `documents.test.ts`. Update the existing imports at the top to include `NoopNotifier`:

```ts
import { NoopNotifier } from '../notifications/notifier.ts';
```

And `documentViews`:

```ts
import { documentViews } from '@primer/shared/schema';
```

- [ ] **Step 2: Watch fail**

```bash
pnpm --filter @primer/api test documents
```

Expected: new test fails (view row count is 0 because nothing inserts).

- [ ] **Step 3: Add view-tracking upsert to the documents route**

In `apps/api/src/routes/documents.ts`, find the existing `app.get('/api/documents/:docId', …)` handler. Just before the `c.json(body, 200)` return (after the document + version data is assembled successfully), add:

```ts
import { sql } from 'drizzle-orm';

// inside the handler, just before returning c.json(body, 200):
try {
  await db.execute(sql`
    INSERT INTO document_views (user_id, document_id)
    VALUES (${c.get('user').id}, ${docId})
    ON CONFLICT (user_id, document_id) DO UPDATE SET viewed_at = excluded.viewed_at
  `);
} catch (err) {
  logger.warn({ err, docId, userId: c.get('user').id }, 'failed to upsert document_views');
}
```

Add the `logger` import to `documents.ts`:

```ts
import { logger } from '../logger.ts';
```

- [ ] **Step 4: Run all tests**

```bash
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

Expected: full suite green; typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/documents.ts apps/api/src/routes/documents.test.ts
git commit -m "feat(api): upsert document_views on GET /api/documents/:docId"
```

---

### Task 11: `GET /api/dashboard` (TDD)

**Files:**
- Create: `apps/api/src/routes/dashboard.ts`
- Create: `apps/api/src/routes/dashboard.test.ts`
- Modify: `apps/api/src/app.ts` (register dashboard route)

- [ ] **Step 1: Failing tests**

File: `apps/api/src/routes/dashboard.test.ts`

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
import { db } from '../db/client.ts';
import { documents, versions, threads, comments, documentViews, users } from '@primer/shared/schema';
import type { DashboardResponse } from '@primer/shared';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-dashboard-test-'));
  try {
    const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedDoc(uploaderId: string, title: string) {
  const documentId = uuidv7();
  const versionId = uuidv7();
  await db.insert(documents).values({
    id: documentId,
    title,
    description: null,
    uploaderId,
  });
  await db.insert(versions).values({
    id: versionId,
    documentId,
    versionNumber: 1,
    storageKey: `v1/${versionId}.html`,
    sizeBytes: 0,
    versionNote: null,
  });
  return { documentId, versionId };
}

describe('GET /api/dashboard', () => {
  it('returns empty lists when nothing exists', async () => {
    await withApp(async (app) => {
      const res = await app.request('/api/dashboard');
      expect(res.status).toBe(200);
      const body = (await res.json()) as DashboardResponse;
      expect(body.myDocuments).toEqual([]);
      expect(body.recentlyViewedOrCommented).toEqual([]);
    });
  });

  it('lists my documents ordered by activity', async () => {
    await withApp(async (app) => {
      const a = await seedDoc('mock-user-1', 'A doc');
      const b = await seedDoc('mock-user-1', 'B doc');
      // Add a thread on B to make it most-recent activity.
      await db.insert(threads).values({
        id: uuidv7(),
        versionId: b.versionId,
        anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      });

      const res = await app.request('/api/dashboard');
      const body = (await res.json()) as DashboardResponse;
      expect(body.myDocuments).toHaveLength(2);
      expect(body.myDocuments[0].id).toBe(b.documentId); // most recent activity first
      expect(body.myDocuments[1].id).toBe(a.documentId);
      expect(body.myDocuments[0].threadCount).toBe(1);
      expect(body.myDocuments[0].activeThreadCount).toBe(1);
    });
  });

  it('lists another user\'s viewed doc in recentlyViewedOrCommented with viewed signal', async () => {
    await withApp(async (app) => {
      // Seed a doc owned by a different user.
      const otherUserId = 'other-user-dash';
      await db.insert(users).values({ id: otherUserId, email: 'o@p.t', displayName: 'Other' });
      const o = await seedDoc(otherUserId, 'Other Doc');
      // Insert a view row for mock-user-1 on it.
      await db.insert(documentViews).values({
        userId: 'mock-user-1',
        documentId: o.documentId,
      });

      const res = await app.request('/api/dashboard');
      const body = (await res.json()) as DashboardResponse;
      expect(body.recentlyViewedOrCommented).toHaveLength(1);
      expect(body.recentlyViewedOrCommented[0].id).toBe(o.documentId);
      expect(body.recentlyViewedOrCommented[0].signal).toBe('viewed');
    });
  });

  it('lists docs the user commented on with commented signal', async () => {
    await withApp(async (app) => {
      const otherUserId = 'other-user-dash2';
      await db.insert(users).values({ id: otherUserId, email: 'o2@p.t', displayName: 'Other2' });
      const o = await seedDoc(otherUserId, 'Their Doc');
      // Add a thread + comment by mock-user-1.
      const threadId = uuidv7();
      await db.insert(threads).values({
        id: threadId,
        versionId: o.versionId,
        anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      });
      await db.insert(comments).values({
        id: uuidv7(),
        threadId,
        authorId: 'mock-user-1',
        body: 'my reply on their doc',
        mentions: [],
      });

      const res = await app.request('/api/dashboard');
      const body = (await res.json()) as DashboardResponse;
      const entry = body.recentlyViewedOrCommented.find((e) => e.id === o.documentId);
      expect(entry).toBeDefined();
      expect(entry!.signal).toBe('commented');
    });
  });

  it('takes the most recent signal when both viewed and commented exist', async () => {
    await withApp(async (app) => {
      const otherUserId = 'other-user-dash3';
      await db.insert(users).values({ id: otherUserId, email: 'o3@p.t', displayName: 'Other3' });
      const o = await seedDoc(otherUserId, 'Both signals');
      // Old view, recent comment.
      await db.insert(documentViews).values({
        userId: 'mock-user-1',
        documentId: o.documentId,
        viewedAt: new Date(Date.now() - 60_000),
      });
      const threadId = uuidv7();
      await db.insert(threads).values({
        id: threadId,
        versionId: o.versionId,
        anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      });
      await db.insert(comments).values({
        id: uuidv7(),
        threadId,
        authorId: 'mock-user-1',
        body: 'newer',
        mentions: [],
      });

      const res = await app.request('/api/dashboard');
      const body = (await res.json()) as DashboardResponse;
      const entry = body.recentlyViewedOrCommented.find((e) => e.id === o.documentId);
      expect(entry!.signal).toBe('commented');
    });
  });
});
```

- [ ] **Step 2: Watch fail**

```bash
pnpm --filter @primer/api test dashboard
```

Expected: tests 404 (route not registered).

- [ ] **Step 3: Implement the dashboard route**

File: `apps/api/src/routes/dashboard.ts`

```ts
import type { Hono } from 'hono';
import { sql, eq, and, isNull, desc } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import type {
  DashboardResponse,
  DashboardDocumentSummary,
  DashboardActivityEntry,
} from '@primer/shared';
import { documents, versions, threads, comments, documentViews, users } from '@primer/shared/schema';
import { db } from '../db/client.ts';

interface MyDocRow {
  id: string;
  title: string;
  description: string | null;
  uploaderDisplayName: string;
  threadCount: number;
  activeThreadCount: number;
  lastActivityAt: Date;
}

interface ActivityRow extends MyDocRow {
  signal: 'viewed' | 'commented';
  signalAt: Date;
}

export function registerDashboardRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/dashboard', async (c) => {
    const userId = c.get('user').id;

    // ── My documents ───────────────────────────────────────────
    const myDocsResult = (await db.execute(sql`
      WITH version_threads AS (
        SELECT v.document_id, t.id AS thread_id, t.resolved_at,
               GREATEST(t.created_at, COALESCE(t.resolved_at, t.created_at)) AS thread_activity
        FROM versions v
        LEFT JOIN threads t ON t.version_id = v.id
      ),
      version_comments AS (
        SELECT v.document_id,
               GREATEST(c.created_at,
                        COALESCE(c.updated_at, c.created_at),
                        COALESCE(c.deleted_at, c.created_at)) AS comment_activity
        FROM versions v
        LEFT JOIN threads t ON t.version_id = v.id
        LEFT JOIN comments c ON c.thread_id = t.id
      )
      SELECT
        d.id,
        d.title,
        d.description,
        u.display_name AS "uploaderDisplayName",
        COUNT(DISTINCT vt.thread_id) FILTER (WHERE vt.thread_id IS NOT NULL)::int AS "threadCount",
        COUNT(DISTINCT vt.thread_id) FILTER (WHERE vt.thread_id IS NOT NULL AND vt.resolved_at IS NULL)::int AS "activeThreadCount",
        GREATEST(
          d.created_at,
          COALESCE(MAX(vt.thread_activity), d.created_at),
          COALESCE(MAX(vc.comment_activity), d.created_at)
        ) AS "lastActivityAt"
      FROM documents d
      INNER JOIN users u ON u.id = d.uploader_id
      LEFT JOIN version_threads vt ON vt.document_id = d.id
      LEFT JOIN version_comments vc ON vc.document_id = d.id
      WHERE d.uploader_id = ${userId} AND d.deleted_at IS NULL
      GROUP BY d.id, d.title, d.description, u.display_name, d.created_at
      ORDER BY "lastActivityAt" DESC
    `)) as unknown as MyDocRow[];

    // ── Recently viewed or commented ───────────────────────────
    const activityResult = (await db.execute(sql`
      WITH viewed AS (
        SELECT dv.document_id, dv.viewed_at AS signal_at, 'viewed'::text AS signal
        FROM document_views dv
        WHERE dv.user_id = ${userId}
          AND dv.viewed_at > now() - interval '30 days'
      ),
      commented AS (
        SELECT v.document_id, MAX(c.created_at) AS signal_at, 'commented'::text AS signal
        FROM comments c
        INNER JOIN threads t ON t.id = c.thread_id
        INNER JOIN versions v ON v.id = t.version_id
        WHERE c.author_id = ${userId}
          AND c.created_at > now() - interval '30 days'
        GROUP BY v.document_id
      ),
      unioned AS (
        SELECT document_id, signal_at, signal FROM viewed
        UNION ALL
        SELECT document_id, signal_at, signal FROM commented
      ),
      latest AS (
        SELECT document_id,
               MAX(signal_at) AS signal_at,
               (ARRAY_AGG(signal ORDER BY signal_at DESC))[1] AS signal
        FROM unioned
        GROUP BY document_id
      )
      SELECT
        d.id,
        d.title,
        d.description,
        u.display_name AS "uploaderDisplayName",
        COUNT(DISTINCT t.id) FILTER (WHERE t.id IS NOT NULL)::int AS "threadCount",
        COUNT(DISTINCT t.id) FILTER (WHERE t.id IS NOT NULL AND t.resolved_at IS NULL)::int AS "activeThreadCount",
        latest.signal_at AS "lastActivityAt",
        latest.signal::text AS signal,
        latest.signal_at AS "signalAt"
      FROM latest
      INNER JOIN documents d ON d.id = latest.document_id AND d.deleted_at IS NULL
      INNER JOIN users u ON u.id = d.uploader_id
      LEFT JOIN versions v ON v.document_id = d.id
      LEFT JOIN threads t ON t.version_id = v.id
      GROUP BY d.id, d.title, d.description, u.display_name, latest.signal_at, latest.signal
      ORDER BY latest.signal_at DESC
    `)) as unknown as ActivityRow[];

    const myDocuments: DashboardDocumentSummary[] = myDocsResult.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      uploaderDisplayName: r.uploaderDisplayName,
      threadCount: r.threadCount,
      activeThreadCount: r.activeThreadCount,
      lastActivityAt: new Date(r.lastActivityAt).toISOString(),
    }));

    const recentlyViewedOrCommented: DashboardActivityEntry[] = activityResult.map((r) => ({
      id: r.id,
      title: r.title,
      description: r.description,
      uploaderDisplayName: r.uploaderDisplayName,
      threadCount: r.threadCount,
      activeThreadCount: r.activeThreadCount,
      lastActivityAt: new Date(r.lastActivityAt).toISOString(),
      signal: r.signal,
      signalAt: new Date(r.signalAt).toISOString(),
    }));

    const body: DashboardResponse = { myDocuments, recentlyViewedOrCommented };
    return c.json(body, 200);
  });
}
```

- [ ] **Step 4: Register in `app.ts`**

In `apps/api/src/app.ts`:

```ts
import { registerDashboardRoute } from './routes/dashboard.ts';

// inside createApp, after registerCommentRoutes(app, deps):
registerDashboardRoute(app);
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @primer/api test dashboard
pnpm --filter @primer/api test
pnpm --filter @primer/api typecheck
```

Expected: 5 new tests pass; full suite green; typecheck clean.

If the SQL has issues (postgres.js result row shapes can be surprising), iterate — log `myDocsResult[0]` and `activityResult[0]` to inspect actual keys; adjust column quoting/aliases as needed. The `as unknown as MyDocRow[]` cast is a deliberate pragmatic choice — Drizzle's raw `execute` doesn't infer.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src
git commit -m "feat(api): GET /api/dashboard with my-docs + recently-viewed-or-commented"
```

---

## Phase E — Frontend queries + mutations

### Task 12: `useThreadsQuery` with 10s polling + ETag preservation

**Files:**
- Create: `apps/web/src/queries/threads.ts`

(No test file — TanStack Query hooks aren't usefully unit-tested in Node mode. Manual verification through the document viewer.)

- [ ] **Step 1: Create the hook**

File: `apps/web/src/queries/threads.ts`

```ts
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { ThreadsListResponse } from '@primer/shared';

// Module-level ETag cache keyed by versionId. Re-renders don't lose it.
const etagByVersion = new Map<string, string>();

interface CachedShape {
  data: ThreadsListResponse;
  etag: string | null;
}

async function fetchConditional(
  versionId: string,
  previous: CachedShape | undefined,
  signal: AbortSignal
): Promise<CachedShape> {
  const headers: Record<string, string> = {};
  const cachedEtag = etagByVersion.get(versionId);
  if (cachedEtag) headers['if-none-match'] = cachedEtag;

  const res = await fetch(`/api/versions/${versionId}/threads`, { headers, signal });

  if (res.status === 304) {
    // Not modified: return previous payload. If we have no previous (e.g., remount), refetch unconditionally.
    if (previous) return previous;
    // Fall through: re-fetch without conditional header.
    etagByVersion.delete(versionId);
    return fetchConditional(versionId, undefined, signal);
  }

  if (!res.ok) {
    throw new Error(`threads fetch failed: ${res.status}`);
  }

  const data = (await res.json()) as ThreadsListResponse;
  const etag = res.headers.get('etag');
  if (etag) etagByVersion.set(versionId, etag);
  return { data, etag };
}

export function useThreadsQuery(versionId: string) {
  const qc = useQueryClient();
  const [paused, setPaused] = useState(typeof document !== 'undefined' && document.hidden);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVis = () => setPaused(document.hidden);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  return useQuery({
    queryKey: ['threads', versionId],
    queryFn: async ({ signal }) => {
      const previous = qc.getQueryData<CachedShape>(['threads', versionId]);
      return fetchConditional(versionId, previous, signal);
    },
    refetchInterval: paused ? false : 10_000,
    refetchIntervalInBackground: false,
    staleTime: 0,
    retry: 1,
  });
}

export type ThreadsQueryShape = CachedShape;

export function clearThreadsEtag(versionId: string): void {
  etagByVersion.delete(versionId);
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /home/taylan/development/polygon/primer
pnpm --filter @primer/web typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/queries/threads.ts
git commit -m "feat(web): useThreadsQuery — 10s polling, foreground-only, ETag-conditional"
```

---

### Task 13: Mutation hooks

**Files:**
- Create: `apps/web/src/queries/mutations.ts`

- [ ] **Step 1: Implement all six mutations**

File: `apps/web/src/queries/mutations.ts`

```ts
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  AnchorData,
  CommentDTO,
  CreateThreadRequest,
  ThreadDTO,
} from '@primer/shared';
import { clearThreadsEtag, type ThreadsQueryShape } from './threads.ts';

async function jsonOrThrow<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${text}`);
  }
  return (await res.json()) as T;
}

export function useCreateThread(versionId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { anchor: AnchorData; body: string }) => {
      const payload: CreateThreadRequest = { anchor: input.anchor, body: input.body };
      const res = await fetch(`/api/versions/${versionId}/threads`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return jsonOrThrow<ThreadDTO>(res);
    },
    onSuccess: (newThread) => {
      // Optimistically merge into cache.
      qc.setQueryData<ThreadsQueryShape>(['threads', versionId], (prev) => {
        if (!prev) return prev;
        return { ...prev, data: { ...prev.data, threads: [...prev.data.threads, newThread] } };
      });
      // Force the next poll to re-confirm.
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useReply(versionId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch(`/api/threads/${threadId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      return jsonOrThrow<{ comment: CommentDTO; thread: ThreadDTO }>(res);
    },
    onSuccess: (out) => {
      qc.setQueryData<ThreadsQueryShape>(['threads', versionId], (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          data: {
            ...prev.data,
            threads: prev.data.threads.map((t) => (t.id === out.thread.id ? out.thread : t)),
          },
        };
      });
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useResolveThread(versionId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/threads/${threadId}/resolve`, { method: 'POST' });
      return jsonOrThrow<ThreadDTO>(res);
    },
    onSuccess: (thread) => {
      qc.setQueryData<ThreadsQueryShape>(['threads', versionId], (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          data: {
            ...prev.data,
            threads: prev.data.threads.map((t) => (t.id === thread.id ? thread : t)),
          },
        };
      });
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useReopenThread(versionId: string, threadId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/threads/${threadId}/reopen`, { method: 'POST' });
      return jsonOrThrow<ThreadDTO>(res);
    },
    onSuccess: (thread) => {
      qc.setQueryData<ThreadsQueryShape>(['threads', versionId], (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          data: {
            ...prev.data,
            threads: prev.data.threads.map((t) => (t.id === thread.id ? thread : t)),
          },
        };
      });
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useEditComment(versionId: string, commentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: string) => {
      const res = await fetch(`/api/comments/${commentId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body }),
      });
      return jsonOrThrow<CommentDTO>(res);
    },
    onSuccess: (updated) => {
      qc.setQueryData<ThreadsQueryShape>(['threads', versionId], (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          data: {
            ...prev.data,
            threads: prev.data.threads.map((t) =>
              t.id === updated.threadId
                ? { ...t, comments: t.comments.map((c) => (c.id === updated.id ? updated : c)) }
                : t
            ),
          },
        };
      });
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}

export function useDeleteComment(versionId: string, commentId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/comments/${commentId}`, { method: 'DELETE' });
      return jsonOrThrow<CommentDTO>(res);
    },
    onSuccess: (tombstone) => {
      qc.setQueryData<ThreadsQueryShape>(['threads', versionId], (prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          data: {
            ...prev.data,
            threads: prev.data.threads.map((t) =>
              t.id === tombstone.threadId
                ? { ...t, comments: t.comments.map((c) => (c.id === tombstone.id ? tombstone : c)) }
                : t
            ),
          },
        };
      });
      clearThreadsEtag(versionId);
      qc.invalidateQueries({ queryKey: ['threads', versionId] });
    },
  });
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm --filter @primer/web typecheck
git add apps/web/src/queries/mutations.ts
git commit -m "feat(web): mutation hooks for create/reply/resolve/reopen/edit/delete"
```

---

### Task 14: `useDashboardQuery`

**Files:**
- Create: `apps/web/src/queries/dashboard.ts`

- [ ] **Step 1: Implement**

File: `apps/web/src/queries/dashboard.ts`

```ts
import { useQuery } from '@tanstack/react-query';
import type { DashboardResponse } from '@primer/shared';

export function useDashboardQuery() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: async ({ signal }): Promise<DashboardResponse> => {
      const res = await fetch('/api/dashboard', { signal });
      if (!res.ok) throw new Error(`dashboard fetch failed: ${res.status}`);
      return res.json();
    },
    staleTime: 30_000,
  });
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm --filter @primer/web typecheck
git add apps/web/src/queries/dashboard.ts
git commit -m "feat(web): useDashboardQuery"
```

---

## Phase F — Frontend components

### Task 15: `NewThreadComposer` component

**Files:**
- Create: `apps/web/src/components/NewThreadComposer.tsx`

- [ ] **Step 1: Implement**

File: `apps/web/src/components/NewThreadComposer.tsx`

```tsx
import { useState, type FormEvent, type KeyboardEvent } from 'react';
import type { AnchorData } from '@primer/shared';

interface Props {
  anchor: AnchorData;
  submitting: boolean;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}

function anchorPreview(a: AnchorData): string {
  if (a.type === 'text-range') {
    return `"…${a.selectorText.slice(0, 80)}${a.selectorText.length > 80 ? '…' : ''}"`;
  }
  return a.path;
}

export function NewThreadComposer({ anchor, submitting, onSubmit, onCancel }: Props) {
  const [body, setBody] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (body.trim().length === 0) return;
    onSubmit(body.trim());
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      if (body.trim().length > 0) onSubmit(body.trim());
    }
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-b border-yellow-200 bg-yellow-50 px-3 py-2 text-xs"
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700">
        New comment
      </div>
      <div className="mb-2 border-l-2 border-yellow-300 pl-2 italic text-neutral-600">
        {anchorPreview(anchor)}
      </div>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={handleKeyDown}
        rows={3}
        maxLength={5000}
        placeholder="Write a comment…"
        className="block w-full rounded border border-neutral-300 px-2 py-1 text-xs"
      />
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-neutral-300 bg-white px-3 py-1 text-xs text-neutral-700 hover:bg-neutral-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={submitting || body.trim().length === 0}
          className="rounded bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-800 disabled:opacity-50"
        >
          {submitting ? 'Saving…' : 'Comment'}
        </button>
      </div>
    </form>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm --filter @primer/web typecheck
git add apps/web/src/components/NewThreadComposer.tsx
git commit -m "feat(web): NewThreadComposer with anchor preview + Cmd/Ctrl+Enter submit"
```

---

### Task 16: `ThreadCard` component

**Files:**
- Create: `apps/web/src/components/ThreadCard.tsx`

- [ ] **Step 1: Implement**

File: `apps/web/src/components/ThreadCard.tsx`

```tsx
import { useState } from 'react';
import type { CommentDTO, ThreadDTO } from '@primer/shared';
import {
  useReply,
  useResolveThread,
  useReopenThread,
  useEditComment,
  useDeleteComment,
} from '../queries/mutations.ts';

interface Props {
  versionId: string;
  thread: ThreadDTO;
  drifted: boolean;
  currentUserId: string;
  onHighlight: (anchorId: string) => void;
}

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

function anchorPreview(t: ThreadDTO): string {
  if (t.anchor.type === 'text-range') {
    const text = t.anchor.selectorText;
    return `"${text.slice(0, 60)}${text.length > 60 ? '…' : ''}"`;
  }
  return t.anchor.path;
}

function CommentRow({
  comment,
  isReply,
  isAuthor,
  versionId,
}: {
  comment: CommentDTO;
  isReply: boolean;
  isAuthor: boolean;
  versionId: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(comment.body);
  const edit = useEditComment(versionId, comment.id);
  const del = useDeleteComment(versionId, comment.id);
  const isTombstoned = comment.deletedAt !== null;

  return (
    <div className={isReply ? 'mt-1 ml-3 border-t border-dashed border-neutral-200 pt-1' : ''}>
      <div className="flex justify-between text-[10px] text-neutral-500">
        <span className="font-semibold text-neutral-800">{comment.authorDisplayName}</span>
        <span>
          {relativeTime(comment.createdAt)}
          {comment.updatedAt && !isTombstoned && (
            <span className="ml-1 italic text-neutral-400">(edited)</span>
          )}
        </span>
      </div>
      {isTombstoned ? (
        <div className="italic text-neutral-400">deleted by author</div>
      ) : editing ? (
        <div>
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            rows={2}
            maxLength={5000}
            className="block w-full rounded border border-neutral-300 px-2 py-1 text-xs"
          />
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setDraft(comment.body);
              }}
              className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-[10px] text-neutral-700"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={edit.isPending || draft.trim().length === 0}
              onClick={() => {
                edit.mutate(draft.trim(), { onSuccess: () => setEditing(false) });
              }}
              className="rounded bg-neutral-900 px-2 py-0.5 text-[10px] text-white disabled:opacity-50"
            >
              Save
            </button>
          </div>
        </div>
      ) : (
        <div className="leading-tight text-neutral-900">{comment.body}</div>
      )}
      {!isTombstoned && !editing && isAuthor && (
        <div className="mt-0.5 flex gap-2 text-[9px] text-neutral-500">
          <button type="button" onClick={() => setEditing(true)} className="underline">
            Edit
          </button>
          <button
            type="button"
            disabled={del.isPending}
            onClick={() => del.mutate()}
            className="underline"
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

export function ThreadCard({ versionId, thread, drifted, currentUserId, onHighlight }: Props) {
  const [replying, setReplying] = useState(false);
  const [replyDraft, setReplyDraft] = useState('');
  const reply = useReply(versionId, thread.id);
  const resolve = useResolveThread(versionId, thread.id);
  const reopen = useReopenThread(versionId, thread.id);
  const isResolved = thread.resolvedAt !== null;
  const [first, ...replies] = thread.comments;

  return (
    <article
      className={`border-b border-neutral-100 px-3 py-2 text-xs ${
        isResolved ? 'opacity-55' : ''
      } ${drifted ? 'opacity-60' : ''}`}
      onClick={(e) => {
        // Don't fire when interacting with buttons / textareas inside the card.
        if ((e.target as HTMLElement).closest('button, textarea, input, a')) return;
        onHighlight(thread.id);
      }}
    >
      <div className="mb-1 flex items-start gap-1 border-l-2 border-yellow-300 pl-2 italic leading-tight text-neutral-600">
        {drifted && <span title="Could not place anchor" className="not-italic">📍?</span>}
        <span className="truncate">{anchorPreview(thread)}</span>
      </div>
      {first && (
        <CommentRow
          comment={first}
          isReply={false}
          isAuthor={first.authorId === currentUserId}
          versionId={versionId}
        />
      )}
      {replies.map((r) => (
        <CommentRow
          key={r.id}
          comment={r}
          isReply
          isAuthor={r.authorId === currentUserId}
          versionId={versionId}
        />
      ))}
      {replying && (
        <div className="mt-2">
          <textarea
            autoFocus
            value={replyDraft}
            onChange={(e) => setReplyDraft(e.target.value)}
            rows={2}
            maxLength={5000}
            placeholder="Write a reply…"
            className="block w-full rounded border border-neutral-300 px-2 py-1 text-xs"
          />
          <div className="mt-1 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setReplying(false);
                setReplyDraft('');
              }}
              className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-[10px] text-neutral-700"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={reply.isPending || replyDraft.trim().length === 0}
              onClick={() =>
                reply.mutate(replyDraft.trim(), {
                  onSuccess: () => {
                    setReplyDraft('');
                    setReplying(false);
                  },
                })
              }
              className="rounded bg-neutral-900 px-2 py-0.5 text-[10px] text-white disabled:opacity-50"
            >
              Reply
            </button>
          </div>
        </div>
      )}
      <div className="mt-1 flex gap-2 text-[10px] text-neutral-600">
        {!replying && (
          <button type="button" onClick={() => setReplying(true)} className="underline">
            Reply
          </button>
        )}
        {isResolved ? (
          <button type="button" onClick={() => reopen.mutate()} className="underline">
            Reopen
          </button>
        ) : (
          <button type="button" onClick={() => resolve.mutate()} className="underline">
            Resolve
          </button>
        )}
      </div>
    </article>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm --filter @primer/web typecheck
git add apps/web/src/components/ThreadCard.tsx
git commit -m "feat(web): ThreadCard with reply/resolve/reopen/edit/delete actions"
```

---

### Task 17: `CommentSidebar` (assembles + handles collapsed rail)

**Files:**
- Create: `apps/web/src/components/CommentSidebar.tsx`

- [ ] **Step 1: Implement**

File: `apps/web/src/components/CommentSidebar.tsx`

```tsx
import { useEffect, useMemo, useState } from 'react';
import type { ThreadDTO } from '@primer/shared';
import { useThreadsQuery } from '../queries/threads.ts';
import { ThreadCard } from './ThreadCard.tsx';
import { NewThreadComposer } from './NewThreadComposer.tsx';
import type { AnchorData } from '@primer/shared';

interface PendingAnchor {
  anchor: AnchorData;
}

interface Props {
  versionId: string;
  currentUserId: string;
  pending: PendingAnchor | null;
  onCancelPending: () => void;
  onSubmitPending: (body: string) => Promise<void>;
  onHighlight: (anchorId: string) => void;
  /** Optional ordering hint: anchorId → top-of-rect y in iframe viewport (from anchor_positions). */
  positionsByAnchorId?: Map<string, { y: number; drifted: boolean }>;
}

const COLLAPSED_KEY = 'primer.sidebar.collapsed';

export function CommentSidebar({
  versionId,
  currentUserId,
  pending,
  onCancelPending,
  onSubmitPending,
  onHighlight,
  positionsByAnchorId,
}: Props) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(COLLAPSED_KEY) === '1';
  });
  const [hideResolved, setHideResolved] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(COLLAPSED_KEY, collapsed ? '1' : '0');
  }, [collapsed]);

  const query = useThreadsQuery(versionId);
  const threads = query.data?.data.threads ?? [];

  const sortedThreads = useMemo<ThreadDTO[]>(() => {
    if (!positionsByAnchorId || positionsByAnchorId.size === 0) {
      return [...threads].sort(
        (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
      );
    }
    return [...threads].sort((a, b) => {
      const pa = positionsByAnchorId.get(a.id);
      const pb = positionsByAnchorId.get(b.id);
      if (pa?.drifted && !pb?.drifted) return 1;
      if (!pa?.drifted && pb?.drifted) return -1;
      const ya = pa?.y ?? Number.POSITIVE_INFINITY;
      const yb = pb?.y ?? Number.POSITIVE_INFINITY;
      if (ya !== yb) return ya - yb;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });
  }, [threads, positionsByAnchorId]);

  const visible = hideResolved
    ? sortedThreads.filter((t) => t.resolvedAt === null)
    : sortedThreads;
  const activeCount = threads.filter((t) => t.resolvedAt === null).length;

  if (collapsed) {
    return (
      <div className="flex h-full w-9 flex-col items-center gap-2 border-l border-neutral-200 bg-white py-2">
        <button
          type="button"
          aria-label="Expand sidebar"
          onClick={() => setCollapsed(false)}
          className="flex h-6 w-6 items-center justify-center rounded border border-neutral-300 bg-white text-xs text-neutral-600 hover:bg-neutral-50"
        >
          ›
        </button>
        <span className="rounded-full border border-amber-300 bg-amber-100 px-2 text-[9px] font-semibold text-neutral-700">
          {activeCount}
        </span>
        <div className="flex w-full flex-1 flex-col items-center gap-1 pt-2">
          {sortedThreads.map((t) => (
            <button
              key={t.id}
              type="button"
              title={t.anchor.type === 'text-range' ? t.anchor.selectorText : t.anchor.path}
              onClick={() => {
                setCollapsed(false);
                onHighlight(t.id);
              }}
              className={`h-1.5 w-[18px] rounded-sm ${
                t.resolvedAt !== null ? 'bg-neutral-300' : 'bg-yellow-300'
              }`}
            />
          ))}
        </div>
      </div>
    );
  }

  return (
    <aside className="flex h-full w-[300px] flex-col border-l border-neutral-200 bg-white">
      <header className="flex items-center justify-between border-b border-neutral-200 px-3 py-2 text-xs text-neutral-600">
        <span className="font-semibold text-neutral-900">
          {threads.length} thread{threads.length === 1 ? '' : 's'}
        </span>
        <div className="flex items-center gap-3">
          <label className="flex cursor-pointer select-none items-center gap-1">
            <input
              type="checkbox"
              checked={hideResolved}
              onChange={(e) => setHideResolved(e.target.checked)}
              className="h-3 w-3"
            />
            Hide resolved
          </label>
          <button
            type="button"
            aria-label="Collapse sidebar"
            onClick={() => setCollapsed(true)}
            className="text-neutral-500 hover:text-neutral-900"
          >
            ›
          </button>
        </div>
      </header>

      {pending && (
        <NewThreadComposer
          anchor={pending.anchor}
          submitting={submitting}
          onCancel={onCancelPending}
          onSubmit={async (body) => {
            setSubmitting(true);
            try {
              await onSubmitPending(body);
            } finally {
              setSubmitting(false);
            }
          }}
        />
      )}

      <div className="flex-1 overflow-y-auto">
        {visible.map((t) => {
          const pos = positionsByAnchorId?.get(t.id);
          return (
            <ThreadCard
              key={t.id}
              versionId={versionId}
              thread={t}
              drifted={pos?.drifted ?? false}
              currentUserId={currentUserId}
              onHighlight={onHighlight}
            />
          );
        })}
        {visible.length === 0 && (
          <div className="px-3 py-4 text-xs text-neutral-500">
            {threads.length === 0 ? 'No comments yet.' : 'No active threads (all resolved).'}
          </div>
        )}
      </div>
    </aside>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
pnpm --filter @primer/web typecheck
git add apps/web/src/components/CommentSidebar.tsx
git commit -m "feat(web): CommentSidebar with collapsed rail + thread list + composer slot"
```

---

## Phase G — Frontend pages

### Task 18: Rewrite `DocumentPage` to mount the sidebar

**Files:**
- Modify: `apps/web/src/routes/document.tsx`

- [ ] **Step 1: Replace the file**

File: `apps/web/src/routes/document.tsx`

```tsx
import { useCallback, useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import type {
  AnchorData,
  InboundProtocolMessage,
  OutboundProtocolMessage,
  TextRangeAnchor,
  ElementPathAnchor,
  SerializableRect,
  ThreadDTO,
} from '@primer/shared';
import { useDocument } from '../queries/documents.ts';
import { useThreadsQuery } from '../queries/threads.ts';
import { useCreateThread } from '../queries/mutations.ts';
import { ArtifactIframe } from '../components/ArtifactIframe.tsx';
import { CommentSidebar } from '../components/CommentSidebar.tsx';
import { handleOpenExternal, isSafeExternalUrl } from '../companion/client.ts';

const MOCK_USER_ID = 'mock-user-1';

interface PendingSelection {
  anchor: TextRangeAnchor;
  clientRects: SerializableRect[];
}

interface PendingPick {
  anchor: ElementPathAnchor;
  clientRect: SerializableRect;
}

export function DocumentPage() {
  const { docId } = useParams();
  const q = useDocument(docId ?? '');
  const latestVersionId = q.data?.latestVersion.id ?? '';

  const threadsQuery = useThreadsQuery(latestVersionId);
  const threads = threadsQuery.data?.data.threads ?? [];
  const createThread = useCreateThread(latestVersionId);

  const [pendingSelection, setPendingSelection] = useState<PendingSelection | null>(null);
  const [pendingPick, setPendingPick] = useState<PendingPick | null>(null);
  const [pickMode, setPickMode] = useState(false);
  const [positionsByAnchorId, setPositionsByAnchorId] = useState<
    Map<string, { y: number; drifted: boolean }>
  >(new Map());

  const senderRef = useRef<((m: OutboundProtocolMessage) => void) | null>(null);
  const iframeWrapperRef = useRef<HTMLDivElement>(null);

  const anchorsForCompanion = useMemo(
    () => threads.map((t) => ({ id: t.id, data: t.anchor })),
    [threads]
  );

  const send = useCallback((msg: OutboundProtocolMessage) => {
    senderRef.current?.(msg);
  }, []);

  const registerSender = useCallback(
    (s: ((m: OutboundProtocolMessage) => void) | null) => {
      senderRef.current = s;
      if (s) {
        // On port open, push the current anchor set + request positions.
        s({ type: 'update_anchors', anchors: anchorsForCompanion });
        s({ type: 'request_anchor_positions' });
      }
    },
    [anchorsForCompanion]
  );

  // Push fresh anchors whenever threads change AFTER initial mount.
  // (registerSender's initial push handles mount.)
  useMemo(() => {
    if (senderRef.current) {
      senderRef.current({ type: 'update_anchors', anchors: anchorsForCompanion });
      senderRef.current({ type: 'request_anchor_positions' });
    }
  }, [anchorsForCompanion]);

  const onMessage = useCallback(
    (msg: InboundProtocolMessage) => {
      switch (msg.type) {
        case 'selection_captured':
          setPendingSelection({ anchor: msg.anchor, clientRects: msg.clientRects });
          setPendingPick(null);
          break;
        case 'element_picked':
          setPendingPick({ anchor: msg.anchor, clientRect: msg.clientRect });
          setPendingSelection(null);
          setPickMode(false);
          break;
        case 'pick_mode_exited':
          setPickMode(false);
          break;
        case 'anchor_positions':
          setPositionsByAnchorId(
            new Map(
              msg.positions.map((p) => [
                p.anchorId,
                { y: p.rects[0]?.y ?? Number.POSITIVE_INFINITY, drifted: p.drifted ?? false },
              ])
            )
          );
          break;
        case 'open_external':
          if (isSafeExternalUrl(msg.url)) handleOpenExternal(msg);
          break;
        case 'resize':
          // After body changes, re-request positions to keep sidebar order fresh.
          senderRef.current?.({ type: 'request_anchor_positions' });
          break;
      }
    },
    []
  );

  const togglePickMode = () => {
    if (pickMode) {
      send({ type: 'exit_pick_mode' });
      setPickMode(false);
    } else {
      send({ type: 'enter_pick_mode' });
      setPickMode(true);
    }
  };

  const onHighlight = useCallback((anchorId: string) => {
    senderRef.current?.({ type: 'highlight_anchor', anchorId });
  }, []);

  const submitPending = async (body: string) => {
    const anchor: AnchorData | null = pendingSelection
      ? pendingSelection.anchor
      : pendingPick
      ? pendingPick.anchor
      : null;
    if (!anchor) return;
    await createThread.mutateAsync({ anchor, body });
    setPendingSelection(null);
    setPendingPick(null);
  };

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

  // Position the floating "Add comment" pill near the selection.
  let pillPos: { left: number; top: number } | null = null;
  if (pendingSelection && pendingSelection.clientRects.length > 0) {
    const iframeEl = iframeWrapperRef.current?.querySelector('iframe');
    const iframeRect = iframeEl?.getBoundingClientRect();
    const r = pendingSelection.clientRects[0];
    pillPos = {
      left: (iframeRect?.left ?? 0) + r.x,
      top: (iframeRect?.top ?? 0) + r.y + r.height + 4,
    };
  }

  const composerPending = pendingSelection
    ? { anchor: pendingSelection.anchor as AnchorData }
    : pendingPick
    ? { anchor: pendingPick.anchor as AnchorData }
    : null;

  return (
    <div className="flex flex-col h-[calc(100vh-60px)]">
      <header className="flex items-baseline justify-between border-b border-neutral-200 px-4 pb-2 pt-1">
        <div>
          <h1 className="text-xl font-semibold">{document.title}</h1>
          {document.description && (
            <p className="text-sm text-neutral-600">{document.description}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={togglePickMode}
            className={`rounded px-3 py-1 text-sm ${
              pickMode
                ? 'bg-red-600 text-white'
                : 'border border-neutral-300 hover:bg-neutral-100'
            }`}
          >
            {pickMode ? 'Exit pick mode' : 'Pick element'}
          </button>
          <div className="text-sm text-neutral-500">
            {document.uploaderDisplayName} ·{' '}
            {new Date(document.createdAt).toLocaleString()}
          </div>
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        <div ref={iframeWrapperRef} className="flex-1 overflow-hidden">
          <ArtifactIframe
            src={`/api/versions/${latestVersion.id}/content`}
            anchors={anchorsForCompanion}
            onMessage={onMessage}
            registerSender={registerSender}
          />
        </div>
        <CommentSidebar
          versionId={latestVersion.id}
          currentUserId={MOCK_USER_ID}
          pending={composerPending}
          onCancelPending={() => {
            setPendingSelection(null);
            setPendingPick(null);
          }}
          onSubmitPending={submitPending}
          onHighlight={onHighlight}
          positionsByAnchorId={positionsByAnchorId}
        />
      </div>

      {pillPos && pendingSelection && !composerPending && (
        // The pill stays visible until the user clicks it OR the composer takes over.
        // For SP3, clicking the pill IS the same as showing the composer (composer is in
        // the sidebar); we keep the pill visible to indicate the captured selection.
        <div
          style={{ position: 'fixed', left: pillPos.left, top: pillPos.top, zIndex: 1000 }}
          className="flex items-center gap-2 rounded-md bg-neutral-900 px-3 py-1.5 text-xs text-white shadow-lg"
        >
          <span>Add comment in sidebar →</span>
          <button
            type="button"
            onClick={() => setPendingSelection(null)}
            className="rounded border border-neutral-700 px-1 text-neutral-300 hover:bg-neutral-800"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + build**

```bash
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/routes/document.tsx
git commit -m "feat(web): DocumentPage mounts CommentSidebar + composer flow"
```

---

### Task 19: Rewrite `HomePage` with `DocumentListRow`

**Files:**
- Create: `apps/web/src/components/DocumentListRow.tsx`
- Modify: `apps/web/src/routes/home.tsx`

- [ ] **Step 1: Implement DocumentListRow**

File: `apps/web/src/components/DocumentListRow.tsx`

```tsx
import { Link } from 'react-router-dom';
import type {
  DashboardActivityEntry,
  DashboardDocumentSummary,
} from '@primer/shared';

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

interface MyDocProps {
  doc: DashboardDocumentSummary;
}

export function MyDocumentRow({ doc }: MyDocProps) {
  return (
    <Link
      to={`/d/${doc.id}`}
      className="flex items-center justify-between border-b border-neutral-100 px-1 py-2.5 hover:bg-neutral-50"
    >
      <div className="flex flex-col gap-0.5 min-w-0 flex-1 mr-3">
        <span className="text-sm font-medium text-neutral-900 truncate">{doc.title}</span>
        <span className="text-xs text-neutral-500 truncate">
          {doc.description ? doc.description : <em className="text-neutral-400">no description</em>}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
          {doc.threadCount === 0
            ? 'no threads yet'
            : `${doc.activeThreadCount}/${doc.threadCount} active`}
        </span>
        <span className="w-20 text-right text-xs text-neutral-500">
          {relativeTime(doc.lastActivityAt)}
        </span>
      </div>
    </Link>
  );
}

interface ActivityProps {
  entry: DashboardActivityEntry;
}

export function ActivityRow({ entry }: ActivityProps) {
  const signalLabel =
    entry.signal === 'commented'
      ? `you commented ${relativeTime(entry.signalAt)}`
      : `viewed ${relativeTime(entry.signalAt)}`;

  return (
    <Link
      to={`/d/${entry.id}`}
      className="flex items-center justify-between border-b border-neutral-100 px-1 py-2.5 hover:bg-neutral-50"
    >
      <div className="flex flex-col gap-0.5 min-w-0 flex-1 mr-3">
        <span className="text-sm font-medium text-neutral-900 truncate">{entry.title}</span>
        <span className="text-xs text-neutral-500 truncate">
          by {entry.uploaderDisplayName} · {signalLabel}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
          {entry.threadCount === 0
            ? 'no threads'
            : `${entry.activeThreadCount}/${entry.threadCount} active`}
        </span>
        <span className="w-20 text-right text-xs text-neutral-500">
          {relativeTime(entry.signalAt)}
        </span>
      </div>
    </Link>
  );
}
```

- [ ] **Step 2: Rewrite HomePage**

File: `apps/web/src/routes/home.tsx`

```tsx
import { Link } from 'react-router-dom';
import { useDashboardQuery } from '../queries/dashboard.ts';
import { ActivityRow, MyDocumentRow } from '../components/DocumentListRow.tsx';

export function HomePage() {
  const q = useDashboardQuery();
  return (
    <div className="space-y-8 max-w-3xl">
      <header className="flex items-center justify-between border-b border-neutral-200 pb-3">
        <h1 className="text-2xl font-semibold">Primer</h1>
        <Link
          to="/upload"
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800"
        >
          + Upload document
        </Link>
      </header>

      {q.isLoading && <div className="text-sm text-neutral-500">Loading…</div>}
      {q.error && (
        <div className="text-sm text-red-600">
          Could not load dashboard: {(q.error as Error).message}
        </div>
      )}

      {q.data && (
        <>
          <section>
            <div className="mb-2 flex items-baseline justify-between border-b border-neutral-200 pb-1">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-900">
                My documents
              </h2>
              <span className="text-xs text-neutral-500">
                {q.data.myDocuments.length}{' '}
                {q.data.myDocuments.length === 1 ? 'doc' : 'docs'}
              </span>
            </div>
            {q.data.myDocuments.length === 0 ? (
              <div className="px-1 py-4 text-sm italic text-neutral-500">
                No documents yet. Upload your first one.
              </div>
            ) : (
              q.data.myDocuments.map((doc) => <MyDocumentRow key={doc.id} doc={doc} />)
            )}
          </section>

          <section>
            <div className="mb-2 flex items-baseline justify-between border-b border-neutral-200 pb-1">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-900">
                Recently viewed or commented
              </h2>
              <span className="text-xs text-neutral-500">Last 30 days</span>
            </div>
            {q.data.recentlyViewedOrCommented.length === 0 ? (
              <div className="px-1 py-4 text-sm italic text-neutral-500">Nothing recent.</div>
            ) : (
              q.data.recentlyViewedOrCommented.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))
            )}
          </section>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Typecheck + build**

```bash
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web build
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src
git commit -m "feat(web): real HomePage with my-documents + recently-viewed lists"
```

---

## Phase H — Verification + finalize

### Task 20: Cross-cutting verification

**Files:** none — verification only.

- [ ] **Step 1: Full test + typecheck + audit**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
cd /home/taylan/development/polygon/primer
pnpm verify 2>&1 | tail -30
```

Expected: typecheck clean, all tests pass (api ~62, web ~17), audit at high level clean.

- [ ] **Step 2: Boot both processes; smoke-check the threads endpoint**

```bash
# Make sure no stragglers
pkill -f 'primer/apps/(web|api)/node_modules' 2>/dev/null
sleep 1

cd /home/taylan/development/polygon/primer
pnpm dev > /tmp/primer-sp3-smoke.log 2>&1 &
DEV_PID=$!
sleep 6
ss -tlnp 2>/dev/null | grep -E ':(3000|5173)' || echo "ports not bound"
curl -s http://localhost:3000/api/health
echo
# Dashboard returns empty lists for a fresh dev DB.
curl -s http://localhost:3000/api/dashboard | head -c 200
echo
kill $DEV_PID 2>/dev/null
wait 2>/dev/null
```

Expected: `/api/health` returns `{"ok":true}`. `/api/dashboard` returns JSON with `myDocuments` and `recentlyViewedOrCommented` arrays.

- [ ] **Step 3: Any deviations → fix and re-commit**

If anything fails, apply targeted fixes with `fix:` prefix and re-verify the affected piece.

---

### Task 21: Squash-merge into master + clean up

**Files:** none.

- [ ] **Step 1: Confirm clean working tree on the feature branch**

```bash
cd /home/taylan/development/polygon/primer
git status
git log --oneline master..feat/comments-threading | wc -l
git log --oneline -3
```

Expected: working tree clean; ~21 commits on the branch.

- [ ] **Step 2: Squash merge to master**

```bash
git checkout master
git merge --squash feat/comments-threading
git status   # shows all the additions staged
```

- [ ] **Step 3: Commit with a comprehensive message**

```bash
git commit -m "$(cat <<'EOF'
Implement Primer sub-project 3: comments + threading + dashboard

Wire the SP2 anchoring substrate to real DB-backed threads, ship the
sidebar UI on the document viewer, and replace the home placeholder
with a real dashboard.

API:
- New document_views table (composite PK on user_id + document_id)
  with cascade on document delete.
- Typed threads.anchor refinement to the AnchorData union.
- New REST endpoints under /api/:
  GET    /versions/:vid/threads     (polling target; weak ETag + 304)
  POST   /versions/:vid/threads     (create thread + first comment)
  POST   /threads/:tid/resolve      (idempotent)
  POST   /threads/:tid/reopen       (idempotent)
  POST   /threads/:tid/comments     (reply; auto-reopens resolved threads)
  PATCH  /comments/:cid             (author-only; sets updated_at)
  DELETE /comments/:cid             (author-only soft-delete; tombstone)
  GET    /dashboard                 (my docs + recently viewed/commented)
- Notifier interface with NoopNotifier default, injected via AppDeps;
  every comment-create / edit / reply path fires it. SP6 swaps in the
  Slack implementation behind the same interface.
- GET /api/documents/:docId now upserts document_views as a fire-and-
  forget side effect.

Web:
- useThreadsQuery: TanStack Query at 10s, foreground-only (pauses on
  document.hidden, resumes on visibility), ETag stored in a
  module-scope Map, returns previous cached payload on 304.
- Mutation hooks for create/reply/resolve/reopen/edit/delete with
  optimistic cache merges + queryClient.invalidateQueries.
- New CommentSidebar (360px expanded / 36px collapsed rail with thread
  markers), ThreadCard, NewThreadComposer, DocumentListRow components.
- DocumentPage rewritten: drops SP2 ephemeral state, mounts the sidebar,
  pushes update_anchors on every threads change, requests
  anchor_positions for document-order sort, routes selection_captured
  and element_picked through the same composer.
- HomePage rewritten: real "My documents" + "Recently viewed or
  commented (last 30 days)" lists from the dashboard endpoint.

Tests:
- 20+ new Vitest cases against real Postgres (primer_test): every
  endpoint, ETag/304 round-trip, auto-reopen on reply, author-only
  authorization, tombstone semantics, view upsert idempotency, all
  five dashboard scenarios.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
git log --oneline -3
```

- [ ] **Step 4: Verify tests still pass on master**

```bash
export PATH="$HOME/.local/bin:/nix/store/9cyx2v23dip6p9q98384k9v06c96qskb-nodejs-24.13.0/bin:$PATH"
pnpm --filter @primer/api test 2>&1 | tail -5
pnpm --filter @primer/web test 2>&1 | tail -5
```

Expected: still green.

- [ ] **Step 5: Force-delete the feature branch (commits subsumed by squash)**

```bash
git branch -D feat/comments-threading
git branch -a
```

Expected: only `master` remains.

- [ ] **Step 6: Stop**

Done.

---

## Notes for the implementer

- **Two-DB pattern from SP1:** every `pnpm db:migrate` should be paired with `pnpm db:migrate:test` so both databases stay in sync. Task 1 includes this explicitly.
- **Test isolation:** the existing `apps/api/src/testing/setup.ts` truncates transactional tables between tests. The new `document_views` table needs to be added to that list so the dashboard tests don't see stale rows. Verify the truncate statement covers it; if not, extend it. Specifically, the truncate currently says `truncate table comments, threads, versions, documents restart identity cascade` — extend to include `document_views`:
  ```sql
  truncate table document_views, comments, threads, versions, documents restart identity cascade
  ```
  Update `apps/api/src/testing/setup.ts` accordingly as part of Task 1's commit (or anywhere before Task 11 / 10 needs it).
- **Drizzle's raw `db.execute(sql\`…\`)` result shape** is `{ rows: [...] }` on `pg`-backed clients but a direct array on `postgres-js`. We use postgres-js. The cast `as unknown as MyDocRow[]` in Task 11 reflects this. If the cast misfires at runtime (rows not under `.rows`), check the actual return shape via `console.log(result)` once and adjust.
- **TanStack Query 5 + 304:** the recipe in Task 12 returns the previous cached shape on 304 by reading `qc.getQueryData` from inside the `queryFn`. This works because TanStack Query persists the last successful value as cache state, and the queryFn can read it via the same client. If the cache is empty (first run that somehow gets a 304 — rare), we clear the stale ETag and retry unconditionally.
- **The companion already handles `update_anchors` and `request_anchor_positions`** from SP2. DocumentPage just needs to push the right things at the right times. The current implementation in Task 18 pushes on `registerSender` (initial port open) AND on every threads change via `useMemo`. The `useMemo` pattern with a side effect is a slight smell — if it produces double-pushes or you'd rather move it to `useEffect`, that's fine; the goal is "send fresh anchors when they change."
- **Pick mode + composer:** when the user enters pick mode and clicks an element, the SP2 companion now sends `element_picked`. SP3 DocumentPage sets `pendingPick` (not auto-saves like the proto did). The composer in the sidebar opens with the element-path anchor preview.
