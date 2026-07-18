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
import { apiTokens, users } from '@primer/shared/schema';
import { SERVICE_USER_ID, parseAdminEmails } from '../auth/admin.ts';
import { asUserJson } from '../test/harness.ts';
import type { ApiTokensListResponse, CreateTokenResponse } from '@primer/shared';

// mockMultiResolver synthesizes emails as `${id}@polygon.technology`.
const ADMIN_ID = 'admin-user';
const ADMIN_EMAIL = `${ADMIN_ID}@polygon.technology`;
const NON_ADMIN_ID = 'regular-user';

async function withApp<T>(
  fn: (app: ReturnType<typeof createApp>) => Promise<T>,
  adminEmails: string[] = [ADMIN_EMAIL],
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-service-tokens-test-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: composeResolvers(makeBearerResolver(), mockMultiResolver),
      adminEmails,
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function withBearerOnlyApp<T>(
  fn: (app: ReturnType<typeof createApp>) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-service-tokens-bearer-test-'));
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

beforeEach(async () => {
  await db.delete(apiTokens);
  // The migration seeds this row; insert defensively for isolated test DBs.
  // The admin also needs a users row so personal-token mints satisfy the FK.
  await db
    .insert(users)
    .values([
      {
        id: SERVICE_USER_ID,
        email: 'claude-service@polygon.technology',
        displayName: 'Claude',
      },
      { id: ADMIN_ID, email: ADMIN_EMAIL, displayName: ADMIN_ID },
    ])
    .onConflictDoNothing();
});

describe('admin gate', () => {
  it('returns 403 for non-admins on GET, POST, and DELETE', async () => {
    await withApp(async (app) => {
      const headers = asUserJson(NON_ADMIN_ID);

      const get = await app.request('/api/service-tokens', { headers });
      expect(get.status).toBe(403);

      const post = await app.request('/api/service-tokens', {
        method: 'POST',
        headers,
        body: JSON.stringify({ name: 'nope' }),
      });
      expect(post.status).toBe(403);

      const del = await app.request(`/api/service-tokens/${uuidv7()}`, {
        method: 'DELETE',
        headers,
      });
      expect(del.status).toBe(403);
    });
  });

  it('matches the allowlist case-insensitively via parseAdminEmails', async () => {
    const mixedCase = parseAdminEmails(`Admin-User@Polygon.Technology`);
    await withApp(
      async (app) => {
        const res = await app.request('/api/service-tokens', {
          headers: asUserJson(ADMIN_ID),
        });
        expect(res.status).toBe(200);
      },
      mixedCase,
    );
  });

  it('is unreachable for everyone when the allowlist is empty (fail closed)', async () => {
    await withApp(
      async (app) => {
        const res = await app.request('/api/service-tokens', {
          headers: asUserJson(ADMIN_ID),
        });
        expect(res.status).toBe(403);
      },
      [],
    );
  });
});

describe('POST /api/service-tokens', () => {
  it('mints a token attributed to the service user, not the admin', async () => {
    let plaintext = '';

    await withApp(async (app) => {
      const res = await app.request('/api/service-tokens', {
        method: 'POST',
        headers: asUserJson(ADMIN_ID),
        body: JSON.stringify({ name: 'claude-slack' }),
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as CreateTokenResponse;
      expect(body.token.startsWith('primer_pat_')).toBe(true);
      expect(body.summary.expiresAt).toBeNull();
      plaintext = body.token;

      // Row belongs to the service user in the DB.
      const rows = await db.select().from(apiTokens).where(eq(apiTokens.id, body.summary.id));
      expect(rows).toHaveLength(1);
      expect(rows[0].userId).toBe(SERVICE_USER_ID);

      // It does NOT appear in the admin's personal token list.
      const personal = await app.request('/api/tokens', { headers: asUserJson(ADMIN_ID) });
      const personalBody = (await personal.json()) as ApiTokensListResponse;
      expect(personalBody.tokens).toHaveLength(0);
    });

    // Bearer auth resolves to the service user.
    await withBearerOnlyApp(async (app) => {
      const me = await app.request('/api/me', {
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(me.status).toBe(200);
      const meBody = (await me.json()) as { id: string; displayName: string };
      expect(meBody.id).toBe(SERVICE_USER_ID);
    });
  });

  it('rejects invalid names with 400', async () => {
    await withApp(async (app) => {
      const res = await app.request('/api/service-tokens', {
        method: 'POST',
        headers: asUserJson(ADMIN_ID),
        body: JSON.stringify({ name: '   ' }),
      });
      expect(res.status).toBe(400);
      const err = (await res.json()) as { error: string };
      expect(err.error).toBe('invalid_name');
    });
  });
});

describe('GET /api/service-tokens', () => {
  it("lists only the service user's tokens, not the admin's personal ones", async () => {
    await withApp(async (app) => {
      // A personal token for the admin.
      await app.request('/api/tokens', {
        method: 'POST',
        headers: asUserJson(ADMIN_ID),
        body: JSON.stringify({ name: 'personal' }),
      });
      // A service token.
      await app.request('/api/service-tokens', {
        method: 'POST',
        headers: asUserJson(ADMIN_ID),
        body: JSON.stringify({ name: 'service' }),
      });

      const res = await app.request('/api/service-tokens', {
        headers: asUserJson(ADMIN_ID),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ApiTokensListResponse;
      expect(body.tokens).toHaveLength(1);
      expect(body.tokens[0].name).toBe('service');
    });
  });
});

describe('DELETE /api/service-tokens/:id', () => {
  it('revokes a service token; the bearer subsequently 401s', async () => {
    let plaintext = '';
    let tokenId = '';

    await withApp(async (app) => {
      const created = await app.request('/api/service-tokens', {
        method: 'POST',
        headers: asUserJson(ADMIN_ID),
        body: JSON.stringify({ name: 'short-lived' }),
      });
      const body = (await created.json()) as CreateTokenResponse;
      plaintext = body.token;
      tokenId = body.summary.id;

      const del = await app.request(`/api/service-tokens/${tokenId}`, {
        method: 'DELETE',
        headers: asUserJson(ADMIN_ID),
      });
      expect(del.status).toBe(200);
    });

    await withBearerOnlyApp(async (app) => {
      const me = await app.request('/api/me', {
        headers: { authorization: `Bearer ${plaintext}` },
      });
      expect(me.status).toBe(401);
    });
  });

  it('returns 404 for unknown ids and for personal (non-service) token ids', async () => {
    await withApp(async (app) => {
      const unknown = await app.request(`/api/service-tokens/${uuidv7()}`, {
        method: 'DELETE',
        headers: asUserJson(ADMIN_ID),
      });
      expect(unknown.status).toBe(404);

      // A personal token can't be revoked through the service endpoint.
      const created = await app.request('/api/tokens', {
        method: 'POST',
        headers: asUserJson(ADMIN_ID),
        body: JSON.stringify({ name: 'personal' }),
      });
      const body = (await created.json()) as CreateTokenResponse;
      const res = await app.request(`/api/service-tokens/${body.summary.id}`, {
        method: 'DELETE',
        headers: asUserJson(ADMIN_ID),
      });
      expect(res.status).toBe(404);
    });
  });
});
