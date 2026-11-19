import { describe, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockResolver, mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { documentCollaborators, users } from '../db/schema.ts';
import type { MentionableUsersResponse } from '@polygonlabs/primer-api-types';
import type { UserSearchResponse } from '@polygonlabs/primer-api-types';
import { asUser } from '../test/harness.ts';
import { uploadFixture } from './upload.testlib.ts';

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

async function withMultiUserApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-users-typeahead-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: mockMultiResolver,
    });
    // mock-user-1 is preserved by testing/setup.ts with canonical name "Mock User".
    // Skip it here; seed the others fresh (setup truncates non-mock users).
    await db
      .insert(users)
      .values([
        { id: 'mock-user-2', email: 'two@p.t', displayName: 'Bob Two' },
        { id: 'mock-user-3', email: 'three@p.t', displayName: 'Charlie Three' },
        { id: 'mock-user-4', email: 'four@p.t', displayName: 'Bobby Four' },
      ])
      .onConflictDoNothing();
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

  it('excludes the Claude service account', async () => {
    await withApp(async (app) => {
      await db
        .insert(users)
        .values([
          { id: 'mock-user-2', email: 'two@p.t', displayName: 'User Two' },
          {
            id: 'agent_users-test',
            email: 'agent@agents.primer.invalid',
            displayName: 'Claude',
            kind: 'agent',
          },
        ])
        .onConflictDoNothing();
      const res = await app.request('/api/users/mentionable');
      const body = (await res.json()) as MentionableUsersResponse;
      const ids = body.users.map((u) => u.id);
      expect(ids).toContain('mock-user-2');
      expect(ids).not.toContain('agent_users-test');
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

describe('GET /api/users (typeahead)', () => {
  it('returns matches by display-name prefix (case-insensitive)', async () => {
    await withMultiUserApp(async (app) => {
      const res = await app.request('/api/users?q=Bob', { headers: asUser('mock-user-3') });
      expect(res.status).toBe(200);
      const body = (await res.json()) as UserSearchResponse;
      const names = body.users.map((u) => u.displayName).sort();
      expect(names).toEqual(['Bob Two', 'Bobby Four']);
    });
  });

  it('returns empty result when q is empty', async () => {
    await withMultiUserApp(async (app) => {
      const res = await app.request('/api/users?q=', { headers: asUser('mock-user-3') });
      expect(res.status).toBe(200);
      expect(((await res.json()) as UserSearchResponse).users).toEqual([]);
    });
  });

  it('excludes owner and existing collaborators when docId is provided', async () => {
    await withMultiUserApp(async (app) => {
      const upload = await uploadFixture(app); // owned by mock-user-1 (Alice Owner)
      // Add mock-user-2 (Bob Two) as an existing collaborator.
      await db.insert(documentCollaborators).values({
        id: uuidv7(),
        documentId: upload.documentId,
        userId: 'mock-user-2',
        role: 'editor',
        grantedBy: 'mock-user-1',
      });
      // Query for "Bob" or "Alice" — owner + existing collab should be filtered out.
      const res = await app.request(
        `/api/users?q=Bo&docId=${upload.documentId}`,
        { headers: asUser('mock-user-1') },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as UserSearchResponse;
      const names = body.users.map((u) => u.displayName);
      expect(names).toEqual(['Bobby Four']); // Bob Two excluded (existing), only Bobby remains.
    });
  });

  it('excludes the Claude service account from search results', async () => {
    await withMultiUserApp(async (app) => {
      await db
        .insert(users)
        .values({
          id: 'agent_users-test',
          email: 'agent@agents.primer.invalid',
          displayName: 'Claude',
          kind: 'agent',
        })
        .onConflictDoNothing();
      const res = await app.request('/api/users?q=Cla', { headers: asUser('mock-user-1') });
      expect(res.status).toBe(200);
      const body = (await res.json()) as UserSearchResponse;
      expect(body.users.map((u) => u.id)).not.toContain('agent_users-test');
    });
  });

  it('caps result at 20 rows', async () => {
    await withMultiUserApp(async (app) => {
      // Seed 25 users whose displayName starts with "Zed".
      const inserts = Array.from({ length: 25 }, (_, i) => ({
        id: `zed-user-${i}`,
        email: `zed-${i}@p.t`,
        displayName: `Zed User ${String(i).padStart(2, '0')}`,
      }));
      await db.insert(users).values(inserts).onConflictDoNothing();
      const res = await app.request('/api/users?q=Zed', { headers: asUser('mock-user-1') });
      expect(res.status).toBe(200);
      const body = (await res.json()) as UserSearchResponse;
      expect(body.users).toHaveLength(20);
    });
  });

  it('missing docId still returns matches (owner-only filter is optional)', async () => {
    // With no docId, only the caller is excluded — nothing else. Query "Mock"
    // matches the canonical mock-user-1 seed ("Mock User"), which is not the
    // caller here (mock-user-3), so it should surface.
    await withMultiUserApp(async (app) => {
      const res = await app.request('/api/users?q=Mock', { headers: asUser('mock-user-3') });
      expect(res.status).toBe(200);
      const body = (await res.json()) as UserSearchResponse;
      expect(body.users.map((u) => u.displayName)).toEqual(['Mock User']);
    });
  });
});
