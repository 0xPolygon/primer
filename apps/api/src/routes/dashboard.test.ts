import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { documents, versions, threads, comments, documentViews, users, documentCollaborators } from '@primer/shared/schema';
import type { DashboardResponse } from '@primer/shared';
import { asUser } from '../test/harness.ts';
import { uploadFixture } from './upload.testlib.ts';
import { mockMultiResolver } from '../auth/resolver.ts';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-dashboard-test-'));
  try {
    const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withMultiUserApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-dashboard-multiuser-test-'));
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
      // Wait a tick so b is genuinely later.
      await new Promise((r) => setTimeout(r, 10));
      const b = await seedDoc('mock-user-1', 'B doc');
      await db.insert(threads).values({
        id: uuidv7(),
        versionId: b.versionId,
        anchor: { type: 'text-range', selectorText: 'x', prefix: '', suffix: '', containerPath: 'body' },
      });

      const res = await app.request('/api/dashboard');
      const body = (await res.json()) as DashboardResponse;
      expect(body.myDocuments).toHaveLength(2);
      // b has a thread → newer activity than a.
      expect(body.myDocuments[0].id).toBe(b.documentId);
      expect(body.myDocuments[1].id).toBe(a.documentId);
      expect(body.myDocuments[0].threadCount).toBe(1);
      expect(body.myDocuments[0].activeThreadCount).toBe(1);
    });
  });

  it("lists another user's viewed doc in recentlyViewedOrCommented with viewed signal", async () => {
    await withApp(async (app) => {
      const otherUserId = 'other-user-dash';
      await db
        .insert(users)
        .values({ id: otherUserId, email: 'o@p.t', displayName: 'Other' })
        .onConflictDoNothing();
      const o = await seedDoc(otherUserId, 'Other Doc');
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
      await db
        .insert(users)
        .values({ id: otherUserId, email: 'o2@p.t', displayName: 'Other2' })
        .onConflictDoNothing();
      const o = await seedDoc(otherUserId, 'Their Doc');
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
      await db
        .insert(users)
        .values({ id: otherUserId, email: 'o3@p.t', displayName: 'Other3' })
        .onConflictDoNothing();
      const o = await seedDoc(otherUserId, 'Both signals');
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

describe('GET /api/dashboard — recentlyDeleted', () => {
  it('lists my soft-deleted docs within 30 days', async () => {
    await withApp(async (app) => {
      const d1 = await seedDoc('mock-user-1', 'Recently deleted A');
      await db.update(documents).set({ deletedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) }).where(eq(documents.id, d1.documentId));

      const res = await app.request('/api/dashboard');
      const body = (await res.json()) as DashboardResponse;
      expect(body.recentlyDeleted).toHaveLength(1);
      expect(body.recentlyDeleted[0].id).toBe(d1.documentId);
      expect(body.recentlyDeleted[0].title).toBe('Recently deleted A');
      expect(body.recentlyDeleted[0].daysRemaining).toBeGreaterThan(20);
      expect(body.recentlyDeleted[0].daysRemaining).toBeLessThanOrEqual(25);
    });
  });

  it('excludes my soft-deleted docs older than 30 days', async () => {
    await withApp(async (app) => {
      const d1 = await seedDoc('mock-user-1', 'Old delete');
      await db.update(documents).set({ deletedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000) }).where(eq(documents.id, d1.documentId));

      const res = await app.request('/api/dashboard');
      const body = (await res.json()) as DashboardResponse;
      expect(body.recentlyDeleted).toHaveLength(0);
    });
  });

  it("does not include other users' soft-deleted docs", async () => {
    await withApp(async (app) => {
      const otherUserId = 'other-user-recently-deleted';
      await db.insert(users).values({ id: otherUserId, email: 'ord@p.t', displayName: 'OtherRD' }).onConflictDoNothing();
      const d = await seedDoc(otherUserId, 'Their delete');
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, d.documentId));

      const res = await app.request('/api/dashboard');
      const body = (await res.json()) as DashboardResponse;
      expect(body.recentlyDeleted.find((e) => e.id === d.documentId)).toBeUndefined();
    });
  });

  it("excludes soft-deleted docs from myDocuments", async () => {
    await withApp(async (app) => {
      const d = await seedDoc('mock-user-1', 'Soft deleted');
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, d.documentId));

      const res = await app.request('/api/dashboard');
      const body = (await res.json()) as DashboardResponse;
      expect(body.myDocuments.find((m) => m.id === d.documentId)).toBeUndefined();
    });
  });
});

describe('dashboard filters private docs the user cannot read', () => {
  async function uploadFixtureAsUser1(app: ReturnType<typeof createApp>): Promise<{ documentId: string; versionId: string }> {
    const fd = new FormData();
    fd.append('file', new Blob(['<html><body><h1>fixture</h1></body></html>'], { type: 'text/html' }), 'fixture.html');
    fd.append('title', 'Fixture doc');
    const res = await app.request('/api/upload', {
      method: 'POST',
      headers: { ...asUser('mock-user-1'), 'x-primer-csrf': '1' },
      body: fd,
    });
    if (!res.ok) throw new Error(`uploadFixture failed: ${res.status}`);
    return (await res.json()) as { documentId: string; versionId: string };
  }

  it('excludes private docs from "Recently viewed or commented" for non-collab', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixtureAsUser1(app);          // owned by mock-user-1
      // mock-user-2 views the doc while it's still org-visible
      const viewRes = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-2'),
      });
      expect(viewRes.status).toBe(200);
      // owner flips to private
      await db.update(documents)
        .set({ visibility: 'private' })
        .where(eq(documents.id, upload.documentId));

      const res = await app.request('/api/dashboard', { headers: asUser('mock-user-2') });
      const body = (await res.json()) as { recentlyViewedOrCommented: Array<{ id: string }> };
      expect(body.recentlyViewedOrCommented.find((r) => r.id === upload.documentId)).toBeUndefined();
    });
  });

  it('includes private docs where the user has a collab row', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixtureAsUser1(app);
      const viewRes = await app.request(`/api/documents/${upload.documentId}`, {
        headers: asUser('mock-user-2'),
      });
      expect(viewRes.status).toBe(200);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request('/api/dashboard', { headers: asUser('mock-user-2') });
      const body = (await res.json()) as { recentlyViewedOrCommented: Array<{ id: string }> };
      expect(body.recentlyViewedOrCommented.find((r) => r.id === upload.documentId)).toBeDefined();
    });
  });
});
