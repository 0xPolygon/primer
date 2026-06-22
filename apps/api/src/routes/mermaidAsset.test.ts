import { describe, it, expect } from 'vitest';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MERMAID_VERSION } from '../companion/mermaidVersion.ts';

describe(`GET /companion/mermaid-v${MERMAID_VERSION}.js`, () => {
  it('serves the vendored bundle with the right headers', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-mermaid-route-'));
    try {
      const app = createApp({
        storage: new FilesystemStorage(root),
        notifier: new NoopNotifier(),
      });
      const res = await app.request(`/companion/mermaid-v${MERMAID_VERSION}.js`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe(
        'application/javascript; charset=utf-8',
      );
      expect(res.headers.get('cache-control')).toBe(
        'public, max-age=31536000, immutable',
      );
      const body = await res.text();
      // The UMD bundle's IIFE exposes a global; this string survives minification.
      expect(body).toContain('mermaid');
      expect(body.length).toBeGreaterThan(500_000);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns 404 for the wrong version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-mermaid-404-'));
    try {
      const app = createApp({
        storage: new FilesystemStorage(root),
        notifier: new NoopNotifier(),
      });
      const res = await app.request('/companion/mermaid-v0.0.0.js');
      expect(res.status).toBe(404);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
