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
import { users, documents, documentCollaborators, documentFolders } from '@primer/shared/schema';
import type { Notifier } from '../notifications/notifier.ts';
import type { FolderDTO } from '@primer/shared/api';
import { asUser, asUserJson } from '../test/harness.ts';
import { uploadFixture } from './upload.testlib.ts';

class NullNotifier implements Notifier {
  readonly emailEnabled = false;
  async notifyComment() {}
  async notifyCollaboratorAdded() {}
  async notifyExternalOtp() {}
  async notifyExternalFirstView() {}
}

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-docfolder-'));
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

describe('PUT /api/documents/:docId/folder', () => {
  it('assigns caller\'s folder to a doc they own (204)', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const folderId = await makeFolder(app, 'mock-user-1', 'Research');
      const res = await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId }),
      });
      expect(res.status).toBe(204);

      const rows = await db.select().from(documentFolders).where(eq(documentFolders.userId, 'mock-user-1'));
      expect(rows).toHaveLength(1);
      expect(rows[0].folderId).toBe(folderId);
      expect(rows[0].documentId).toBe(upload.documentId);
    });
  });

  it('re-assigns via UPSERT (single-home invariant)', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const first = await makeFolder(app, 'mock-user-1', 'Research');
      const second = await makeFolder(app, 'mock-user-1', 'Q3 planning');
      await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId: first }),
      });
      const res = await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId: second }),
      });
      expect(res.status).toBe(204);
      const rows = await db.select().from(documentFolders).where(eq(documentFolders.userId, 'mock-user-1'));
      expect(rows).toHaveLength(1);
      expect(rows[0].folderId).toBe(second);
    });
  });

  it('unassigns when folderId is null', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const folderId = await makeFolder(app, 'mock-user-1', 'Research');
      await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId }),
      });
      const res = await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId: null }),
      });
      expect(res.status).toBe(204);
      const rows = await db.select().from(documentFolders).where(eq(documentFolders.userId, 'mock-user-1'));
      expect(rows).toHaveLength(0);
    });
  });

  it('403 when the folder belongs to a different user', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const otherFolder = await makeFolder(app, 'mock-user-2', 'Their folder');
      const res = await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId: otherFolder }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('404 when caller cannot read the doc (private, not owner, not collaborator)', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const folderId = await makeFolder(app, 'mock-user-2', 'Research');
      const res = await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ folderId }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('works for a collaborator on a private doc', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const [{ id: collabId }] = await db
        .insert(documentCollaborators)
        .values({
          id: uuidv7(),
          documentId: upload.documentId,
          userId: 'mock-user-2',
          role: 'commenter',
          grantedBy: 'mock-user-1',
        })
        .returning({ id: documentCollaborators.id });
      expect(collabId).toBeTruthy();
      const folderId = await makeFolder(app, 'mock-user-2', 'Research');
      const res = await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ folderId }),
      });
      expect(res.status).toBe(204);
    });
  });

  it('folder assignment persists across soft-delete + restore', async () => {
    await withApp(async (app) => {
      const upload = await uploadFixture(app);
      const folderId = await makeFolder(app, 'mock-user-1', 'Research');
      await app.request(`/api/documents/${upload.documentId}/folder`, {
        method: 'PUT',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ folderId }),
      });
      // soft-delete
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, upload.documentId));
      // restore
      await db
        .update(documents)
        .set({ deletedAt: null })
        .where(eq(documents.id, upload.documentId));
      const rows = await db.select().from(documentFolders).where(eq(documentFolders.userId, 'mock-user-1'));
      expect(rows).toHaveLength(1);
      expect(rows[0].folderId).toBe(folderId);
    });
  });
});
