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
import { documents, documentCollaborators, users, versions } from '@primer/shared/schema';
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

  it('POST /api/threads/:tid/resolve by non-owner → 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db
        .select({ id: versions.id })
        .from(versions)
        .where(eq(versions.documentId, upload.documentId));
      const createRes = await app.request(`/api/versions/${v.id}/threads`, {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({
          anchor: {
            type: 'text-range',
            selectorText: 'x',
            prefix: '',
            suffix: '',
            containerPath: 'body',
          },
          body: 'hello',
        }),
      });
      expect(createRes.status).toBe(201);
      const { id: threadId } = (await createRes.json()) as { id: string };

      const res = await app.request(`/api/threads/${threadId}/resolve`, {
        method: 'POST',
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(403);
    });
  });

  it('POST /api/threads/:tid/reopen by non-owner → 403', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db
        .select({ id: versions.id })
        .from(versions)
        .where(eq(versions.documentId, upload.documentId));
      const createRes = await app.request(`/api/versions/${v.id}/threads`, {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({
          anchor: {
            type: 'text-range',
            selectorText: 'x',
            prefix: '',
            suffix: '',
            containerPath: 'body',
          },
          body: 'hello',
        }),
      });
      expect(createRes.status).toBe(201);
      const { id: threadId } = (await createRes.json()) as { id: string };

      // Resolve as the owner first so reopen has something to do.
      const resolveRes = await app.request(`/api/threads/${threadId}/resolve`, {
        method: 'POST',
        headers: asUser('mock-user-1'),
      });
      expect(resolveRes.status).toBe(200);

      const res = await app.request(`/api/threads/${threadId}/reopen`, {
        method: 'POST',
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(403);
    });
  });
});

describe('collaborators × visibility — end-to-end', () => {
  it('editor can add a version to a private doc; commenter cannot; stranger 404s', async () => {
    await withMultiUserApp(async (app) => {
      // owner = mock-user-1 uploads
      const upload = await uploadFixture(app);
      // add mock-user-2 as editor, seed a third user as commenter, leave a fourth as stranger
      await db.insert(users).values([
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'User Three' },
        { id: 'mock-user-4', email: 'four@p.t', displayName: 'User Four' },
      ]).onConflictDoNothing();
      await db.insert(documentCollaborators).values([
        {
          id: uuidv7(),
          documentId: upload.documentId,
          userId: 'mock-user-2',
          role: 'editor',
          grantedBy: 'mock-user-1',
        },
        {
          id: uuidv7(),
          documentId: upload.documentId,
          userId: 'mock-user-3',
          role: 'commenter',
          grantedBy: 'mock-user-1',
        },
      ]);
      await db.update(documents)
        .set({ visibility: 'private' })
        .where(eq(documents.id, upload.documentId));

      // editor: can read + add version
      const readAsEditor = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-2'),
      });
      expect(readAsEditor.status).toBe(200);

      const fd = new FormData();
      fd.append('file', new Blob(['<html><body><h1>v2</h1></body></html>'], { type: 'text/html' }), 'v.html');
      const addAsEditor = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: asUser('mock-user-2'),
        body: fd,
      });
      expect(addAsEditor.status).toBe(201);

      // commenter: can read but cannot add a version
      const readAsCommenter = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-3'),
      });
      expect(readAsCommenter.status).toBe(200);

      const fd2 = new FormData();
      fd2.append('file', new Blob(['<html><body></body></html>'], { type: 'text/html' }), 'v.html');
      const addAsCommenter = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: asUser('mock-user-3'),
        body: fd2,
      });
      expect(addAsCommenter.status).toBe(403);

      // stranger: 404 on read, 404 on write
      const readAsStranger = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-4'),
      });
      expect(readAsStranger.status).toBe(404);

      const fd3 = new FormData();
      fd3.append('file', new Blob(['<html><body></body></html>'], { type: 'text/html' }), 'v.html');
      const addAsStranger = await app.request(`/api/documents/${upload.documentId}/versions`, {
        method: 'POST',
        headers: asUser('mock-user-4'),
        body: fd3,
      });
      expect(addAsStranger.status).toBe(404);
    });
  });

  it('GET /api/documents/:id reports the viewer effective role as myRole', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.insert(users).values([
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'User Three' },
      ]).onConflictDoNothing();

      // org visibility: a non-collaborator can read but is a stranger
      const asStranger = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-2'),
      });
      expect(asStranger.status).toBe(200);
      expect(((await asStranger.json()) as { myRole?: string }).myRole).toBe('stranger');

      await db.insert(documentCollaborators).values([
        {
          id: uuidv7(),
          documentId: upload.documentId,
          userId: 'mock-user-2',
          role: 'editor',
          grantedBy: 'mock-user-1',
        },
        {
          id: uuidv7(),
          documentId: upload.documentId,
          userId: 'mock-user-3',
          role: 'commenter',
          grantedBy: 'mock-user-1',
        },
      ]);
      await db.update(documents)
        .set({ visibility: 'private' })
        .where(eq(documents.id, upload.documentId));

      const asOwner = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-1'),
      });
      expect(asOwner.status).toBe(200);
      expect(((await asOwner.json()) as { myRole?: string }).myRole).toBe('owner');

      const asEditor = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-2'),
      });
      expect(asEditor.status).toBe(200);
      expect(((await asEditor.json()) as { myRole?: string }).myRole).toBe('editor');

      const asCommenter = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-3'),
      });
      expect(asCommenter.status).toBe(200);
      expect(((await asCommenter.json()) as { myRole?: string }).myRole).toBe('commenter');
    });
  });
});
