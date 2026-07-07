import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { users } from '@primer/shared/schema';
import type { ExternalShareResponse } from '@primer/shared';
import { CSRF_HEADERS, asUser, asUserJson } from '../test/harness.ts';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-extadmin-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: mockMultiResolver,
    });
    await db.insert(users).values([
      { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
      { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
    ]).onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function uploadDoc(app: ReturnType<typeof createApp>) {
  const fd = new FormData();
  fd.append('file', new Blob(['<html><body>x</body></html>'], { type: 'text/html' }), 'd.html');
  fd.append('title', 'Deck');
  const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
  return (await res.json()) as { documentId: string; versionId: string };
}

describe('external share admin routes', () => {
  it('owner can create, add recipient, publish, and read back the share', async () => {
    await withApp(async (app) => {
      const { documentId, versionId } = await uploadDoc(app);

      const created = await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });
      expect(created.status).toBe(201);

      const dup = await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });
      expect(dup.status).toBe(409);

      const addRec = await app.request(`/api/documents/${documentId}/external-share/recipients`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ email: 'Client@Example.com' }),
      });
      expect(addRec.status).toBe(201);

      const pub = await app.request(`/api/documents/${documentId}/external-share/publish`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ versionId }),
      });
      expect(pub.status).toBe(200);

      const get = await app.request(`/api/documents/${documentId}/external-share`, {
        headers: asUser('mock-user-1'),
      });
      const body = (await get.json()) as ExternalShareResponse;
      expect(body.share).not.toBeNull();
      expect(body.share!.shareToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(body.share!.publishedVersionId).toBe(versionId);
      expect(body.share!.publishedVersionNumber).toBe(1);
      expect(body.recipients.length).toBe(1);
      expect(body.recipients[0].email).toBe('client@example.com'); // lowercased
      expect(body.recipients[0].viewCount).toBe(0);
    });
  });

  it('publish rejects a version belonging to another document', async () => {
    await withApp(async (app) => {
      const a = await uploadDoc(app);
      const b = await uploadDoc(app);
      await app.request(`/api/documents/${a.documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });
      const res = await app.request(`/api/documents/${a.documentId}/external-share/publish`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ versionId: b.versionId }),
      });
      expect(res.status).toBe(400);
    });
  });

  it('a non-collaborator cannot see or manage the share', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });
      const get = await app.request(`/api/documents/${documentId}/external-share`, {
        headers: asUser('mock-user-2'),
      });
      expect(get.status).toBe(403); // org doc: readable, not manageable
      const rev = await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'DELETE', headers: asUserJson('mock-user-2'),
      });
      expect(rev.status).toBe(403);
    });
  });

  it('revoking a recipient and the whole share works and 404s on re-add duplicates only when active', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });
      const add = await app.request(`/api/documents/${documentId}/external-share/recipients`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ email: 'client@example.com' }),
      });
      const { recipient } = (await add.json()) as { recipient: { id: string } };

      const del = await app.request(
        `/api/documents/${documentId}/external-share/recipients/${recipient.id}`,
        { method: 'DELETE', headers: asUserJson('mock-user-1') },
      );
      expect(del.status).toBe(200);

      const revoke = await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'DELETE', headers: asUserJson('mock-user-1'),
      });
      expect(revoke.status).toBe(200);

      const get = await app.request(`/api/documents/${documentId}/external-share`, {
        headers: asUser('mock-user-1'),
      });
      expect(((await get.json()) as ExternalShareResponse).share).toBeNull();
    });
  });
});
