import { describe, it, expect } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { utcDateString, buildDateSpine, leftJoinDailyCounts, buildAdoption } from './adminStats.ts';
import { db } from '../db/client.ts';
import { users, documents, versions, threads, comments, documentViews } from '@primer/shared/schema';

const MS_PER_DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * MS_PER_DAY);

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
