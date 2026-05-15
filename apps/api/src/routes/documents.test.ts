import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { db } from '../db/client.ts';
import { documentViews } from '@primer/shared/schema';
import type { DocumentDetailResponse, UploadResponse } from '@primer/shared/api';

async function uploadFixture(app: ReturnType<typeof createApp>): Promise<UploadResponse> {
  const fd = new FormData();
  fd.append('file', new Blob(['<html><body><p>x</p></body></html>'], { type: 'text/html' }), 'r.html');
  fd.append('title', 'Fixture');
  fd.append('description', 'desc');
  const res = await app.request('/api/upload', { method: 'POST', body: fd });
  return (await res.json()) as UploadResponse;
}

describe('GET /api/documents/:docId', () => {
  it('returns document + latest version summaries', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-docread-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const res = await app.request(`/api/documents/${upload.documentId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as DocumentDetailResponse;

      expect(body.document.id).toBe(upload.documentId);
      expect(body.document.title).toBe('Fixture');
      expect(body.document.description).toBe('desc');
      expect(body.document.uploaderDisplayName).toBe('Mock User');
      expect(body.latestVersion.id).toBe(upload.versionId);
      expect(body.latestVersion.versionNumber).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 for an unknown id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-docread-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const res = await app.request('/api/documents/01234567-89ab-cdef-0123-456789abcdef');
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('GET /api/documents/:docId — view tracking', () => {
  it('upserts document_views on every hit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-docview-test-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const upload = await uploadFixture(app);

      const r1 = await app.request(`/api/documents/${upload.documentId}`);
      expect(r1.status).toBe(200);
      const rows1 = await db
        .select()
        .from(documentViews)
        .where(eq(documentViews.documentId, upload.documentId));
      expect(rows1).toHaveLength(1);
      const firstViewedAt = rows1[0].viewedAt;

      await new Promise((r) => setTimeout(r, 50));
      const r2 = await app.request(`/api/documents/${upload.documentId}`);
      expect(r2.status).toBe(200);
      const rows2 = await db
        .select()
        .from(documentViews)
        .where(eq(documentViews.documentId, upload.documentId));
      expect(rows2).toHaveLength(1);
      expect(rows2[0].viewedAt.getTime()).toBeGreaterThan(firstViewedAt.getTime());
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
