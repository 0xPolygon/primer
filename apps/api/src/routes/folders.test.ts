import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import type { Notifier } from '../notifications/notifier.ts';
import type { FolderDTO } from '@polygonlabs/primer-api-types';
import { asUser, asUserJson } from '../test/harness.ts';

class NullNotifier implements Notifier {
  readonly emailEnabled = false;
  async notifyComment() {}
  async notifyCollaboratorAdded() {}
  async notifyExternalOtp() {}
  async notifyExternalFirstView() {}
  async notifyDocumentMention() {}
}

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-folders-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NullNotifier(),
      userResolver: mockMultiResolver,
    });
    await db
      .insert(users)
      .values([
        { id: 'mock-user-1', email: 'one@p.t', displayName: 'User One' },
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
      ])
      .onConflictDoNothing();
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('POST /api/folders', () => {
  it('creates a folder for the caller', async () => {
    await withApp(async (app) => {
      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as FolderDTO;
      expect(body.name).toBe('Research');
      expect(body.docCount).toBe(0);
      expect(typeof body.id).toBe('string');
    });
  });

  it('trims the name before storing', async () => {
    await withApp(async (app) => {
      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: '  Reading list  ' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as FolderDTO;
      expect(body.name).toBe('Reading list');
    });
  });

  it('rejects empty and whitespace-only names', async () => {
    await withApp(async (app) => {
      for (const bad of ['', '   ', '\t\n']) {
        const res = await app.request('/api/folders', {
          method: 'POST',
          headers: asUserJson('mock-user-1'),
          body: JSON.stringify({ name: bad }),
        });
        expect(res.status).toBe(400);
      }
    });
  });

  it('rejects names longer than 60 chars post-trim', async () => {
    await withApp(async (app) => {
      const res = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'x'.repeat(61) }),
      });
      expect(res.status).toBe(400);
    });
  });

  it('409 on case-insensitive duplicate for same user', async () => {
    await withApp(async (app) => {
      const a = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      expect(a.status).toBe(201);
      const b = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'research' }),
      });
      expect(b.status).toBe(409);
    });
  });

  it('allows the same name across different users', async () => {
    await withApp(async (app) => {
      const a = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      const b = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ name: 'Research' }),
      });
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
    });
  });
});

describe('PATCH /api/folders/:folderId', () => {
  it('renames the caller\'s folder', async () => {
    await withApp(async (app) => {
      const created = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      const { id } = (await created.json()) as FolderDTO;
      const res = await app.request(`/api/folders/${id}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'ZK Research' }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as FolderDTO;
      expect(body.name).toBe('ZK Research');
      expect(body.id).toBe(id);
    });
  });

  it('404 when caller is not the owner', async () => {
    await withApp(async (app) => {
      const created = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      const { id } = (await created.json()) as FolderDTO;
      const res = await app.request(`/api/folders/${id}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-2'),
        body: JSON.stringify({ name: 'Nope' }),
      });
      expect(res.status).toBe(404);
    });
  });

  it('409 on case-insensitive duplicate rename', async () => {
    await withApp(async (app) => {
      await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      const created = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Q3' }),
      });
      const { id } = (await created.json()) as FolderDTO;
      const res = await app.request(`/api/folders/${id}`, {
        method: 'PATCH',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'research' }),
      });
      expect(res.status).toBe(409);
    });
  });
});

describe('DELETE /api/folders/:folderId', () => {
  it('deletes the caller\'s folder (204)', async () => {
    await withApp(async (app) => {
      const created = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      const { id } = (await created.json()) as FolderDTO;
      const res = await app.request(`/api/folders/${id}`, {
        method: 'DELETE',
        headers: asUser('mock-user-1'),
      });
      expect(res.status).toBe(204);
    });
  });

  it('404 when caller is not the owner', async () => {
    await withApp(async (app) => {
      const created = await app.request('/api/folders', {
        method: 'POST',
        headers: asUserJson('mock-user-1'),
        body: JSON.stringify({ name: 'Research' }),
      });
      const { id } = (await created.json()) as FolderDTO;
      const res = await app.request(`/api/folders/${id}`, {
        method: 'DELETE',
        headers: asUser('mock-user-2'),
      });
      expect(res.status).toBe(404);
    });
  });
});
