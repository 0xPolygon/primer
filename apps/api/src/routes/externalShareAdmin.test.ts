import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import { users, externalViews } from '@primer/shared/schema';
import type { ExternalShareResponse, ExternalShareViewsResponse } from '@primer/shared';
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

  it('rejects emails with empty local part or domain', async () => {
    await withApp(async (app) => {
      const { documentId } = await uploadDoc(app);
      await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });

      const emptyLocal = await app.request(`/api/documents/${documentId}/external-share/recipients`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ email: '@foo.com' }),
      });
      expect(emptyLocal.status).toBe(400);

      const emptyDomain = await app.request(`/api/documents/${documentId}/external-share/recipients`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ email: 'foo@' }),
      });
      expect(emptyDomain.status).toBe(400);

      const validEmail = await app.request(`/api/documents/${documentId}/external-share/recipients`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ email: 'ok@example.com' }),
      });
      expect(validEmail.status).toBe(201);
    });
  });

  describe('GET /external-share/views', () => {
    async function setupShareWithViews(app: ReturnType<typeof createApp>) {
      const { documentId, versionId } = await uploadDoc(app);
      await app.request(`/api/documents/${documentId}/external-share`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
      });
      const addA = await app.request(`/api/documents/${documentId}/external-share/recipients`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ email: 'alice@client.com' }),
      });
      const addB = await app.request(`/api/documents/${documentId}/external-share/recipients`, {
        method: 'POST', headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ email: 'bob@client.com' }),
      });
      const { recipient: alice } = (await addA.json()) as { recipient: { id: string } };
      const { recipient: bob } = (await addB.json()) as { recipient: { id: string } };
      // Insert audit rows directly with controlled timestamps (oldest first).
      const base = Date.parse('2026-07-08T10:00:00Z');
      await db.insert(externalViews).values([
        { id: uuidv7(), recipientId: alice.id, versionId, viewedAt: new Date(base) },
        { id: uuidv7(), recipientId: bob.id, versionId, viewedAt: new Date(base + 60_000) },
        { id: uuidv7(), recipientId: alice.id, versionId, viewedAt: new Date(base + 120_000) },
      ]);
      return { documentId, versionId, alice, bob };
    }

    it('returns the whole-share log newest-first with email and version joins', async () => {
      await withApp(async (app) => {
        const { documentId } = await setupShareWithViews(app);
        const res = await app.request(`/api/documents/${documentId}/external-share/views`, {
          headers: asUser('mock-user-1'),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as ExternalShareViewsResponse;
        expect(body.total).toBe(3);
        expect(body.views.map((v) => v.email)).toEqual([
          'alice@client.com', 'bob@client.com', 'alice@client.com',
        ]);
        expect(body.views.every((v) => v.versionNumber === 1)).toBe(true);
        const times = body.views.map((v) => Date.parse(v.viewedAt));
        expect(times[0]).toBeGreaterThan(times[1]);
        expect(times[1]).toBeGreaterThan(times[2]);
      });
    });

    it('keeps a revoked recipient\'s historical views in the log', async () => {
      await withApp(async (app) => {
        const { documentId, bob } = await setupShareWithViews(app);
        const del = await app.request(
          `/api/documents/${documentId}/external-share/recipients/${bob.id}`,
          { method: 'DELETE', headers: asUserJson('mock-user-1') },
        );
        expect(del.status).toBe(200);
        const res = await app.request(`/api/documents/${documentId}/external-share/views`, {
          headers: asUser('mock-user-1'),
        });
        const body = (await res.json()) as ExternalShareViewsResponse;
        expect(body.total).toBe(3);
        expect(body.views.some((v) => v.email === 'bob@client.com')).toBe(true);
      });
    });

    it('gates like the other admin routes: 403 for non-managers, 404 without an active share', async () => {
      await withApp(async (app) => {
        const { documentId } = await setupShareWithViews(app);
        const forbidden = await app.request(`/api/documents/${documentId}/external-share/views`, {
          headers: asUser('mock-user-2'),
        });
        expect(forbidden.status).toBe(403);

        const { documentId: unshared } = await uploadDoc(app);
        const noShare = await app.request(`/api/documents/${unshared}/external-share/views`, {
          headers: asUser('mock-user-1'),
        });
        expect(noShare.status).toBe(404);
      });
    });
  });
});
