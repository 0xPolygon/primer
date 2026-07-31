import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { ARTIFACT_CSP } from './versionContent.ts';
import { db } from '../db/client.ts';
import { documents, versions as versionsTable, users, documentCollaborators } from '../db/schema.ts';
import { CSRF_HEADERS, asUser } from '../test/harness.ts';

async function upload(app: ReturnType<typeof createApp>): Promise<string> {
  const fd = new FormData();
  fd.append(
    'file',
    new Blob(['<html><body><h1>Sample</h1></body></html>'], { type: 'text/html' }),
    'r.html'
  );
  fd.append('title', 'Sample');
  const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
  const body = (await res.json()) as { versionId: string };
  return body.versionId;
}

describe('GET /api/versions/:versionId/content', () => {
  it('serves the stored HTML with the locked CSP, frame-ancestors, and content-type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-vc-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const versionId = await upload(app);

      const res = await app.request(`/api/versions/${versionId}/content`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8');
      expect(res.headers.get('content-security-policy')).toBe(ARTIFACT_CSP);
      expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');

      const html = await res.text();
      expect(html).toContain('<h1>Sample</h1>');
      expect(html).toContain('<script src="/companion/v1.js"');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 for an unknown version id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-vc-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const res = await app.request('/api/versions/01234567-89ab-cdef-0123-456789abcdef/content');
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 for a version whose document has been soft-deleted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-vc-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const versionId = await upload(app);

      // Look up the document id via the version row, then soft-delete it.
      const [vRow] = await db
        .select({ documentId: versionsTable.documentId })
        .from(versionsTable)
        .where(eq(versionsTable.id, versionId));
      await db
        .update(documents)
        .set({ deletedAt: new Date() })
        .where(eq(documents.id, vRow.documentId));

      const res = await app.request(`/api/versions/${versionId}/content`);
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

// helper reusing the same multi-user pattern as documents.test.ts
async function withMultiUserApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-vc-multi-'));
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

describe('GET /api/versions/:versionId/content under visibility + collab', () => {
  it('private doc + non-collab: 404', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versionsTable.id }).from(versionsTable).where(eq(versionsTable.documentId, upload.documentId));
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      const res = await app.request(`/api/versions/${v.id}/content`, {
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(404);
    });
  });

  it('private doc + commenter collab: 200', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app);
      const [v] = await db.select({ id: versionsTable.id }).from(versionsTable).where(eq(versionsTable.documentId, upload.documentId));
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, upload.documentId));
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'commenter',
        grantedBy: 'mock-user-1',
      });
      const res = await app.request(`/api/versions/${v.id}/content`, {
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(200);
    });
  });
});
