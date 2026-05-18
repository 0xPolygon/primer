import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockResolver, mockMultiResolver } from '../auth/resolver.ts';
import type { UserDTO } from '@primer/shared';

describe('GET /api/me', () => {
  it('returns the current user as UserDTO (mock resolver)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-me-'));
    try {
      const app = createApp({
        storage: new FilesystemStorage(root),
        notifier: new NoopNotifier(),
        userResolver: mockResolver,
      });
      const res = await app.request('/api/me');
      expect(res.status).toBe(200);
      const body = (await res.json()) as UserDTO;
      expect(body).toEqual({
        id: 'mock-user-1',
        email: 'mock@polygon.technology',
        displayName: 'Mock User',
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('returns the user from X-Mock-User-Id when using multi-mock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-me-multi-'));
    try {
      const app = createApp({
        storage: new FilesystemStorage(root),
        notifier: new NoopNotifier(),
        userResolver: mockMultiResolver,
      });
      const res = await app.request('/api/me', {
        headers: { 'x-mock-user-id': 'mock-user-2' },
      });
      expect(res.status).toBe(200);
      expect((await res.json()).id).toBe('mock-user-2');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
