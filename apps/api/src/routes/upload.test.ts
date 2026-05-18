import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { db } from '../db/client.ts';
import { documents, versions } from '@primer/shared/schema';
import type { UploadResponse } from '@primer/shared/api';
import { CSRF_HEADERS } from '../test/harness.ts';

async function withTmpStorage<T>(
  fn: (storage: FilesystemStorage, root: string) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-upload-test-'));
  try {
    return await fn(new FilesystemStorage(root), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function buildFormData(html: string, title: string, description?: string): FormData {
  const fd = new FormData();
  fd.append('file', new Blob([html], { type: 'text/html' }), 'report.html');
  fd.append('title', title);
  if (description) fd.append('description', description);
  return fd;
}

describe('POST /api/upload — happy path', () => {
  it('persists doc + version and stores the transformed HTML', async () => {
    await withTmpStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const fd = buildFormData(
        '<html><body><h1>Hi</h1><iframe src="x"></iframe></body></html>',
        'My Report'
      );

      const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
      expect(res.status).toBe(200);
      const body = (await res.json()) as UploadResponse;
      expect(body.url).toBe(`/d/${body.documentId}`);

      const docRows = await db.select().from(documents).where(eq(documents.id, body.documentId));
      expect(docRows).toHaveLength(1);
      expect(docRows[0]).toMatchObject({
        title: 'My Report',
        uploaderId: 'mock-user-1',
      });

      const versionRows = await db.select().from(versions).where(eq(versions.id, body.versionId));
      expect(versionRows).toHaveLength(1);
      expect(versionRows[0]).toMatchObject({
        documentId: body.documentId,
        versionNumber: 1,
      });

      const stream = await storage.get(versionRows[0].storageKey);
      const reader = stream.getReader();
      let combined = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        combined += new TextDecoder().decode(value);
      }
      expect(combined).toContain('<h1>Hi</h1>');
      expect(combined).not.toContain('<iframe');
      expect(combined).toContain('<script src="/companion/v1.js"');
    });
  });
});

describe('POST /api/upload — error paths', () => {
  it('rejects oversize file with too_large', async () => {
    await withTmpStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const big = 'x'.repeat(10 * 1024 * 1024 + 1);
      const fd = buildFormData(big, 't');
      const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'too_large' });
    });
  });

  it('rejects missing title', async () => {
    await withTmpStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const fd = buildFormData('<html></html>', '   ');
      const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'missing_title' });
    });
  });

  it('rejects bad extension', async () => {
    await withTmpStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const fd = new FormData();
      fd.append('file', new Blob(['<html></html>'], { type: 'text/html' }), 'report.txt');
      fd.append('title', 't');
      const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_extension' });
    });
  });

  it('rejects bad content-type', async () => {
    await withTmpStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const fd = new FormData();
      fd.append('file', new Blob(['<html></html>'], { type: 'application/pdf' }), 'r.html');
      fd.append('title', 't');
      const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'bad_content_type' });
    });
  });

  it('rejects missing file', async () => {
    await withTmpStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const fd = new FormData();
      fd.append('title', 't');
      const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'missing_file' });
    });
  });

  it('rejects empty (unparseable) HTML', async () => {
    await withTmpStorage(async (storage) => {
      const app = createApp({ storage, notifier: new NoopNotifier() });
      const fd = buildFormData('', 't');
      const res = await app.request('/api/upload', { method: 'POST', headers: CSRF_HEADERS, body: fd });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: 'parse_failed' });
    });
  });
});
