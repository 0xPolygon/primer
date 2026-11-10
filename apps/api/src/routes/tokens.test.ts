import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { composeResolvers, makeBearerResolver } from '../auth/bearer.ts';
import { mockMultiResolver } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { apiTokens, users } from '../db/schema.ts';
import { generateToken } from '../auth/tokens.ts';
import { asUserJson } from '../test/harness.ts';
import type { ApiTokenSummary, ApiTokensListResponse, CreateTokenResponse } from '@polygonlabs/primer-api-types';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-tokens-test-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: composeResolvers(makeBearerResolver(), mockMultiResolver),
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Bearer-only variant — no mock fallback. Used to assert that a request with
 * a revoked bearer is truly rejected with 401, rather than silently falling
 * through to the mock resolver (which always synthesizes a user).
 */
async function withBearerOnlyApp<T>(
  fn: (app: ReturnType<typeof createApp>) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-tokens-bearer-test-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: makeBearerResolver(),
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function seedUser(
  id: string = `tokens-user-${Math.random().toString(36).slice(2, 8)}`
): Promise<string> {
  await db.insert(users).values({
    id,
    email: `${id}@polygon.technology`,
    displayName: id,
  });
  return id;
}

interface SeedTokenOpts {
  userId: string;
  name?: string;
  expiresAt?: Date | null;
  revokedAt?: Date | null;
  createdAt?: Date;
  lastUsedAt?: Date | null;
}

async function seedToken(
  opts: SeedTokenOpts
): Promise<{ id: string; token: string; tokenPrefix: string }> {
  const id = uuidv7();
  const minted = generateToken();
  await db.insert(apiTokens).values({
    id,
    userId: opts.userId,
    name: opts.name ?? 'test token',
    tokenHash: minted.tokenHash,
    tokenPrefix: minted.tokenPrefix,
    expiresAt: opts.expiresAt === undefined ? null : opts.expiresAt,
    revokedAt: opts.revokedAt ?? null,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    ...(opts.lastUsedAt !== undefined ? { lastUsedAt: opts.lastUsedAt } : {}),
  });
  return { id, token: minted.token, tokenPrefix: minted.tokenPrefix };
}

beforeEach(async () => {
  // Clear api_tokens between tests for clean state.
  await db.delete(apiTokens);
});

describe('GET /api/tokens', () => {
  it("lists the caller's tokens with ApiTokenSummary shape, never including `token`", async () => {
    await withApp(async (app) => {
      const userId = await seedUser();
      // Simulate a device-issued token with ~90d expiry.
      const ninetyDays = new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
      await seedToken({
        userId,
        name: 'device: my-laptop',
        expiresAt: ninetyDays,
      });
      // And a never-expiring token for the same user.
      await seedToken({
        userId,
        name: 'forever',
        expiresAt: null,
      });

      const res = await app.request('/api/tokens', { headers: asUserJson(userId) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiTokensListResponse;
      expect(Array.isArray(body.tokens)).toBe(true);
      expect(body.tokens).toHaveLength(2);

      for (const row of body.tokens) {
        // ApiTokenSummary shape: exact keys, no `token` / `tokenHash`.
        const keys = Object.keys(row).sort();
        expect(keys).toEqual(
          [
            'id',
            'name',
            'tokenPrefix',
            'scopes',
            'createdAt',
            'lastUsedAt',
            'expiresAt',
            'revokedAt',
          ].sort()
        );
        expect((row as unknown as Record<string, unknown>).token).toBeUndefined();
        expect((row as unknown as Record<string, unknown>).tokenHash).toBeUndefined();
        expect(typeof row.id).toBe('string');
        expect(typeof row.name).toBe('string');
        expect(typeof row.tokenPrefix).toBe('string');
        expect(typeof row.createdAt).toBe('string');
      }

      const device = body.tokens.find((t) => t.name === 'device: my-laptop') as
        | ApiTokenSummary
        | undefined;
      expect(device).toBeDefined();
      expect(typeof device!.expiresAt).toBe('string');
      const forever = body.tokens.find((t) => t.name === 'forever') as
        | ApiTokenSummary
        | undefined;
      expect(forever).toBeDefined();
      expect(forever!.expiresAt).toBeNull();
    });
  });

  it("does NOT include another user's tokens", async () => {
    await withApp(async (app) => {
      const me = await seedUser();
      const other = await seedUser();
      await seedToken({ userId: me, name: 'mine' });
      await seedToken({ userId: other, name: 'theirs' });

      const res = await app.request('/api/tokens', { headers: asUserJson(me) });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiTokensListResponse;
      expect(body.tokens).toHaveLength(1);
      expect(body.tokens[0].name).toBe('mine');
    });
  });
});

describe('DELETE /api/tokens/:id', () => {
  it('revokes own token, /api/me with that bearer subsequently 401s, revoked_at is set', async () => {
    const userId = await seedUser();
    const t = await seedToken({ userId, name: 'to-revoke' });

    // Bearer auth works before revoke. Use a bearer-only app so we know it's
    // actually the bearer resolver answering (not a mock fallback).
    await withBearerOnlyApp(async (app) => {
      const meBefore = await app.request('/api/me', {
        headers: { authorization: `Bearer ${t.token}` },
      });
      expect(meBefore.status).toBe(200);
    });

    // Revoke via the composed app — caller authenticates via x-mock-user-id.
    await withApp(async (app) => {
      const res = await app.request(`/api/tokens/${t.id}`, {
        method: 'DELETE',
        headers: asUserJson(userId),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean };
      expect(body.ok).toBe(true);
    });

    // Bearer no longer authenticates against a bearer-only app.
    await withBearerOnlyApp(async (app) => {
      const meAfter = await app.request('/api/me', {
        headers: { authorization: `Bearer ${t.token}` },
      });
      expect(meAfter.status).toBe(401);
    });

    // DB row has revoked_at set.
    const rows = await db.select().from(apiTokens).where(eq(apiTokens.id, t.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].revokedAt).not.toBeNull();
  });

  it("returns 404 (not 403) when deleting another user's token (no leak)", async () => {
    await withApp(async (app) => {
      const me = await seedUser();
      const other = await seedUser();
      const theirs = await seedToken({ userId: other, name: 'theirs' });

      const res = await app.request(`/api/tokens/${theirs.id}`, {
        method: 'DELETE',
        headers: asUserJson(me),
      });
      expect(res.status).toBe(404);

      // And the row is untouched.
      const rows = await db.select().from(apiTokens).where(eq(apiTokens.id, theirs.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].revokedAt).toBeNull();
    });
  });

  it('returns 404 for unknown id', async () => {
    await withApp(async (app) => {
      const userId = await seedUser();
      const unknownId = uuidv7();
      const res = await app.request(`/api/tokens/${unknownId}`, {
        method: 'DELETE',
        headers: asUserJson(userId),
      });
      expect(res.status).toBe(404);
    });
  });

  it('is idempotent — second DELETE on already-revoked token still returns 200 for owner', async () => {
    await withApp(async (app) => {
      const userId = await seedUser();
      const t = await seedToken({ userId, name: 'twice' });

      const first = await app.request(`/api/tokens/${t.id}`, {
        method: 'DELETE',
        headers: asUserJson(userId),
      });
      expect(first.status).toBe(200);

      const rowsAfterFirst = await db.select().from(apiTokens).where(eq(apiTokens.id, t.id));
      const firstRevokedAt = rowsAfterFirst[0].revokedAt;
      expect(firstRevokedAt).not.toBeNull();

      const second = await app.request(`/api/tokens/${t.id}`, {
        method: 'DELETE',
        headers: asUserJson(userId),
      });
      expect(second.status).toBe(200);
      const body = (await second.json()) as { ok: boolean };
      expect(body.ok).toBe(true);

      // Still belongs to the caller, still revoked.
      const rowsAfterSecond = await db.select().from(apiTokens).where(eq(apiTokens.id, t.id));
      expect(rowsAfterSecond).toHaveLength(1);
      expect(rowsAfterSecond[0].userId).toBe(userId);
      expect(rowsAfterSecond[0].revokedAt).not.toBeNull();
    });
  });
});

describe('POST /api/tokens', () => {
  it('mints a never-expiring token, returning the plaintext exactly once', async () => {
    const userId = await seedUser();
    let plaintext = '';

    await withApp(async (app) => {
      const res = await app.request('/api/tokens', {
        method: 'POST',
        headers: asUserJson(userId),
        body: JSON.stringify({ name: '  claude-slack  ' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as CreateTokenResponse;

      expect(body.token.startsWith('primer_pat_')).toBe(true);
      plaintext = body.token;

      // Name is trimmed; token never expires.
      expect(body.summary.name).toBe('claude-slack');
      expect(body.summary.expiresAt).toBeNull();
      expect(body.summary.revokedAt).toBeNull();
      expect(body.summary.lastUsedAt).toBeNull();
      expect(body.token.includes(body.summary.tokenPrefix)).toBe(true);

      // Summary carries no secret material.
      const keys = Object.keys(body.summary).sort();
      expect(keys).toEqual(
        ['id', 'name', 'tokenPrefix', 'scopes', 'createdAt', 'lastUsedAt', 'expiresAt', 'revokedAt'].sort()
      );
      expect((body.summary as unknown as Record<string, unknown>).tokenHash).toBeUndefined();

      // The new token shows up in the list.
      const list = await app.request('/api/tokens', { headers: asUserJson(userId) });
      const listBody = (await list.json()) as ApiTokensListResponse;
      expect(listBody.tokens).toHaveLength(1);
      expect(listBody.tokens[0].id).toBe(body.summary.id);
    });

    // The minted token authenticates as its creator via the bearer resolver.
    await withBearerOnlyApp(async (app) => {
      const me = await app.request('/api/me', {
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(me.status).toBe(200);
      const meBody = (await me.json()) as { id: string };
      expect(meBody.id).toBe(userId);
    });
  });

  it('rejects missing, empty, whitespace-only, and over-long names with 400', async () => {
    await withApp(async (app) => {
      const userId = await seedUser();
      const bodies = [
        JSON.stringify({}),
        JSON.stringify({ name: '' }),
        JSON.stringify({ name: '   ' }),
        JSON.stringify({ name: 'x'.repeat(101) }),
        JSON.stringify({ name: 42 }),
        'not-json',
      ];
      for (const body of bodies) {
        const res = await app.request('/api/tokens', {
          method: 'POST',
          headers: asUserJson(userId),
          body,
        });
        expect(res.status).toBe(400);
        const err = (await res.json()) as { error: string };
        expect(err.error).toBe('invalid_name');
      }
    });
  });

  it('enforces the active-token cap; revoked tokens do not count', async () => {
    await withApp(async (app) => {
      const userId = await seedUser();
      for (let i = 0; i < 25; i++) {
        await seedToken({ userId, name: `t${i}` });
      }

      const atCap = await app.request('/api/tokens', {
        method: 'POST',
        headers: asUserJson(userId),
        body: JSON.stringify({ name: 'one-too-many' }),
      });
      expect(atCap.status).toBe(400);
      const err = (await atCap.json()) as { error: string };
      expect(err.error).toBe('token_limit');

      // Revoking one frees a slot.
      const list = await app.request('/api/tokens', { headers: asUserJson(userId) });
      const listBody = (await list.json()) as ApiTokensListResponse;
      const victim = listBody.tokens[0];
      await app.request(`/api/tokens/${victim.id}`, {
        method: 'DELETE',
        headers: asUserJson(userId),
      });

      const afterRevoke = await app.request('/api/tokens', {
        method: 'POST',
        headers: asUserJson(userId),
        body: JSON.stringify({ name: 'fits-now' }),
      });
      expect(afterRevoke.status).toBe(201);
    });
  });
});
