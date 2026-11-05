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
import { documents, versions, users, documentCollaborators } from '../db/schema.ts';
import type { VersionSummaryDTO } from '@polygonlabs/primer-api-types';
import { CSRF_HEADERS, asUser, asUserJson } from '../test/harness.ts';

async function seedDocAndVersion(uploaderId: string = 'mock-user-1') {
  const documentId = uuidv7();
  const versionId = uuidv7();
  await db.insert(documents).values({
    id: documentId,
    title: 'Seed',
    description: null,
    uploaderId,
  });
  await db.insert(versions).values({
    id: versionId,
    documentId,
    versionNumber: 1,
    storageKey: `v1/${versionId}.html`,
    sizeBytes: 0,
    versionNote: 'initial',
  });
  return { documentId, versionId };
}

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-versions-test-'));
  try {
    const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('PATCH /api/versions/:vid', () => {
  it('updates version note when called by uploader of parent doc', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocAndVersion();
      const res = await app.request(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ versionNote: 'fixed Y-axis scale' }),
      });
      expect(res.status).toBe(200);
      const out = (await res.json()) as VersionSummaryDTO;
      expect(out.versionNote).toBe('fixed Y-axis scale');
    });
  });

  it('clears note when versionNote is null', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocAndVersion();
      const res = await app.request(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ versionNote: null }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as VersionSummaryDTO).versionNote).toBeNull();
    });
  });

  it('normalizes empty string to null', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocAndVersion();
      const res = await app.request(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ versionNote: '   ' }),
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as VersionSummaryDTO).versionNote).toBeNull();
    });
  });

  it('returns 403 when caller is not the parent doc uploader', async () => {
    await withApp(async (app) => {
      const otherUserId = 'other-user-vn';
      await db.insert(users).values({ id: otherUserId, email: 'ovn@p.t', displayName: 'OtherVN' }).onConflictDoNothing();
      const { versionId } = await seedDocAndVersion(otherUserId);

      const res = await app.request(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ versionNote: 'sneaky' }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('returns 404 when parent doc is soft-deleted', async () => {
    await withApp(async (app) => {
      const { documentId, versionId } = await seedDocAndVersion();
      await db.update(documents).set({ deletedAt: new Date() }).where(eq(documents.id, documentId));

      const res = await app.request(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ versionNote: 'cant' }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('returns 400 when note exceeds 500 chars', async () => {
    await withApp(async (app) => {
      const { versionId } = await seedDocAndVersion();
      const res = await app.request(`/api/versions/${versionId}`, {
        method: 'PATCH',
        headers: { ...CSRF_HEADERS, 'content-type': 'application/json' },
        body: JSON.stringify({ versionNote: 'x'.repeat(501) }),
      });
      expect(res.status).toBe(400);
    });
  });
});

// helper reusing the same multi-user pattern as documents.test.ts
async function withMultiUserApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-versions-multi-'));
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

async function uploadFixture(app: ReturnType<typeof createApp>) {
  const fd = new FormData();
  fd.append('file', new Blob(['<html><body><p>x</p></body></html>'], { type: 'text/html' }), 'r.html');
  fd.append('title', 'Fixture');
  const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
  return (await res.json()) as { documentId: string; versionId: string };
}

describe('PATCH /api/versions/:versionId under visibility + collab', () => {
  it('editor collab can edit version note', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/versions/${v.id}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ versionNote: 'from editor' }),
      });
      expect(res.status).toBe(200);
    });
  });

  it('responder collab cannot edit version note', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'responder',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/versions/${v.id}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ versionNote: 'nope' }),
      });
      expect(res.status).toBe(403);
    });
  });

  it('commenter collab cannot edit version note', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versions.id }).from(versions).where(eq(versions.documentId, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/versions/${v.id}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ versionNote: 'nope' }),
      });
      expect(res.status).toBe(403);
    });
  });
});
