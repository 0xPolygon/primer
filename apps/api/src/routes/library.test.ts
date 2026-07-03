import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { users, documents, documentCollaborators } from '@primer/shared/schema';
import type { Notifier } from '../notifications/notifier.ts';
import type { LibraryResponse, FolderDTO } from '@primer/shared/api';
import { asUser, asUserJson } from '../test/harness.ts';
import { uploadFixture } from './upload.testlib.ts';

class NullNotifier implements Notifier {
  async notifyComment() {}
  async notifyCollaboratorAdded() {}
}

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-library-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NullNotifier(),
      userResolver: mockMultiResolver,
    });
    await db
      .insert(users)
      .values([
        { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
      ])
      .onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function makeFolder(app: ReturnType<typeof createApp>, userId: string, name: string): Promise<string> {
  const res = await app.request('/api/folders', {
    method: 'POST',
    headers: asUserJson(userId),
    body: JSON.stringify({ name }),
  });
  return ((await res.json()) as FolderDTO).id;
}

async function assignFolder(app: ReturnType<typeof createApp>, userId: string, docId: string, folderId: string | null) {
  await app.request(`/api/documents/${docId}/folder`, {
    method: 'PUT',
    headers: asUserJson(userId),
    body: JSON.stringify({ folderId }),
  });
}

describe('GET /api/library', () => {
  it('returns docs the caller uploaded', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request('/api/library', { headers: asUser('mock-user-1') });
      expect(res.status).toBe(200);
      const body = (await res.json()) as LibraryResponse;
      const mine = body.documents.find((d) => d.id === upload.documentId);
      expect(mine).toBeDefined();
      expect(mine?.ownership).toBe('mine');
      expect(mine?.folderId).toBeNull();
    });
  });

  it('org docs are visible with ownership=org to other users', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const res = await app.request('/api/library', { headers: asUser('mock-user-2') });
      const body = (await res.json()) as LibraryResponse;
      const other = body.documents.find((d) => d.id === upload.documentId);
      expect(other).toBeDefined();
      expect(other?.ownership).toBe('org');
    });
  });

  it('private doc: hidden from strangers, visible with ownership=collaborator to collaborators', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));

      const strangerRes = await app.request('/api/library', { headers: asUser('mock-user-2') });
      const strangerBody = (await strangerRes.json()) as LibraryResponse;
      expect(strangerBody.documents.find((d) => d.id === upload.documentId)).toBeUndefined();

      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const collabRes = await app.request('/api/library', { headers: asUser('mock-user-2') });
      const collabBody = (await collabRes.json()) as LibraryResponse;
      const found = collabBody.documents.find((d) => d.id === upload.documentId);
      expect(found?.ownership).toBe('collaborator');
    });
  });

  it("folderId reflects only the caller's assignment (no leakage)", async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const folderA = await makeFolder(app, 'mock-user-1', 'Research');
      await assignFolder(app, 'mock-user-1', upload.documentId, folderA);

      const bodyA = (await (await app.request('/api/library', { headers: asUser('mock-user-1') })).json()) as LibraryResponse;
      expect(bodyA.documents.find((d) => d.id === upload.documentId)?.folderId).toBe(folderA);

      const bodyB = (await (await app.request('/api/library', { headers: asUser('mock-user-2') })).json()) as LibraryResponse;
      expect(bodyB.documents.find((d) => d.id === upload.documentId)?.folderId).toBeNull();
      expect(bodyB.folders).toEqual([]);
    });
  });

  it('folders[].docCount reflects caller assignments only', async () => {
    await withApp(async (app) => {
      const up1 = await uploadFixture(app);
      const up2 = await uploadFixture(app);
      const folderId = await makeFolder(app, 'mock-user-1', 'Research');
      await assignFolder(app, 'mock-user-1', up1.documentId, folderId);
      await assignFolder(app, 'mock-user-1', up2.documentId, folderId);

      const body = (await (await app.request('/api/library', { headers: asUser('mock-user-1') })).json()) as LibraryResponse;
      const f = body.folders.find((x) => x.id === folderId);
      expect(f?.docCount).toBe(2);
    });
  });

  it("recentlyDeleted returns only caller's own soft-deleted docs", async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, upload.documentId));

      const mine = (await (await app.request('/api/library', { headers: asUser('mock-user-1') })).json()) as LibraryResponse;
      expect(mine.recentlyDeleted.find((d) => d.id === upload.documentId)).toBeDefined();

      const other = (await (await app.request('/api/library', { headers: asUser('mock-user-2') })).json()) as LibraryResponse;
      expect(other.recentlyDeleted.find((d) => d.id === upload.documentId)).toBeUndefined();
    });
  });

  it('soft-deleted docs are excluded from `documents`', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, upload.documentId));
      const body = (await (await app.request('/api/library', { headers: asUser('mock-user-1') })).json()) as LibraryResponse;
      expect(body.documents.find((d) => d.id === upload.documentId)).toBeUndefined();
    });
  });
});
