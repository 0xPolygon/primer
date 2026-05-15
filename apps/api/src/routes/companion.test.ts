import { describe, it, expect } from 'vitest';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('GET /companion/v1.js', () => {
  it('serves the companion stub with javascript content-type', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-comp-route-'));
    try {
      const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
      const res = await app.request('/companion/v1.js');
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/javascript; charset=utf-8');
      expect(res.headers.get('cache-control')).toBe('public, max-age=3600');
      const body = await res.text();
      expect(body).toContain('[primer/companion]'); // tag emitted by the v1 IIFE
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
