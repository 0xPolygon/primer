import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { db } from '../db/client.ts';
import { documents, versions, threads, comments, documentViews, users } from '@primer/shared/schema';
import type { AdminStatsResponse } from '@primer/shared';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-admin-test-'));
  try {
    const app = createApp({ storage: new FilesystemStorage(root), notifier: new NoopNotifier() });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function snapshot(app: ReturnType<typeof createApp>): Promise<AdminStatsResponse> {
  const res = await app.request('/api/admin/stats');
  expect(res.status).toBe(200);
  return (await res.json()) as AdminStatsResponse;
}

describe('GET /api/admin/stats', () => {
  it('returns the expected JSON shape', async () => {
    await withApp(async (app) => {
      const body = await snapshot(app);
      expect(body).toMatchObject({
        users:         { total: expect.any(Number), last7d: expect.any(Number) },
        documents:     { total: expect.any(Number), last7d: expect.any(Number) },
        versions:      { total: expect.any(Number), last7d: expect.any(Number) },
        threads:       { total: expect.any(Number), last7d: expect.any(Number) },
        comments:      { total: expect.any(Number), last7d: expect.any(Number) },
        documentViews: { total: expect.any(Number), last7d: expect.any(Number) },
      });
    });
  });
});
