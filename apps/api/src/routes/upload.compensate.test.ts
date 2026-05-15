import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';

vi.mock('../db/client.ts', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../db/client.ts')>();
  return {
    ...orig,
    db: {
      ...orig.db,
      transaction: vi.fn(async () => {
        throw new Error('forced DB failure');
      }),
    },
  };
});

describe('POST /api/upload — DB failure triggers compensating delete', () => {
  it('removes the storage file when the DB transaction throws', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-comp-test-'));
    try {
      const storage = new FilesystemStorage(root);
      const app = createApp({ storage, notifier: new NoopNotifier() });

      const fd = new FormData();
      fd.append('file', new Blob(['<html><body></body></html>'], { type: 'text/html' }), 'r.html');
      fd.append('title', 't');

      const res = await app.request('/api/upload', { method: 'POST', body: fd });
      expect(res.status).toBe(500);

      // The v1/ directory may exist (mkdir was called) but must contain no files —
      // the compensating delete removed the uploaded file.
      let v1Entries: string[] = [];
      try {
        v1Entries = await readdir(join(root, 'v1'));
      } catch {
        // Directory doesn't exist at all — also fine.
      }
      expect(v1Entries).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
