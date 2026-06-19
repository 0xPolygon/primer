# Admin Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade Primer's admin view from six top-line stat cards into a single dashboard with three sections — Adoption, Engagement, Operational — backed by 30-day daily-bucketed data, with charts rendered as hand-rolled inline SVG (no chart library).

**Architecture:** Keep the single endpoint `GET /api/admin/stats`. Extract its query logic into a new `services/adminStats.ts` module with one builder per response block (`buildTotals`, `buildAdoption`, `buildEngagement`, `buildOperational`). Run them in parallel from the route handler. On the frontend, split the page into one orchestrator (`routes/admin.tsx`) + small SVG widget components under `components/admin/` driven by pure helpers in `chartGeom.ts`.

**Tech Stack:** TypeScript, Hono, Drizzle ORM (postgres-js), React 19, Vite, Tailwind v4, Vitest. No new runtime dependencies. UTC date strings (`YYYY-MM-DD`) end-to-end.

**Reference design:** `docs/superpowers/specs/2026-06-19-admin-upgrade-design.md`

**Test commands:**
```bash
# API package
pnpm --filter @primer/api typecheck
pnpm --filter @primer/api exec vitest run <path>

# Web package
pnpm --filter @primer/web typecheck
pnpm --filter @primer/web exec vitest run <path>
```

The API test DB is `primer_test` (configured in `apps/api/vitest.config.ts`). If you see schema errors, run `pnpm db:migrate:test` once. The `beforeEach` in `apps/api/src/testing/setup.ts` truncates transactional tables between tests but preserves the `mock-user-1` row.

---

## File Structure

**New (API):**
- `apps/api/src/services/adminStats.ts` — block builders + shared helpers
- `apps/api/src/services/adminStats.test.ts` — fixture-driven unit tests per block

**Modified (API):**
- `apps/api/src/routes/admin.ts` — thin route that calls the builders and assembles the response
- `apps/api/src/routes/admin.test.ts` — extended E2E coverage on the new payload shape

**Modified (shared):**
- `packages/shared/src/api.ts` — expand `AdminStatsResponse` with three new blocks

**New (web):**
- `apps/web/src/components/admin/chartGeom.ts` — pure scale/tick/format helpers
- `apps/web/src/components/admin/chartGeom.test.ts`
- `apps/web/src/components/admin/StatCard.tsx` — moved from `routes/admin.tsx`
- `apps/web/src/components/admin/AreaChart.tsx` — A1 stacked area
- `apps/web/src/components/admin/LineChart.tsx` — A2 / A3 / O1
- `apps/web/src/components/admin/BarList.tsx` — E1 / E2
- `apps/web/src/components/admin/Histogram.tsx` — E3
- `apps/web/src/components/admin/StackedBar.tsx` — O2
- `apps/web/src/components/admin/Sparkline.tsx` — O3

**Modified (web):**
- `apps/web/src/routes/admin.tsx` — orchestrator: top-line cards + three sections
- `apps/web/src/queries/admin.ts` — no real change (payload widens but the hook code is unchanged)

**Not modified:** database schema, migrations, auth middleware, MCP package.

---

### Task 1: Expand `AdminStatsResponse` in the shared package

A pure type addition. No behavior change. After this task, the API and web packages won't fail to typecheck because the existing six buckets are unchanged.

**Files:**
- Modify: `packages/shared/src/api.ts:156-168`

- [ ] **Step 1: Verify baseline typechecks**

Run:
```bash
pnpm --filter @primer/shared typecheck
pnpm --filter @primer/api typecheck
pnpm --filter @primer/web typecheck
```
Expected: all succeed.

- [ ] **Step 2: Replace the AdminStats types**

In `packages/shared/src/api.ts`, replace the existing `AdminStatsBucket` and `AdminStatsResponse` definitions with the following block (note: `AdminStatsBucket` is unchanged but kept here for readability):

```ts
export interface AdminStatsBucket {
  total: number;
  last7d: number;
}

export interface DailyPoint {
  date: string;     // 'YYYY-MM-DD' UTC
  value: number;
}

export interface DailyStackPoint {
  date: string;     // 'YYYY-MM-DD' UTC
  documents: number;
  versions: number;
  comments: number;
}

export interface ThreadFlowPoint {
  date: string;
  opened: number;
  resolved: number;
}

export interface TopDocument {
  documentId: string;
  title: string;
  viewers: number;
}

export interface TopCommenter {
  userId: string;
  displayName: string;
  comments: number;
}

export interface HistogramBucket {
  bucket: string;
  count: number;
}

export interface AdminAdoptionBlock {
  createdPerDay: DailyStackPoint[];
  activeUsersPerDay: DailyPoint[];
  cumulativeUsers: DailyPoint[];
}

export interface AdminEngagementBlock {
  topDocumentsByViewers: TopDocument[];
  topCommenters: TopCommenter[];
  viewersPerDocHistogram: HistogramBucket[];
}

export interface AdminOperationalBlock {
  storageBytesPerDay: DailyPoint[];
  threadsOpenedVsResolved: ThreadFlowPoint[];
  openThreadsAgingOver14d: {
    count: number;
    sparkline: DailyPoint[];
  };
}

export interface AdminStatsResponse {
  users: AdminStatsBucket;
  documents: AdminStatsBucket;
  versions: AdminStatsBucket;
  threads: AdminStatsBucket;
  comments: AdminStatsBucket;
  documentViews: AdminStatsBucket;

  rangeDays: 30;
  adoption: AdminAdoptionBlock;
  engagement: AdminEngagementBlock;
  operational: AdminOperationalBlock;
}
```

- [ ] **Step 3: Run shared typecheck**

Run: `pnpm --filter @primer/shared typecheck`
Expected: PASS.

- [ ] **Step 4: Run downstream typechecks — expect API to fail**

Run:
```bash
pnpm --filter @primer/api typecheck
pnpm --filter @primer/web typecheck
```
Expected: `apps/api/src/routes/admin.ts` fails because the returned object no longer satisfies the wider `AdminStatsResponse`. Web should still pass — `admin.tsx` only reads the existing buckets via `METRICS`. (If web also errors at this point, fix it locally before continuing — but as written, it should not.)

- [ ] **Step 5: Patch the route to satisfy the type at runtime — temporarily**

In `apps/api/src/routes/admin.ts`, expand the response object so it typechecks but returns empty new blocks:

```ts
const body: AdminStatsResponse = {
  users:         { total: usersTotal[0].c,     last7d: usersLast[0].c },
  documents:     { total: documentsTotal[0].c, last7d: documentsLast[0].c },
  versions:      { total: versionsTotal[0].c,  last7d: versionsLast[0].c },
  threads:       { total: threadsTotal[0].c,   last7d: threadsLast[0].c },
  comments:      { total: commentsTotal[0].c,  last7d: commentsLast[0].c },
  documentViews: { total: viewsTotal[0].c,     last7d: viewsLast[0].c },

  rangeDays: 30,
  adoption: {
    createdPerDay: [],
    activeUsersPerDay: [],
    cumulativeUsers: [],
  },
  engagement: {
    topDocumentsByViewers: [],
    topCommenters: [],
    viewersPerDocHistogram: [],
  },
  operational: {
    storageBytesPerDay: [],
    threadsOpenedVsResolved: [],
    openThreadsAgingOver14d: { count: 0, sparkline: [] },
  },
};
```

This is intentionally inert. Task 6 wires the builders in for real.

- [ ] **Step 6: Re-run typechecks**

Run:
```bash
pnpm --filter @primer/api typecheck
pnpm --filter @primer/web typecheck
```
Expected: both PASS.

- [ ] **Step 7: Run existing admin tests — they should still pass**

Run: `pnpm --filter @primer/api exec vitest run src/routes/admin.test.ts`
Expected: PASS (4 tests). The existing `toMatchObject` assertions don't check for absence of keys, so the wider payload is fine.

- [ ] **Step 8: Commit**

```bash
git add packages/shared/src/api.ts apps/api/src/routes/admin.ts
git commit -m "feat(admin): expand AdminStatsResponse shape (empty blocks)"
```

---

### Task 2: Create `services/adminStats.ts` and extract `buildTotals` (refactor, no behavior change)

Move the existing 12 totals/last7d queries into a `buildTotals(db)` function in a new module, and reduce the route to a single call site. Keep test behavior unchanged.

**Files:**
- Create: `apps/api/src/services/adminStats.ts`
- Modify: `apps/api/src/routes/admin.ts`

- [ ] **Step 1: Create the services directory and module**

Create `apps/api/src/services/adminStats.ts` with:

```ts
import { count, isNull, gt, and, sql } from 'drizzle-orm';
import type {
  AdminStatsBucket,
} from '@primer/shared';
import { db as defaultDb, type Db } from '../db/client.ts';
import {
  users,
  documents,
  versions,
  threads,
  comments,
  documentViews,
} from '@primer/shared/schema';

export interface AdminTotals {
  users: AdminStatsBucket;
  documents: AdminStatsBucket;
  versions: AdminStatsBucket;
  threads: AdminStatsBucket;
  comments: AdminStatsBucket;
  documentViews: AdminStatsBucket;
}

export async function buildTotals(db: Db = defaultDb): Promise<AdminTotals> {
  const since = sql<Date>`now() - interval '7 days'`;

  const [
    usersTotal,     usersLast,
    documentsTotal, documentsLast,
    versionsTotal,  versionsLast,
    threadsTotal,   threadsLast,
    commentsTotal,  commentsLast,
    viewsTotal,     viewsLast,
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

  return {
    users:         { total: usersTotal[0].c,     last7d: usersLast[0].c },
    documents:     { total: documentsTotal[0].c, last7d: documentsLast[0].c },
    versions:      { total: versionsTotal[0].c,  last7d: versionsLast[0].c },
    threads:       { total: threadsTotal[0].c,   last7d: threadsLast[0].c },
    comments:      { total: commentsTotal[0].c,  last7d: commentsLast[0].c },
    documentViews: { total: viewsTotal[0].c,     last7d: viewsLast[0].c },
  };
}
```

- [ ] **Step 2: Replace the route handler body**

In `apps/api/src/routes/admin.ts`, replace the entire file with:

```ts
import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import type { AdminStatsResponse } from '@primer/shared';
import { buildTotals } from '../services/adminStats.ts';

export function registerAdminRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/admin/stats', async (c) => {
    const totals = await buildTotals();

    const body: AdminStatsResponse = {
      ...totals,
      rangeDays: 30,
      adoption: {
        createdPerDay: [],
        activeUsersPerDay: [],
        cumulativeUsers: [],
      },
      engagement: {
        topDocumentsByViewers: [],
        topCommenters: [],
        viewersPerDocHistogram: [],
      },
      operational: {
        storageBytesPerDay: [],
        threadsOpenedVsResolved: [],
        openThreadsAgingOver14d: { count: 0, sparkline: [] },
      },
    };
    return c.json(body, 200);
  });
}
```

- [ ] **Step 3: Run typecheck and the existing tests**

Run:
```bash
pnpm --filter @primer/api typecheck
pnpm --filter @primer/api exec vitest run src/routes/admin.test.ts
```
Expected: both PASS — this is a pure refactor.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/adminStats.ts apps/api/src/routes/admin.ts
git commit -m "refactor(admin): extract buildTotals into services/adminStats"
```

---

### Task 3: Add `dateUtils` helpers + tests (UTC date-string math)

The block builders use a 30-day UTC date spine. Pull the pure helpers out into a tested module so the SQL-heavy builders can stay focused.

**Files:**
- Modify: `apps/api/src/services/adminStats.ts`
- Create: `apps/api/src/services/adminStats.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `apps/api/src/services/adminStats.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import { utcDateString, buildDateSpine, leftJoinDailyCounts } from './adminStats.ts';

describe('utcDateString', () => {
  it('formats a UTC Date as YYYY-MM-DD', () => {
    expect(utcDateString(new Date(Date.UTC(2026, 5, 19)))).toBe('2026-06-19');
    expect(utcDateString(new Date(Date.UTC(2025, 0, 1)))).toBe('2025-01-01');
  });

  it('uses UTC, not local time, near midnight', () => {
    // 23:30 UTC on 2026-06-19 is the *same day* in UTC regardless of local TZ.
    expect(utcDateString(new Date(Date.UTC(2026, 5, 19, 23, 30)))).toBe('2026-06-19');
  });
});

describe('buildDateSpine', () => {
  it('returns exactly N days, oldest first, ending at the given date', () => {
    const end = new Date(Date.UTC(2026, 5, 19));
    const spine = buildDateSpine(end, 30);
    expect(spine).toHaveLength(30);
    expect(spine[0]).toBe('2026-05-21');
    expect(spine[29]).toBe('2026-06-19');
  });

  it('handles month boundaries', () => {
    const end = new Date(Date.UTC(2026, 2, 3));   // 2026-03-03
    const spine = buildDateSpine(end, 5);
    expect(spine).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03']);
  });
});

describe('leftJoinDailyCounts', () => {
  it('returns 0 for spine dates absent from counts', () => {
    const spine = ['2026-06-01', '2026-06-02', '2026-06-03'];
    const counts = new Map([['2026-06-02', 5]]);
    expect(leftJoinDailyCounts(spine, counts)).toEqual([
      { date: '2026-06-01', value: 0 },
      { date: '2026-06-02', value: 5 },
      { date: '2026-06-03', value: 0 },
    ]);
  });

  it('ignores counts not in the spine', () => {
    const spine = ['2026-06-01'];
    const counts = new Map([['2026-06-01', 1], ['2026-05-31', 99]]);
    expect(leftJoinDailyCounts(spine, counts)).toEqual([
      { date: '2026-06-01', value: 1 },
    ]);
  });
});
```

- [ ] **Step 2: Run the test — expect import failure**

Run: `pnpm --filter @primer/api exec vitest run src/services/adminStats.test.ts`
Expected: FAIL with import errors (helpers not exported yet).

- [ ] **Step 3: Implement the helpers**

Append to `apps/api/src/services/adminStats.ts`:

```ts
import type { DailyPoint } from '@primer/shared';

const MS_PER_DAY = 86_400_000;

export function utcDateString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Build an ascending list of UTC YYYY-MM-DD strings ending at `endDate`.
 * `days` is inclusive: buildDateSpine(today, 30) returns 30 strings, the
 * last of which is today's UTC date.
 */
export function buildDateSpine(endDate: Date, days: number): string[] {
  const endUtcMidnight = Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate(),
  );
  const result: string[] = [];
  for (let i = days - 1; i >= 0; i--) {
    result.push(utcDateString(new Date(endUtcMidnight - i * MS_PER_DAY)));
  }
  return result;
}

/**
 * Left-join a date spine against a count map, zero-filling missing days.
 */
export function leftJoinDailyCounts(
  spine: string[],
  counts: Map<string, number>,
): DailyPoint[] {
  return spine.map((date) => ({ date, value: counts.get(date) ?? 0 }));
}
```

- [ ] **Step 4: Run the test — expect PASS**

Run: `pnpm --filter @primer/api exec vitest run src/services/adminStats.test.ts`
Expected: PASS (8 assertions across 3 describes).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/adminStats.ts apps/api/src/services/adminStats.test.ts
git commit -m "feat(admin): add UTC date-spine helpers + tests"
```

---

### Task 4: Implement `buildAdoption` + tests

Three sub-blocks: `createdPerDay` (A1), `activeUsersPerDay` (A2), `cumulativeUsers` (A3). Each is computed against a 30-day window with a `now()`-pinned spine.

**Files:**
- Modify: `apps/api/src/services/adminStats.ts`
- Modify: `apps/api/src/services/adminStats.test.ts`

- [ ] **Step 1: Write failing tests for `buildAdoption`**

Append to `apps/api/src/services/adminStats.test.ts`:

```ts
import { v7 as uuidv7 } from 'uuid';
import { buildAdoption } from './adminStats.ts';
import { db } from '../db/client.ts';
import { users, documents, versions, threads, comments, documentViews } from '@primer/shared/schema';

const MS_PER_DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * MS_PER_DAY);

describe('buildAdoption', () => {
  it('returns exactly 30 entries per series', async () => {
    const res = await buildAdoption();
    expect(res.createdPerDay).toHaveLength(30);
    expect(res.activeUsersPerDay).toHaveLength(30);
    expect(res.cumulativeUsers).toHaveLength(30);
  });

  it('createdPerDay counts documents/versions/comments by UTC day, alive only', async () => {
    const userId = `t-${uuidv7()}`;
    const docId = uuidv7();
    const versionId = uuidv7();
    const threadId = uuidv7();

    await db.insert(users).values({ id: userId, email: 'a@p.t', displayName: 'A' });
    await db.insert(documents).values({
      id: docId, title: 'D', uploaderId: userId, createdAt: daysAgo(2),
    });
    await db.insert(documents).values({
      id: uuidv7(), title: 'gone', uploaderId: userId, createdAt: daysAgo(2),
      deletedAt: daysAgo(1),
    });
    await db.insert(versions).values({
      id: versionId, documentId: docId, versionNumber: 1,
      storageKey: `v1/${versionId}.html`, sizeBytes: 100, versionNote: null,
      createdAt: daysAgo(2),
    });
    await db.insert(threads).values({
      id: threadId, versionId,
      anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      createdAt: daysAgo(2),
    });
    await db.insert(comments).values({
      id: uuidv7(), threadId, authorId: userId, body: 'live', createdAt: daysAgo(2),
    });
    await db.insert(comments).values({
      id: uuidv7(), threadId, authorId: userId, body: 'gone',
      createdAt: daysAgo(2), deletedAt: daysAgo(1),
    });

    const res = await buildAdoption();

    // Derive the expected UTC date from the inserted timestamp to avoid
    // flakiness near midnight UTC. Look up the matching point in the spine.
    const targetDate = daysAgo(2).toISOString().slice(0, 10);
    const point = res.createdPerDay.find((p) => p.date === targetDate);
    expect(point).toEqual({ date: targetDate, documents: 1, versions: 1, comments: 1 });
  });

  it('activeUsersPerDay counts a user once per day across upload/comment/view sources', async () => {
    const userId = `t-${uuidv7()}`;
    const docId = uuidv7();
    const versionId = uuidv7();
    const threadId = uuidv7();
    const when = daysAgo(3);

    await db.insert(users).values({ id: userId, email: 'b@p.t', displayName: 'B' });
    await db.insert(documents).values({
      id: docId, title: 'D', uploaderId: userId, createdAt: when,
    });
    await db.insert(versions).values({
      id: versionId, documentId: docId, versionNumber: 1,
      storageKey: `v1/${versionId}.html`, sizeBytes: 0, versionNote: null,
      createdAt: when,
    });
    await db.insert(threads).values({
      id: threadId, versionId,
      anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      createdAt: when,
    });
    await db.insert(comments).values({
      id: uuidv7(), threadId, authorId: userId, body: 'x', createdAt: when,
    });
    await db.insert(documentViews).values({ userId, documentId: docId, viewedAt: when });

    const res = await buildAdoption();
    const targetDate = when.toISOString().slice(0, 10);
    const point = res.activeUsersPerDay.find((p) => p.date === targetDate);
    expect(point).toBeDefined();
    expect(point!.value).toBeGreaterThanOrEqual(1);
    // The exact value depends on what else seeded the DB, but our user must
    // appear at most once on this day.
  });

  it('cumulativeUsers is monotonic non-decreasing and seeded by pre-window users', async () => {
    // Seed: one user created 60 days ago (pre-window), one created today.
    await db.insert(users).values({
      id: `pre-${uuidv7()}`, email: 'p@p.t', displayName: 'P',
      createdAt: daysAgo(60),
    });
    await db.insert(users).values({
      id: `cur-${uuidv7()}`, email: 'c@p.t', displayName: 'C',
    });

    const res = await buildAdoption();
    for (let i = 1; i < res.cumulativeUsers.length; i++) {
      expect(res.cumulativeUsers[i].value).toBeGreaterThanOrEqual(res.cumulativeUsers[i - 1].value);
    }
    // The first day's seed >= 1 (the pre-window user).
    expect(res.cumulativeUsers[0].value).toBeGreaterThanOrEqual(1);
    // The last day's count must be >= first day + 1 (the today user).
    expect(res.cumulativeUsers[29].value).toBeGreaterThanOrEqual(res.cumulativeUsers[0].value + 1);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @primer/api exec vitest run src/services/adminStats.test.ts`
Expected: FAIL — `buildAdoption` doesn't exist yet.

- [ ] **Step 3: Implement `buildAdoption`**

Append to `apps/api/src/services/adminStats.ts`:

```ts
import type { AdminAdoptionBlock, DailyStackPoint } from '@primer/shared';

const RANGE_DAYS = 30;

function windowStart(endDate: Date, days: number): Date {
  return new Date(Date.UTC(
    endDate.getUTCFullYear(),
    endDate.getUTCMonth(),
    endDate.getUTCDate(),
  ) - (days - 1) * MS_PER_DAY);
}

export async function buildAdoption(db: Db = defaultDb): Promise<AdminAdoptionBlock> {
  const now = new Date();
  const start = windowStart(now, RANGE_DAYS);
  const spine = buildDateSpine(now, RANGE_DAYS);

  // ---- A1: createdPerDay ---------------------------------------------------
  const docsByDay = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', created_at) at time zone 'UTC', 'YYYY-MM-DD') as d,
           count(*)::int as c
      from documents
     where deleted_at is null
       and created_at >= ${start}
     group by 1
  `;
  const versionsByDay = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', created_at) at time zone 'UTC', 'YYYY-MM-DD') as d,
           count(*)::int as c
      from versions
     where created_at >= ${start}
     group by 1
  `;
  const commentsByDay = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', created_at) at time zone 'UTC', 'YYYY-MM-DD') as d,
           count(*)::int as c
      from comments
     where deleted_at is null
       and created_at >= ${start}
     group by 1
  `;

  // ---- A2: activeUsersPerDay ----------------------------------------------
  // UNION ALL of (user_id, date) tuples across activity sources, then
  // count(distinct user_id) per day.
  const activeByDay = sql<{ d: string; c: number }[]>`
    select d, count(distinct user_id)::int as c from (
      select uploader_id as user_id,
             to_char(date_trunc('day', created_at) at time zone 'UTC', 'YYYY-MM-DD') as d
        from documents
       where deleted_at is null and created_at >= ${start}
      union all
      select author_id as user_id,
             to_char(date_trunc('day', created_at) at time zone 'UTC', 'YYYY-MM-DD') as d
        from comments
       where deleted_at is null and created_at >= ${start}
      union all
      select user_id,
             to_char(date_trunc('day', viewed_at) at time zone 'UTC', 'YYYY-MM-DD') as d
        from document_views
       where viewed_at >= ${start}
    ) s
    group by d
  `;

  // ---- A3: cumulativeUsers ------------------------------------------------
  const usersByDay = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', created_at) at time zone 'UTC', 'YYYY-MM-DD') as d,
           count(*)::int as c
      from users
     where created_at >= ${start}
     group by 1
  `;
  const usersBefore = sql<{ c: number }[]>`
    select count(*)::int as c from users where created_at < ${start}
  `;

  const [docRows, verRows, comRows, actRows, userRows, beforeRows] = await Promise.all([
    db.execute(docsByDay),
    db.execute(versionsByDay),
    db.execute(commentsByDay),
    db.execute(activeByDay),
    db.execute(usersByDay),
    db.execute(usersBefore),
  ]);

  const docMap = new Map(docRows.map((r) => [r.d, r.c]));
  const verMap = new Map(verRows.map((r) => [r.d, r.c]));
  const comMap = new Map(comRows.map((r) => [r.d, r.c]));
  const actMap = new Map(actRows.map((r) => [r.d, r.c]));
  const userMap = new Map(userRows.map((r) => [r.d, r.c]));
  const seed = beforeRows[0]?.c ?? 0;

  const createdPerDay: DailyStackPoint[] = spine.map((date) => ({
    date,
    documents: docMap.get(date) ?? 0,
    versions: verMap.get(date) ?? 0,
    comments: comMap.get(date) ?? 0,
  }));

  const activeUsersPerDay = leftJoinDailyCounts(spine, actMap);

  let running = seed;
  const cumulativeUsers: DailyPoint[] = spine.map((date) => {
    running += userMap.get(date) ?? 0;
    return { date, value: running };
  });

  return { createdPerDay, activeUsersPerDay, cumulativeUsers };
}
```

NOTE: drizzle's `db.execute(sql<…>)` with a typed row generic returns the rows directly. If your installed drizzle wraps results in `{ rows: ... }`, adjust accordingly — read the type of `db.execute` in your local install once and apply consistently across all the block builders.

- [ ] **Step 4: Run typecheck**

Run: `pnpm --filter @primer/api typecheck`
Expected: PASS. If `db.execute` returns `{ rows }`, swap each `await db.execute(…)` for `(await db.execute(…)).rows` in this and subsequent tasks.

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @primer/api exec vitest run src/services/adminStats.test.ts`
Expected: PASS (all `buildAdoption` cases).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/adminStats.ts apps/api/src/services/adminStats.test.ts
git commit -m "feat(admin): buildAdoption — createdPerDay, activeUsers, cumulativeUsers"
```

---

### Task 5: Implement `buildEngagement` + tests

Three sub-blocks: `topDocumentsByViewers` (E1), `topCommenters` (E2), `viewersPerDocHistogram` (E3). E1/E2 are top-10 lists. E3 is bucketed in JS from per-document viewer counts.

**Files:**
- Modify: `apps/api/src/services/adminStats.ts`
- Modify: `apps/api/src/services/adminStats.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `apps/api/src/services/adminStats.test.ts`:

```ts
import { buildEngagement } from './adminStats.ts';

describe('buildEngagement', () => {
  const HIST_BUCKETS = ['0', '1-2', '3-5', '6-10', '11-25', '26+'];

  it('returns the six histogram buckets in canonical order, even when empty', async () => {
    const res = await buildEngagement();
    expect(res.viewersPerDocHistogram.map((b) => b.bucket)).toEqual(HIST_BUCKETS);
  });

  it('topDocumentsByViewers respects deleted_at and counts distinct viewers', async () => {
    const u1 = `t-${uuidv7()}`;
    const u2 = `t-${uuidv7()}`;
    const u3 = `t-${uuidv7()}`;
    const aliveDoc = uuidv7();
    const deadDoc = uuidv7();

    await db.insert(users).values([
      { id: u1, email: '1@p.t', displayName: '1' },
      { id: u2, email: '2@p.t', displayName: '2' },
      { id: u3, email: '3@p.t', displayName: '3' },
    ]);
    await db.insert(documents).values({ id: aliveDoc, title: 'Alive', uploaderId: u1 });
    await db.insert(documents).values({ id: deadDoc,  title: 'Dead',  uploaderId: u1, deletedAt: new Date() });

    // Alive doc: three distinct viewers. Dead doc: three viewers but soft-deleted.
    await db.insert(documentViews).values([
      { userId: u1, documentId: aliveDoc },
      { userId: u2, documentId: aliveDoc },
      { userId: u3, documentId: aliveDoc },
      { userId: u1, documentId: deadDoc },
      { userId: u2, documentId: deadDoc },
      { userId: u3, documentId: deadDoc },
    ]);

    const res = await buildEngagement();
    const found = res.topDocumentsByViewers.find((d) => d.documentId === aliveDoc);
    expect(found).toBeDefined();
    expect(found?.viewers).toBe(3);
    expect(res.topDocumentsByViewers.find((d) => d.documentId === deadDoc)).toBeUndefined();
    expect(res.topDocumentsByViewers.length).toBeLessThanOrEqual(10);
  });

  it('topCommenters is windowed to last 30d and excludes deleted comments', async () => {
    const userId = `t-${uuidv7()}`;
    const docId = uuidv7();
    const versionId = uuidv7();
    const threadId = uuidv7();

    await db.insert(users).values({ id: userId, email: 'c@p.t', displayName: 'Commenter' });
    await db.insert(documents).values({ id: docId, title: 'D', uploaderId: userId });
    await db.insert(versions).values({
      id: versionId, documentId: docId, versionNumber: 1,
      storageKey: `v1/${versionId}.html`, sizeBytes: 0, versionNote: null,
    });
    await db.insert(threads).values({
      id: threadId, versionId,
      anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
    });

    // 1 alive in-window comment, 1 deleted in-window comment, 1 old comment.
    await db.insert(comments).values({ id: uuidv7(), threadId, authorId: userId, body: 'kept' });
    await db.insert(comments).values({
      id: uuidv7(), threadId, authorId: userId, body: 'gone', deletedAt: new Date(),
    });
    await db.insert(comments).values({
      id: uuidv7(), threadId, authorId: userId, body: 'too old',
      createdAt: daysAgo(60),
    });

    const res = await buildEngagement();
    const me = res.topCommenters.find((c) => c.userId === userId);
    expect(me).toBeDefined();
    expect(me?.comments).toBe(1);
  });

  it('viewersPerDocHistogram includes documents with zero viewers in the 0 bucket', async () => {
    const u1 = `t-${uuidv7()}`;
    const u2 = `t-${uuidv7()}`;
    const docNoViews = uuidv7();
    const docTwoViews = uuidv7();

    await db.insert(users).values([
      { id: u1, email: '1@p.t', displayName: '1' },
      { id: u2, email: '2@p.t', displayName: '2' },
    ]);
    await db.insert(documents).values([
      { id: docNoViews, title: 'No Views', uploaderId: u1 },
      { id: docTwoViews, title: 'Two Views', uploaderId: u1 },
    ]);
    await db.insert(documentViews).values([
      { userId: u1, documentId: docTwoViews },
      { userId: u2, documentId: docTwoViews },
    ]);

    const res = await buildEngagement();
    const zero = res.viewersPerDocHistogram.find((b) => b.bucket === '0')!;
    const oneTwo = res.viewersPerDocHistogram.find((b) => b.bucket === '1-2')!;
    expect(zero.count).toBeGreaterThanOrEqual(1);
    expect(oneTwo.count).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @primer/api exec vitest run src/services/adminStats.test.ts -t buildEngagement`
Expected: FAIL.

- [ ] **Step 3: Implement `buildEngagement`**

Append to `apps/api/src/services/adminStats.ts`:

```ts
import type { AdminEngagementBlock, HistogramBucket } from '@primer/shared';

const HISTOGRAM_EDGES: { bucket: string; min: number; max: number }[] = [
  { bucket: '0',     min: 0,  max: 0   },
  { bucket: '1-2',   min: 1,  max: 2   },
  { bucket: '3-5',   min: 3,  max: 5   },
  { bucket: '6-10',  min: 6,  max: 10  },
  { bucket: '11-25', min: 11, max: 25  },
  { bucket: '26+',   min: 26, max: Infinity },
];

function bucketFor(n: number): string {
  for (const e of HISTOGRAM_EDGES) {
    if (n >= e.min && n <= e.max) return e.bucket;
  }
  return '26+';
}

export async function buildEngagement(db: Db = defaultDb): Promise<AdminEngagementBlock> {
  const since30d = sql`now() - interval '30 days'`;

  const topDocsQ = sql<{ document_id: string; title: string; viewers: number }[]>`
    select d.id as document_id, d.title, count(*)::int as viewers
      from document_views v
      join documents d on d.id = v.document_id
     where d.deleted_at is null
     group by d.id, d.title
     order by viewers desc
     limit 10
  `;
  const topCommentersQ = sql<{ user_id: string; display_name: string; comments: number }[]>`
    select c.author_id as user_id, u.display_name, count(*)::int as comments
      from comments c
      join users u on u.id = c.author_id
     where c.deleted_at is null
       and c.created_at >= ${since30d}
     group by c.author_id, u.display_name
     order by comments desc
     limit 10
  `;
  // Per-document viewer counts (LEFT JOIN so docs with zero viewers appear as 0).
  const perDocQ = sql<{ viewers: number }[]>`
    select coalesce(v.viewers, 0)::int as viewers
      from documents d
      left join (
        select document_id, count(*) as viewers
          from document_views
         group by document_id
      ) v on v.document_id = d.id
     where d.deleted_at is null
  `;

  const [topDocs, topCommenters, perDoc] = await Promise.all([
    db.execute(topDocsQ),
    db.execute(topCommentersQ),
    db.execute(perDocQ),
  ]);

  const histogramCounts = new Map<string, number>(
    HISTOGRAM_EDGES.map((e) => [e.bucket, 0]),
  );
  for (const row of perDoc) {
    const b = bucketFor(Number(row.viewers));
    histogramCounts.set(b, (histogramCounts.get(b) ?? 0) + 1);
  }
  const viewersPerDocHistogram: HistogramBucket[] = HISTOGRAM_EDGES.map((e) => ({
    bucket: e.bucket,
    count: histogramCounts.get(e.bucket) ?? 0,
  }));

  return {
    topDocumentsByViewers: topDocs.map((r) => ({
      documentId: r.document_id,
      title: r.title,
      viewers: Number(r.viewers),
    })),
    topCommenters: topCommenters.map((r) => ({
      userId: r.user_id,
      displayName: r.display_name,
      comments: Number(r.comments),
    })),
    viewersPerDocHistogram,
  };
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @primer/api exec vitest run src/services/adminStats.test.ts -t buildEngagement`
Expected: PASS.

- [ ] **Step 5: Run the full file**

Run: `pnpm --filter @primer/api exec vitest run src/services/adminStats.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/services/adminStats.ts apps/api/src/services/adminStats.test.ts
git commit -m "feat(admin): buildEngagement — top docs, top commenters, histogram"
```

---

### Task 6: Implement `buildOperational` + tests

Three sub-blocks: `storageBytesPerDay` cumulative (O1), `threadsOpenedVsResolved` per day (O2), `openThreadsAgingOver14d` (count + 30-day sparkline) (O3).

**Files:**
- Modify: `apps/api/src/services/adminStats.ts`
- Modify: `apps/api/src/services/adminStats.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `apps/api/src/services/adminStats.test.ts`:

```ts
import { buildOperational } from './adminStats.ts';

describe('buildOperational', () => {
  it('returns exactly 30 entries per series', async () => {
    const res = await buildOperational();
    expect(res.storageBytesPerDay).toHaveLength(30);
    expect(res.threadsOpenedVsResolved).toHaveLength(30);
    expect(res.openThreadsAgingOver14d.sparkline).toHaveLength(30);
  });

  it('storageBytesPerDay is monotonic non-decreasing and seeded by pre-window versions', async () => {
    const userId = `t-${uuidv7()}`;
    const docId = uuidv7();
    await db.insert(users).values({ id: userId, email: 's@p.t', displayName: 'S' });
    await db.insert(documents).values({ id: docId, title: 'S', uploaderId: userId });

    const preVersionId = uuidv7();
    await db.insert(versions).values({
      id: preVersionId, documentId: docId, versionNumber: 1,
      storageKey: `v1/${preVersionId}.html`, sizeBytes: 1_000_000, versionNote: null,
      createdAt: daysAgo(60),
    });
    const inWindowVersionId = uuidv7();
    await db.insert(versions).values({
      id: inWindowVersionId, documentId: docId, versionNumber: 2,
      storageKey: `v1/${inWindowVersionId}.html`, sizeBytes: 500_000, versionNote: null,
      createdAt: daysAgo(5),
    });

    const res = await buildOperational();
    for (let i = 1; i < res.storageBytesPerDay.length; i++) {
      expect(res.storageBytesPerDay[i].value).toBeGreaterThanOrEqual(res.storageBytesPerDay[i - 1].value);
    }
    expect(res.storageBytesPerDay[0].value).toBeGreaterThanOrEqual(1_000_000);
    expect(res.storageBytesPerDay[29].value).toBeGreaterThanOrEqual(1_500_000);
  });

  it('threadsOpenedVsResolved counts opens by created_at and resolves by resolved_at', async () => {
    const userId = `t-${uuidv7()}`;
    const docId = uuidv7();
    const versionId = uuidv7();
    await db.insert(users).values({ id: userId, email: 't@p.t', displayName: 'T' });
    await db.insert(documents).values({ id: docId, title: 'T', uploaderId: userId });
    await db.insert(versions).values({
      id: versionId, documentId: docId, versionNumber: 1,
      storageKey: `v1/${versionId}.html`, sizeBytes: 0, versionNote: null,
    });
    const threadOpenedDay = daysAgo(5);
    const threadResolvedDay = daysAgo(2);
    await db.insert(threads).values({
      id: uuidv7(), versionId,
      anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      createdAt: threadOpenedDay,
      resolvedAt: threadResolvedDay,
      resolvedBy: userId,
    });

    const res = await buildOperational();
    const opens = res.threadsOpenedVsResolved.reduce((s, p) => s + p.opened, 0);
    const resolves = res.threadsOpenedVsResolved.reduce((s, p) => s + p.resolved, 0);
    expect(opens).toBeGreaterThanOrEqual(1);
    expect(resolves).toBeGreaterThanOrEqual(1);
  });

  it('openThreadsAgingOver14d counts unresolved threads older than 14 days', async () => {
    const userId = `t-${uuidv7()}`;
    const docId = uuidv7();
    const versionId = uuidv7();
    await db.insert(users).values({ id: userId, email: 'a@p.t', displayName: 'A' });
    await db.insert(documents).values({ id: docId, title: 'A', uploaderId: userId });
    await db.insert(versions).values({
      id: versionId, documentId: docId, versionNumber: 1,
      storageKey: `v1/${versionId}.html`, sizeBytes: 0, versionNote: null,
    });
    // Aged & unresolved → counts.
    await db.insert(threads).values({
      id: uuidv7(), versionId,
      anchor: { type: 'text-range', selectorText: 'a', prefix: '', suffix: '', containerPath: 'body' },
      createdAt: daysAgo(20),
    });
    // Aged & resolved → does NOT count.
    await db.insert(threads).values({
      id: uuidv7(), versionId,
      anchor: { type: 'text-range', selectorText: 'b', prefix: '', suffix: '', containerPath: 'body' },
      createdAt: daysAgo(20),
      resolvedAt: daysAgo(1),
      resolvedBy: userId,
    });
    // Young & unresolved → does NOT count.
    await db.insert(threads).values({
      id: uuidv7(), versionId,
      anchor: { type: 'text-range', selectorText: 'c', prefix: '', suffix: '', containerPath: 'body' },
      createdAt: daysAgo(5),
    });

    const res = await buildOperational();
    expect(res.openThreadsAgingOver14d.count).toBeGreaterThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run — expect failure**

Run: `pnpm --filter @primer/api exec vitest run src/services/adminStats.test.ts -t buildOperational`
Expected: FAIL.

- [ ] **Step 3: Implement `buildOperational`**

Append to `apps/api/src/services/adminStats.ts`:

```ts
import type { AdminOperationalBlock, ThreadFlowPoint } from '@primer/shared';

export async function buildOperational(db: Db = defaultDb): Promise<AdminOperationalBlock> {
  const now = new Date();
  const start = windowStart(now, RANGE_DAYS);
  const spine = buildDateSpine(now, RANGE_DAYS);

  // ---- O1: storageBytesPerDay (cumulative) ---------------------------------
  const inWindowStorage = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', created_at) at time zone 'UTC', 'YYYY-MM-DD') as d,
           coalesce(sum(size_bytes), 0)::bigint::float8 as c
      from versions
     where created_at >= ${start}
     group by 1
  `;
  const preWindowStorage = sql<{ c: number }[]>`
    select coalesce(sum(size_bytes), 0)::bigint::float8 as c
      from versions
     where created_at < ${start}
  `;

  // ---- O2: threadsOpenedVsResolved ----------------------------------------
  const opensByDay = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', created_at) at time zone 'UTC', 'YYYY-MM-DD') as d,
           count(*)::int as c
      from threads
     where created_at >= ${start}
     group by 1
  `;
  const resolvesByDay = sql<{ d: string; c: number }[]>`
    select to_char(date_trunc('day', resolved_at) at time zone 'UTC', 'YYYY-MM-DD') as d,
           count(*)::int as c
      from threads
     where resolved_at >= ${start}
     group by 1
  `;

  // ---- O3: openThreadsAgingOver14d ----------------------------------------
  const agingCountQ = sql<{ c: number }[]>`
    select count(*)::int as c
      from threads
     where resolved_at is null
       and created_at < now() - interval '14 days'
  `;
  // Sparkline: for each day d in the spine, threads where created_at < (d - 14d)
  // AND (resolved_at is null OR resolved_at > d).
  const agingSparkQ = sql<{ d: string; c: number }[]>`
    with spine as (
      select to_char(d at time zone 'UTC', 'YYYY-MM-DD') as d, d as ts
        from generate_series(${start}::timestamptz, ${now}::timestamptz, '1 day'::interval) d
    )
    select s.d, count(t.*)::int as c
      from spine s
      left join threads t
        on t.created_at < s.ts - interval '14 days'
       and (t.resolved_at is null or t.resolved_at > s.ts)
     group by s.d
  `;

  const [stoRows, stoSeedRows, openRows, resRows, agingRows, sparkRows] = await Promise.all([
    db.execute(inWindowStorage),
    db.execute(preWindowStorage),
    db.execute(opensByDay),
    db.execute(resolvesByDay),
    db.execute(agingCountQ),
    db.execute(agingSparkQ),
  ]);

  const stoMap = new Map(stoRows.map((r) => [r.d, Number(r.c)]));
  const seed = Number(stoSeedRows[0]?.c ?? 0);
  let running = seed;
  const storageBytesPerDay: DailyPoint[] = spine.map((date) => {
    running += stoMap.get(date) ?? 0;
    return { date, value: running };
  });

  const openMap = new Map(openRows.map((r) => [r.d, r.c]));
  const resMap = new Map(resRows.map((r) => [r.d, r.c]));
  const threadsOpenedVsResolved: ThreadFlowPoint[] = spine.map((date) => ({
    date,
    opened: openMap.get(date) ?? 0,
    resolved: resMap.get(date) ?? 0,
  }));

  const sparkMap = new Map(sparkRows.map((r) => [r.d, r.c]));
  const sparkline = leftJoinDailyCounts(spine, sparkMap);

  return {
    storageBytesPerDay,
    threadsOpenedVsResolved,
    openThreadsAgingOver14d: {
      count: agingRows[0]?.c ?? 0,
      sparkline,
    },
  };
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @primer/api exec vitest run src/services/adminStats.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/services/adminStats.ts apps/api/src/services/adminStats.test.ts
git commit -m "feat(admin): buildOperational — storage, thread flow, aging threads"
```

---

### Task 7: Wire the builders into the admin route

Replace the inert empty blocks with real builder calls. Add an E2E shape assertion to the route test.

**Files:**
- Modify: `apps/api/src/routes/admin.ts`
- Modify: `apps/api/src/routes/admin.test.ts`

- [ ] **Step 1: Update the route**

Replace `apps/api/src/routes/admin.ts` with:

```ts
import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import type { AdminStatsResponse } from '@primer/shared';
import {
  buildTotals,
  buildAdoption,
  buildEngagement,
  buildOperational,
} from '../services/adminStats.ts';

export function registerAdminRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/admin/stats', async (c) => {
    const [totals, adoption, engagement, operational] = await Promise.all([
      buildTotals(),
      buildAdoption(),
      buildEngagement(),
      buildOperational(),
    ]);

    const body: AdminStatsResponse = {
      ...totals,
      rangeDays: 30,
      adoption,
      engagement,
      operational,
    };
    return c.json(body, 200);
  });
}
```

- [ ] **Step 2: Add an E2E shape assertion**

Append the following test case to `apps/api/src/routes/admin.test.ts`, inside the existing `describe('GET /api/admin/stats', …)`:

```ts
it('returns the expanded admin shape with 30-entry daily series and 6 histogram buckets', async () => {
  await withApp(async (app) => {
    const body = await snapshot(app);
    expect(body.rangeDays).toBe(30);
    expect(body.adoption.createdPerDay).toHaveLength(30);
    expect(body.adoption.activeUsersPerDay).toHaveLength(30);
    expect(body.adoption.cumulativeUsers).toHaveLength(30);
    expect(body.engagement.viewersPerDocHistogram).toHaveLength(6);
    expect(body.engagement.viewersPerDocHistogram.map((b) => b.bucket)).toEqual([
      '0', '1-2', '3-5', '6-10', '11-25', '26+',
    ]);
    expect(body.operational.storageBytesPerDay).toHaveLength(30);
    expect(body.operational.threadsOpenedVsResolved).toHaveLength(30);
    expect(body.operational.openThreadsAgingOver14d.sparkline).toHaveLength(30);
    // Spine is sorted ascending.
    for (let i = 1; i < body.adoption.createdPerDay.length; i++) {
      expect(body.adoption.createdPerDay[i].date >
        body.adoption.createdPerDay[i - 1].date).toBe(true);
    }
  });
});
```

- [ ] **Step 3: Run admin route tests**

Run: `pnpm --filter @primer/api exec vitest run src/routes/admin.test.ts`
Expected: PASS (5 tests, including the new one).

- [ ] **Step 4: Run the full API suite to catch regressions**

Run: `pnpm --filter @primer/api exec vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/admin.ts apps/api/src/routes/admin.test.ts
git commit -m "feat(admin): wire adoption/engagement/operational into /api/admin/stats"
```

---

### Task 8: Add `chartGeom.ts` pure helpers + tests (web)

The widgets share five pure helpers. Land them with tests before any SVG code so the widget code stays trivial.

**Files:**
- Create: `apps/web/src/components/admin/chartGeom.ts`
- Create: `apps/web/src/components/admin/chartGeom.test.ts`

- [ ] **Step 1: Make the directory**

```bash
mkdir -p apps/web/src/components/admin
```

- [ ] **Step 2: Write the failing test**

Create `apps/web/src/components/admin/chartGeom.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import {
  linearScale,
  niceTicks,
  formatTickDate,
  formatBytes,
  clamp,
} from './chartGeom.ts';

describe('linearScale', () => {
  it('maps domain endpoints to range endpoints', () => {
    const s = linearScale([0, 10], [0, 100]);
    expect(s(0)).toBe(0);
    expect(s(10)).toBe(100);
    expect(s(5)).toBe(50);
  });

  it('handles inverted ranges (e.g. y-axis going top-to-bottom)', () => {
    const s = linearScale([0, 100], [200, 0]);
    expect(s(0)).toBe(200);
    expect(s(100)).toBe(0);
    expect(s(50)).toBe(100);
  });

  it('returns the range midpoint for a zero-width domain', () => {
    const s = linearScale([5, 5], [0, 100]);
    expect(s(5)).toBe(50);
  });
});

describe('niceTicks', () => {
  it('returns the requested count of evenly-spaced ticks', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 25, 50, 75, 100]);
  });

  it('handles flat ranges by collapsing to a single tick at the value', () => {
    expect(niceTicks(7, 7, 5)).toEqual([7]);
  });
});

describe('formatTickDate', () => {
  it('renders YYYY-MM-DD as "Mon D"', () => {
    expect(formatTickDate('2026-06-19')).toBe('Jun 19');
    expect(formatTickDate('2026-01-03')).toBe('Jan 3');
  });
});

describe('formatBytes', () => {
  it('uses B/KB/MB/GB with one decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1_500)).toBe('1.5 KB');
    expect(formatBytes(2_500_000)).toBe('2.5 MB');
    expect(formatBytes(3_700_000_000)).toBe('3.7 GB');
  });
});

describe('clamp', () => {
  it('clamps to the given range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
```

- [ ] **Step 3: Run — expect failure**

Run: `pnpm --filter @primer/web exec vitest run src/components/admin/chartGeom.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 4: Implement the helpers**

Create `apps/web/src/components/admin/chartGeom.ts`:

```ts
export function linearScale(
  domain: [number, number],
  range: [number, number],
): (x: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (d0 === d1) {
    const mid = (r0 + r1) / 2;
    return () => mid;
  }
  const slope = (r1 - r0) / (d1 - d0);
  return (x) => r0 + (x - d0) * slope;
}

export function niceTicks(min: number, max: number, count: number): number[] {
  if (min === max) return [min];
  const step = (max - min) / (count - 1);
  const ticks: number[] = [];
  for (let i = 0; i < count; i++) {
    ticks.push(min + i * step);
  }
  return ticks;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function formatTickDate(yyyymmdd: string): string {
  const [, m, d] = yyyymmdd.split('-');
  return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

export function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}
```

NOTE: the `formatBytes` test uses base-10 expected values (1_500 → "1.5 KB") which only matches with base-1024 if we use base-1000 here. To make the test pass as written, change the divisors to powers of 1000 (`/ 1000`, `/ 1_000_000`, etc.). Pick one (1000 vs 1024) and adjust both the test and the helper to agree before committing. Recommendation: base 1000, since the tests describe "1.5 KB" for 1500 bytes.

- [ ] **Step 5: Resolve the base 1000 vs 1024 choice and re-run**

Choose base 1000 (`/ 1_000`, `/ 1_000_000`, `/ 1_000_000_000`). Update the implementation accordingly. Re-run:

Run: `pnpm --filter @primer/web exec vitest run src/components/admin/chartGeom.test.ts`
Expected: PASS.

- [ ] **Step 6: Run web typecheck**

Run: `pnpm --filter @primer/web typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/admin/chartGeom.ts apps/web/src/components/admin/chartGeom.test.ts
git commit -m "feat(admin): chartGeom pure helpers + tests"
```

---

### Task 9: Extract `StatCard` into its own file (refactor)

Move the existing `StatCard` and `SkeletonCard` definitions out of `routes/admin.tsx` into the new `components/admin/` directory. No behavior change.

**Files:**
- Create: `apps/web/src/components/admin/StatCard.tsx`
- Modify: `apps/web/src/routes/admin.tsx`

- [ ] **Step 1: Create the file**

Create `apps/web/src/components/admin/StatCard.tsx`:

```tsx
import type { AdminStatsBucket } from '@primer/shared';

interface StatCardProps {
  label: string;
  bucket: AdminStatsBucket;
}

export function StatCard({ label, bucket }: StatCardProps) {
  const deltaClass = bucket.last7d > 0
    ? 'text-neutral-500'
    : 'text-neutral-400 dark:text-neutral-500';
  return (
    <div className="rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="text-xs uppercase tracking-wider text-neutral-600 dark:text-neutral-400">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-neutral-900 dark:text-neutral-100">
        {bucket.total.toLocaleString()}
      </div>
      <div className={`mt-1 text-xs ${deltaClass}`}>
        +{bucket.last7d.toLocaleString()} this week
      </div>
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="h-3 w-20 rounded bg-neutral-200 dark:bg-neutral-700" />
      <div className="mt-2 h-8 w-16 rounded bg-neutral-200 dark:bg-neutral-700" />
      <div className="mt-2 h-3 w-24 rounded bg-neutral-200 dark:bg-neutral-700" />
    </div>
  );
}
```

- [ ] **Step 2: Update `routes/admin.tsx` to import**

Open `apps/web/src/routes/admin.tsx`. Remove the local `StatCard` and `SkeletonCard` function definitions (lines 5-33 in the file as of branch base) plus the now-unused `StatCardProps` interface. Replace with an import at the top:

```tsx
import { StatCard, SkeletonCard } from '../components/admin/StatCard.tsx';
```

Leave the rest of the file unchanged for now (Task 15 rewrites it).

- [ ] **Step 3: Run typecheck and the dev server smoke test**

Run: `pnpm --filter @primer/web typecheck`
Expected: PASS.

Run: `pnpm --filter @primer/web exec vitest run`
Expected: PASS (no admin component tests yet; chartGeom tests should still pass).

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/admin/StatCard.tsx apps/web/src/routes/admin.tsx
git commit -m "refactor(admin): move StatCard into components/admin"
```

---

### Task 10: `AreaChart` component (A1)

Stacked area for `createdPerDay`. Three series stacked in order: comments (bottom), versions (middle), documents (top).

**Files:**
- Create: `apps/web/src/components/admin/AreaChart.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/admin/AreaChart.tsx`:

```tsx
import type { DailyStackPoint } from '@primer/shared';
import { linearScale, niceTicks, formatTickDate } from './chartGeom.ts';

interface Props {
  data: DailyStackPoint[];
  height?: number;
}

const PAD = { top: 8, right: 8, bottom: 22, left: 32 };
const WIDTH = 600;
const SERIES = [
  { key: 'comments' as const, className: 'fill-blue-300 dark:fill-blue-900' },
  { key: 'versions' as const, className: 'fill-blue-400 dark:fill-blue-800' },
  { key: 'documents' as const, className: 'fill-blue-500 dark:fill-blue-700' },
];

export function AreaChart({ data, height = 200 }: Props) {
  const totals = data.map((p) => p.documents + p.versions + p.comments);
  const yMax = Math.max(1, ...totals);
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  const x = linearScale([0, Math.max(1, data.length - 1)], [PAD.left, PAD.left + innerW]);
  const y = linearScale([0, yMax], [PAD.top + innerH, PAD.top]);

  if (data.length === 0) {
    return <EmptyChart width={WIDTH} height={height} />;
  }

  // Cumulative offsets for stacked areas: comments first (closest to baseline).
  const stacks = data.map((p) => {
    const a = p.comments;
    const b = a + p.versions;
    const c = b + p.documents;
    return [0, a, b, c];
  });

  const polygons = SERIES.map((s, seriesIdx) => {
    const top = data.map((_p, i) => `${x(i)},${y(stacks[i][seriesIdx + 1])}`).join(' ');
    const bottom = data.map((_p, i) => `${x(i)},${y(stacks[i][seriesIdx])}`).reverse().join(' ');
    return <polygon key={s.key} className={s.className} points={`${top} ${bottom}`} />;
  });

  const yTicks = niceTicks(0, yMax, 4);
  const xTickIndices = [0, Math.floor(data.length / 2), data.length - 1];

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full" role="img" aria-label="Daily content created">
      {polygons}
      {yTicks.map((t, i) => (
        <text key={i} x={PAD.left - 4} y={y(t)} textAnchor="end" dominantBaseline="middle"
              className="text-[10px] fill-neutral-500 dark:fill-neutral-400">
          {Math.round(t)}
        </text>
      ))}
      {xTickIndices.map((i) => (
        <text key={i} x={x(i)} y={height - 6} textAnchor="middle"
              className="text-[10px] fill-neutral-500 dark:fill-neutral-400">
          {formatTickDate(data[i].date)}
        </text>
      ))}
    </svg>
  );
}

export function EmptyChart({ width, height }: { width: number; height: number }) {
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="No data">
      <text x={width / 2} y={height / 2} textAnchor="middle" dominantBaseline="middle"
            className="text-xs fill-neutral-400 dark:fill-neutral-500">
        No data yet
      </text>
    </svg>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @primer/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/admin/AreaChart.tsx
git commit -m "feat(admin): AreaChart component (stacked area)"
```

---

### Task 11: `LineChart` component (A2 / A3 / O1)

Single-series line chart with optional y-axis value formatter (for O1's storage bytes).

**Files:**
- Create: `apps/web/src/components/admin/LineChart.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/admin/LineChart.tsx`:

```tsx
import type { DailyPoint } from '@primer/shared';
import { linearScale, niceTicks, formatTickDate } from './chartGeom.ts';
import { EmptyChart } from './AreaChart.tsx';

interface Props {
  data: DailyPoint[];
  height?: number;
  formatY?: (n: number) => string;
  ariaLabel?: string;
}

const PAD = { top: 8, right: 8, bottom: 22, left: 44 };
const WIDTH = 600;

export function LineChart({ data, height = 200, formatY, ariaLabel }: Props) {
  if (data.length === 0) {
    return <EmptyChart width={WIDTH} height={height} />;
  }

  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const yMax = Math.max(1, ...data.map((p) => p.value));
  const x = linearScale([0, Math.max(1, data.length - 1)], [PAD.left, PAD.left + innerW]);
  const y = linearScale([0, yMax], [PAD.top + innerH, PAD.top]);

  const points = data.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');

  const yTicks = niceTicks(0, yMax, 4);
  const xTickIndices = [0, Math.floor(data.length / 2), data.length - 1];

  const fmt = formatY ?? ((n: number) => String(Math.round(n)));

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full" role="img" aria-label={ariaLabel}>
      <polyline points={points} className="fill-none stroke-blue-500 dark:stroke-blue-400" strokeWidth="2" />
      {yTicks.map((t, i) => (
        <text key={i} x={PAD.left - 4} y={y(t)} textAnchor="end" dominantBaseline="middle"
              className="text-[10px] fill-neutral-500 dark:fill-neutral-400">
          {fmt(t)}
        </text>
      ))}
      {xTickIndices.map((i) => (
        <text key={i} x={x(i)} y={height - 6} textAnchor="middle"
              className="text-[10px] fill-neutral-500 dark:fill-neutral-400">
          {formatTickDate(data[i].date)}
        </text>
      ))}
    </svg>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @primer/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/admin/LineChart.tsx
git commit -m "feat(admin): LineChart component (single-series line)"
```

---

### Task 12: `BarList` component (E1 / E2)

Horizontal labeled bar list. Used for top documents (E1) and top commenters (E2).

**Files:**
- Create: `apps/web/src/components/admin/BarList.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/admin/BarList.tsx`:

```tsx
interface BarItem {
  key: string;        // stable React key
  label: string;      // visible label
  value: number;
}

interface Props {
  items: BarItem[];
  formatValue?: (n: number) => string;
  emptyText?: string;
}

export function BarList({ items, formatValue, emptyText = 'No activity in this window.' }: Props) {
  if (items.length === 0) {
    return (
      <p className="text-sm text-neutral-500 dark:text-neutral-400">{emptyText}</p>
    );
  }
  const max = Math.max(1, ...items.map((i) => i.value));
  const fmt = formatValue ?? ((n: number) => n.toLocaleString());
  return (
    <ul className="space-y-1.5">
      {items.map((item) => {
        const pct = (item.value / max) * 100;
        return (
          <li key={item.key} className="grid grid-cols-[1fr_auto] items-center gap-2">
            <div className="relative h-6 overflow-hidden rounded bg-neutral-100 dark:bg-neutral-800">
              <div
                className="absolute inset-y-0 left-0 bg-blue-200 dark:bg-blue-900"
                style={{ width: `${pct}%` }}
              />
              <div className="relative z-10 truncate px-2 py-0.5 text-xs text-neutral-900 dark:text-neutral-100">
                {item.label}
              </div>
            </div>
            <span className="text-xs tabular-nums text-neutral-600 dark:text-neutral-300">
              {fmt(item.value)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @primer/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/admin/BarList.tsx
git commit -m "feat(admin): BarList component (top-N horizontal bars)"
```

---

### Task 13: `Histogram` component (E3)

Vertical bars with bucket labels.

**Files:**
- Create: `apps/web/src/components/admin/Histogram.tsx`

- [ ] **Step 1: Write the component**

Create `apps/web/src/components/admin/Histogram.tsx`:

```tsx
import type { HistogramBucket } from '@primer/shared';

interface Props {
  buckets: HistogramBucket[];
  height?: number;
}

const WIDTH = 600;
const PAD = { top: 8, right: 8, bottom: 28, left: 8 };

export function Histogram({ buckets, height = 200 }: Props) {
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const max = Math.max(1, ...buckets.map((b) => b.count));
  const barW = innerW / Math.max(1, buckets.length);

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full" role="img" aria-label="Viewers per document distribution">
      {buckets.map((b, i) => {
        const x = PAD.left + i * barW;
        const h = max === 0 ? 0 : (b.count / max) * innerH;
        const y = PAD.top + innerH - h;
        return (
          <g key={b.bucket}>
            <rect
              x={x + 6}
              y={y}
              width={barW - 12}
              height={Math.max(0, h)}
              className="fill-blue-500 dark:fill-blue-400"
            />
            <text
              x={x + barW / 2}
              y={height - 14}
              textAnchor="middle"
              className="text-[10px] fill-neutral-500 dark:fill-neutral-400"
            >
              {b.bucket}
            </text>
            <text
              x={x + barW / 2}
              y={height - 2}
              textAnchor="middle"
              className="text-[10px] fill-neutral-700 dark:fill-neutral-200"
            >
              {b.count}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `pnpm --filter @primer/web typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/components/admin/Histogram.tsx
git commit -m "feat(admin): Histogram component (vertical bars + bucket labels)"
```

---

### Task 14: `StackedBar` and `Sparkline` components (O2, O3)

Two small SVG widgets.

**Files:**
- Create: `apps/web/src/components/admin/StackedBar.tsx`
- Create: `apps/web/src/components/admin/Sparkline.tsx`

- [ ] **Step 1: Write `StackedBar`**

Create `apps/web/src/components/admin/StackedBar.tsx`:

```tsx
import type { ThreadFlowPoint } from '@primer/shared';
import { linearScale, formatTickDate, niceTicks } from './chartGeom.ts';
import { EmptyChart } from './AreaChart.tsx';

interface Props {
  data: ThreadFlowPoint[];
  height?: number;
}

const WIDTH = 600;
const PAD = { top: 8, right: 8, bottom: 22, left: 32 };

export function StackedBar({ data, height = 200 }: Props) {
  if (data.length === 0) {
    return <EmptyChart width={WIDTH} height={height} />;
  }
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;
  const max = Math.max(1, ...data.map((p) => p.opened + p.resolved));
  const x = linearScale([0, Math.max(1, data.length - 1)], [PAD.left, PAD.left + innerW]);
  const y = linearScale([0, max], [PAD.top + innerH, PAD.top]);
  const barW = innerW / data.length * 0.6;

  const yTicks = niceTicks(0, max, 4);
  const xTickIndices = [0, Math.floor(data.length / 2), data.length - 1];

  return (
    <svg viewBox={`0 0 ${WIDTH} ${height}`} className="w-full" role="img" aria-label="Threads opened and resolved per day">
      {data.map((p, i) => {
        const cx = x(i);
        const openedH = (innerH * p.opened) / max;
        const resolvedH = (innerH * p.resolved) / max;
        const openedY = y(p.opened);
        const resolvedY = openedY - resolvedH;
        return (
          <g key={p.date}>
            <rect
              x={cx - barW / 2}
              y={openedY}
              width={barW}
              height={openedH}
              className="fill-amber-400 dark:fill-amber-700"
            />
            <rect
              x={cx - barW / 2}
              y={resolvedY}
              width={barW}
              height={resolvedH}
              className="fill-emerald-500 dark:fill-emerald-700"
            />
          </g>
        );
      })}
      {yTicks.map((t, i) => (
        <text key={i} x={PAD.left - 4} y={y(t)} textAnchor="end" dominantBaseline="middle"
              className="text-[10px] fill-neutral-500 dark:fill-neutral-400">
          {Math.round(t)}
        </text>
      ))}
      {xTickIndices.map((i) => (
        <text key={i} x={x(i)} y={height - 6} textAnchor="middle"
              className="text-[10px] fill-neutral-500 dark:fill-neutral-400">
          {formatTickDate(data[i].date)}
        </text>
      ))}
    </svg>
  );
}
```

- [ ] **Step 2: Write `Sparkline`**

Create `apps/web/src/components/admin/Sparkline.tsx`:

```tsx
import type { DailyPoint } from '@primer/shared';
import { linearScale } from './chartGeom.ts';

interface Props {
  data: DailyPoint[];
  width?: number;
  height?: number;
}

export function Sparkline({ data, width = 120, height = 32 }: Props) {
  if (data.length === 0) {
    return <svg viewBox={`0 0 ${width} ${height}`} className="w-full" />;
  }
  const max = Math.max(1, ...data.map((p) => p.value));
  const x = linearScale([0, Math.max(1, data.length - 1)], [0, width]);
  const y = linearScale([0, max], [height - 2, 2]);
  const points = data.map((p, i) => `${x(i)},${y(p.value)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full" role="img" aria-label="Aging threads trend">
      <polyline points={points} className="fill-none stroke-amber-500 dark:stroke-amber-400" strokeWidth="1.5" />
    </svg>
  );
}
```

- [ ] **Step 3: Run typecheck**

Run: `pnpm --filter @primer/web typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/components/admin/StackedBar.tsx apps/web/src/components/admin/Sparkline.tsx
git commit -m "feat(admin): StackedBar + Sparkline components"
```

---

### Task 15: Rewrite `AdminPage` to render the three sections

Wire everything together. Keep the existing 6 stat cards at the top, then Adoption / Engagement / Operational sections.

**Files:**
- Modify: `apps/web/src/routes/admin.tsx`

- [ ] **Step 1: Replace the page**

Replace `apps/web/src/routes/admin.tsx` entirely with:

```tsx
import { useAdminStats } from '../queries/admin.ts';
import type { AdminStatsResponse } from '@primer/shared';
import { DesktopOnly } from '../components/DesktopOnly.tsx';
import { StatCard, SkeletonCard } from '../components/admin/StatCard.tsx';
import { AreaChart } from '../components/admin/AreaChart.tsx';
import { LineChart } from '../components/admin/LineChart.tsx';
import { BarList } from '../components/admin/BarList.tsx';
import { Histogram } from '../components/admin/Histogram.tsx';
import { StackedBar } from '../components/admin/StackedBar.tsx';
import { Sparkline } from '../components/admin/Sparkline.tsx';
import { formatBytes } from '../components/admin/chartGeom.ts';

const METRICS: { key: keyof AdminStatsResponse; label: string }[] = [
  { key: 'users',         label: 'Users' },
  { key: 'documents',     label: 'Documents' },
  { key: 'versions',      label: 'Versions' },
  { key: 'threads',       label: 'Threads' },
  { key: 'comments',      label: 'Comments' },
  { key: 'documentViews', label: 'Document views' },
];

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <h3 className="mb-3 text-sm font-medium text-neutral-700 dark:text-neutral-300">{title}</h3>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
      {children}
    </section>
  );
}

export function AdminPage() {
  const q = useAdminStats();

  return (
    <DesktopOnly>
      <div className="mx-auto max-w-[1100px] space-y-6">
        <header className="border-b border-neutral-200 pb-3 dark:border-neutral-800">
          <h1 className="text-2xl font-semibold">Admin</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Primer usage over the last 30 days. Read-only.
          </p>
        </header>

        {q.error && (
          <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
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

        {/* Top-line cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {q.isLoading || !q.data
            ? METRICS.map((m) => <SkeletonCard key={m.key} />)
            : METRICS.map((m) => (
                <StatCard key={m.key} label={m.label} bucket={q.data[m.key]} />
              ))}
        </div>

        {q.data && (
          <>
            <Section title="Adoption">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Card title="Content created per day">
                  <AreaChart data={q.data.adoption.createdPerDay} />
                </Card>
                <Card title="Daily active users">
                  <LineChart
                    data={q.data.adoption.activeUsersPerDay}
                    ariaLabel="Daily active users"
                  />
                </Card>
                <Card title="Cumulative users">
                  <LineChart
                    data={q.data.adoption.cumulativeUsers}
                    ariaLabel="Cumulative users"
                  />
                </Card>
              </div>
            </Section>

            <Section title="Engagement">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Card title="Top 10 documents by viewers">
                  <BarList
                    items={q.data.engagement.topDocumentsByViewers.map((d) => ({
                      key: d.documentId,
                      label: d.title,
                      value: d.viewers,
                    }))}
                  />
                </Card>
                <Card title="Top 10 commenters (last 30d)">
                  <BarList
                    items={q.data.engagement.topCommenters.map((c) => ({
                      key: c.userId,
                      label: c.displayName,
                      value: c.comments,
                    }))}
                  />
                </Card>
                <div className="md:col-span-2">
                  <Card title="Distribution: viewers per document">
                    <Histogram buckets={q.data.engagement.viewersPerDocHistogram} />
                  </Card>
                </div>
              </div>
            </Section>

            <Section title="Operational">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Card title="Storage used (cumulative)">
                  <LineChart
                    data={q.data.operational.storageBytesPerDay}
                    ariaLabel="Storage used"
                    formatY={formatBytes}
                  />
                </Card>
                <Card title="Threads opened vs resolved">
                  <StackedBar data={q.data.operational.threadsOpenedVsResolved} />
                </Card>
                <div className="md:col-span-2">
                  <Card title="Open threads aging > 14 days">
                    <div className="flex items-center gap-4">
                      <div className="text-4xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
                        {q.data.operational.openThreadsAgingOver14d.count.toLocaleString()}
                      </div>
                      <div className="flex-1">
                        <Sparkline data={q.data.operational.openThreadsAgingOver14d.sparkline} />
                      </div>
                    </div>
                  </Card>
                </div>
              </div>
            </Section>
          </>
        )}
      </div>
    </DesktopOnly>
  );
}
```

- [ ] **Step 2: Bump React Query `staleTime` to 60s**

Open `apps/web/src/queries/admin.ts` and change `staleTime: 30_000` to `staleTime: 60_000`. Resulting file:

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
    staleTime: 60_000,
  });
}
```

- [ ] **Step 3: Run web typecheck**

Run: `pnpm --filter @primer/web typecheck`
Expected: PASS.

- [ ] **Step 4: Run the full web test suite**

Run: `pnpm --filter @primer/web exec vitest run`
Expected: PASS (chartGeom tests + any pre-existing).

- [ ] **Step 5: Smoke-test in the browser**

Start the API and web dev servers (the standard local dev workflow for this repo — `pnpm dev` from root, or whatever script invokes Hono + Vite together). Open `http://localhost:5173/admin` and verify:

1. Top-line stat cards still render with the same numbers as before.
2. Three new sections appear underneath (Adoption / Engagement / Operational).
3. All 9 widgets render — even on a near-empty DB, every chart shows axes and either data or "No data yet".
4. Dark mode toggle still works correctly across the new widgets.
5. The error banner appears if you stop the API and click Retry.

If the dev workflow isn't obvious from the repo's README/CLAUDE.md, stop and ask before guessing — the local-dev story for this codebase has specifics around NixOS and pnpm that aren't worth blundering through.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/admin.tsx apps/web/src/queries/admin.ts
git commit -m "feat(admin): three-section dashboard with charts"
```

---

## Spec-coverage check

| Spec requirement                                         | Implemented in |
|----------------------------------------------------------|----------------|
| `AdminStatsResponse` keeps 6 existing buckets            | Task 1 |
| `rangeDays: 30` literal                                  | Task 1, 2, 7 |
| `adoption.createdPerDay` (A1) — 30 entries, stacked       | Task 4 |
| `adoption.activeUsersPerDay` (A2)                        | Task 4 |
| `adoption.cumulativeUsers` (A3) — seeded                 | Task 4 |
| `engagement.topDocumentsByViewers` (E1) — top 10, alive  | Task 5 |
| `engagement.topCommenters` (E2) — top 10, 30d, alive     | Task 5 |
| `engagement.viewersPerDocHistogram` (E3) — 6 buckets     | Task 5 |
| `operational.storageBytesPerDay` (O1) — cumulative       | Task 6 |
| `operational.threadsOpenedVsResolved` (O2)               | Task 6 |
| `operational.openThreadsAgingOver14d` (O3) + sparkline   | Task 6 |
| All daily series exactly 30 entries, oldest→newest, UTC  | Tasks 3, 4, 6, 7 |
| `services/adminStats.ts` module hosting all builders     | Tasks 2, 4, 5, 6 |
| `chartGeom.ts` pure helpers + unit tests                 | Task 8 |
| `components/admin/` directory of small widgets           | Tasks 9–14 |
| Layout: cards + three sections, max-w ~1100px            | Task 15 |
| Loading / error / empty states                           | Tasks 10–14 (per widget) + Task 15 (page) |
| `staleTime: 60_000`                                      | Task 15 |
| Distinct-viewers semantics for E1/E3                     | Tasks 1, 5 |

## Known follow-ups (out of scope)

- The smoke test in Task 15 step 5 is the only manual verification on the web side. If we ever add Playwright, the admin page is a candidate for an empty-DB visual test.
- `document_views` as an event log (the "B" option) remains a real future option if we later want true view-rate analytics.
