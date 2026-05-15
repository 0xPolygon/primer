import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { ARTIFACT_CSP } from './versionContent.ts';

async function upload(app: ReturnType<typeof createApp>): Promise<string> {
  const fd = new FormData();
  fd.append(
    'file',
    new Blob(['<html><body><h1>Sample</h1></body></html>'], { type: 'text/html' }),
    'r.html'
  );
  fd.append('title', 'Sample');
  const res = await app.request('/api/upload', { method: 'POST', body: fd });
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
});
