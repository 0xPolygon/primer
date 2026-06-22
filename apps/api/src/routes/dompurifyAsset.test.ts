import { describe, it, expect } from 'vitest';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOMPURIFY_VERSION } from '../companion/dompurifyVersion.ts';

describe(`GET /companion/dompurify-v${DOMPURIFY_VERSION}.js`, () => {
  it('serves the vendored bundle with the right headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-dompurify-route-'));
    try {
      const app = createApp({
        storage: new FilesystemStorage(root),
        notifier: new NoopNotifier(),
      });
      const res = await app.request(`/companion/dompurify-v${DOMPURIFY_VERSION}.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(
        'application/javascript; charset=utf-8',
      );
      expect(res.headers.get('cache-control')).toBe(
        'public, max-age=31536000, immutable',
      );
      const body = await res.text();
      // The UMD bundle's license header survives minification.
      expect(body).toContain('DOMPurify');
      expect(body.length).toBeGreaterThan(10_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 for the wrong version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-dompurify-404-'));
    try {
      const app = createApp({
        storage: new FilesystemStorage(root),
        notifier: new NoopNotifier(),
      });
      const res = await app.request('/companion/dompurify-v0.0.0.js');
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
