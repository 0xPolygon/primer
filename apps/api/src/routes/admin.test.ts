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
});
