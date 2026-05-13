import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
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
      const app = createApp({ storage: new FilesystemStorage(root) });
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
      const app = createApp({ storage: new FilesystemStorage(root) });
      const res = await app.request('/api/documents/01234567-89ab-cdef-0123-456789abcdef');
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
