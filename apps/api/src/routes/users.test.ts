import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockResolver, mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { users } from '@primer/shared/schema';
import type { MentionableUsersResponse } from '@primer/shared';

async function withApp<T>(
  fn: (app: ReturnType<typeof createApp>) => Promise<T>,
  useMulti = false,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-users-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: useMulti ? mockMultiResolver : mockResolver,
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('GET /api/users/mentionable', () => {
  it('returns all users except the caller', async () => {
    await withApp(async (app) => {
      await db
        .insert(users)
        .values([
          { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
          { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
        ])
        .onConflictDoNothing();
      const res = await app.request('/api/users/mentionable');
      expect(res.status).toBe(200);
      const body = (await res.json()) as MentionableUsersResponse;
      const ids = body.users.map((u) => u.id).sort();
      expect(ids).toContain('mock-user-2');
      expect(ids).not.toContain('mock-user-1'); // caller is mock-user-1 (mockResolver)
    });
  });

  it('returns each user with id, displayName, email', async () => {
    await withApp(async (app) => {
      await db
        .insert(users)
        .values([
          { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
          { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
        ])
        .onConflictDoNothing();
      const res = await app.request('/api/users/mentionable');
      const body = (await res.json()) as MentionableUsersResponse;
      const u = body.users.find((x) => x.id === 'mock-user-2');
      expect(u).toEqual({ id: 'mock-user-2', displayName: 'User Two', email: 'two@p.t' });
    });
  });

  it('reflects X-Mock-User-Id (caller filter follows the header)', async () => {
    await withApp(async (app) => {
      await db
        .insert(users)
        .values([
          { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
          { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
        ])
        .onConflictDoNothing();
      const res = await app.request('/api/users/mentionable', {
        headers: { 'x-mock-user-id': 'mock-user-2' },
      });
      const body = (await res.json()) as MentionableUsersResponse;
      const ids = body.users.map((u) => u.id);
      expect(ids).not.toContain('mock-user-2');
      expect(ids).toContain('mock-user-1');
    }, true);
  });
});
