import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp, type AppDeps } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import type { UserResolver } from '../auth/resolver.ts';

// No session: proves both probes are reachable unauthenticated (kubelet and
// the load balancer send no credentials).
const anonymous: UserResolver = async () => null;

async function withApp(
  overrides: Partial<AppDeps>,
  fn: (app: ReturnType<typeof createApp>) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'primer-health-'));
  try {
    await fn(
      createApp({
        storage: new FilesystemStorage(root),
        notifier: new NoopNotifier(),
        userResolver: anonymous,
        ...overrides,
      }),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('GET /api/health', () => {
  it('returns ok without a session', async () => {
    await withApp({}, async (app) => {
      const res = await app.request('/api/health');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });
});

describe('GET /api/ready', () => {
  it('returns ok when the real database answers', async () => {
    await withApp({}, async (app) => {
      const res = await app.request('/api/ready');
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });
  });

  it('returns 503 when the database check fails', async () => {
    await withApp(
      { checkDatabase: async () => { throw new Error('password authentication failed'); } },
      async (app) => {
        const res = await app.request('/api/ready');
        expect(res.status).toBe(503);
        // The underlying error is logged, not returned.
        expect(await res.json()).toEqual({ ok: false, error: 'database_unavailable' });
      },
    );
  });

  it('returns 503 when the database check hangs past the timeout', async () => {
    await withApp({ checkDatabase: () => new Promise<void>(() => {}) }, async (app) => {
      const res = await app.request('/api/ready');
      expect(res.status).toBe(503);
    });
  });
});
