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
import { documents, versions, threads, comments, users } from '@primer/shared/schema';
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

  it('returns 404 for an unknown threadId', async () => {
    await withApp(async (app) => {
      const fakeId = uuidv7();
      const res = await app.request(`/api/threads/${fakeId}/comments`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ body: 'orphan reply' }),
      });
      expect(res.status).toBe(404);
    });
  });
});

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
      const cm = (await res.json()) as CommentDTO;
      expect(cm.body).toBe('edited body');
      expect(cm.updatedAt).not.toBeNull();
    });
  });

  it('returns 403 when called by non-author', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const otherUserId = 'other-user-test';
      await db.insert(users).values({ id: otherUserId, email: 'o@p.t', displayName: 'Other' }).onConflictDoNothing();
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
      const cm = (await res.json()) as CommentDTO;
      expect(cm.body).toBe('');
      expect(cm.deletedAt).not.toBeNull();

      const stillThere = await db.select().from(comments).where(eq(comments.id, firstCommentId));
      expect(stillThere).toHaveLength(1);
      expect(stillThere[0].body).toBe('first');
    });
  });

  it('returns 403 when called by non-author', async () => {
    await withApp(async (app) => {
      const { threadId } = await seedDocVersionThread();
      const otherUserId = 'other-user-test-2';
      await db.insert(users).values({ id: otherUserId, email: 'o2@p.t', displayName: 'Other2' }).onConflictDoNothing();
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
