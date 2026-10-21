import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { composeResolvers, makeBearerResolver } from './bearer.ts';
import { mockMultiResolver } from './resolver.ts';
import { db } from '../db/client.ts';
import { apiTokens, users } from '../db/schema.ts';
import { SERVICE_USER_ID } from './admin.ts';
import { asUserJson } from '../test/harness.ts';
import type { CreateTokenResponse } from '@polygonlabs/primer-api-types';

/**
 * Credential-management routes refuse bearer auth: a token — even an admin's
 * own personal token, or the Claude service token — can't mint a sibling
 * credential, approve a device login, or manage service tokens.
 */

const ADMIN_ID = 'admin-user';
const ADMIN_EMAIL = `${ADMIN_ID}@polygon.technology`;

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-session-only-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: composeResolvers(makeBearerResolver(), mockMultiResolver),
      adminEmails: [ADMIN_EMAIL],
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function mint(
  app: ReturnType<typeof createApp>,
  path: '/api/tokens' | '/api/service-tokens',
): Promise<CreateTokenResponse> {
  const res = await app.request(path, {
    method: 'POST',
    headers: asUserJson(ADMIN_ID),
    body: JSON.stringify({ name: 'session-only-test' }),
  });
  expect(res.status).toBe(201);
  return (await res.json()) as CreateTokenResponse;
}

function bearerJson(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

beforeEach(async () => {
  await db.delete(apiTokens);
  await db
    .insert(users)
    .values([
      { id: SERVICE_USER_ID, email: 'claude-service@polygon.technology', displayName: 'Claude' },
      { id: ADMIN_ID, email: ADMIN_EMAIL, displayName: ADMIN_ID },
    ])
    .onConflictDoNothing();
});

describe('session-only routes', () => {
  it.each([
    ['personal token of an admin', '/api/tokens'],
    ['service token', '/api/service-tokens'],
  ] as const)('%s gets 403 session_required on every credential-management route', async (_label, mintPath) => {
    await withApp(async (app) => {
      const { token, summary } = await mint(app, mintPath);
      const routes: [string, string, unknown?][] = [
        ['POST', '/api/tokens', { name: 'sibling' }],
        ['GET', '/api/service-tokens'],
        ['POST', '/api/service-tokens', { name: 'sibling' }],
        ['DELETE', `/api/service-tokens/${summary.id}`],
        ['POST', '/api/device/approve', { userCode: 'ABCD-EFGH' }],
        ['POST', '/api/device/deny', { userCode: 'ABCD-EFGH' }],
        ['GET', '/api/admin/stats'],
      ];
      for (const [method, path, body] of routes) {
        const res = await app.request(path, {
          method,
          headers: bearerJson(token),
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        expect({ method, path, status: res.status }).toEqual({ method, path, status: 403 });
        expect(((await res.json()) as { error: string }).error).toBe('session_required');
      }

      // Nothing was minted by the rejected calls.
      const rows = await db.select().from(apiTokens);
      expect(rows).toHaveLength(1);
    });
  });

  it('a bearer cannot approve a device login started by someone else', async () => {
    await withApp(async (app) => {
      const { token } = await mint(app, '/api/service-tokens');
      const start = await app.request('/api/device/authorize', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      const { deviceCode, userCode } = (await start.json()) as { deviceCode: string; userCode: string };

      const approve = await app.request('/api/device/approve', {
        method: 'POST',
        headers: bearerJson(token),
        body: JSON.stringify({ userCode }),
      });
      expect(approve.status).toBe(403);

      const poll = await app.request('/api/device/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ deviceCode }),
      });
      expect(poll.status).toBe(400);
      expect(((await poll.json()) as { error: string }).error).toBe('authorization_pending');
    });
  });

  it('session callers keep access; bearers can still list and revoke their own tokens', async () => {
    await withApp(async (app) => {
      const stats = await app.request('/api/admin/stats', { headers: asUserJson(ADMIN_ID) });
      expect(stats.status).toBe(200);

      const { token, summary } = await mint(app, '/api/tokens');
      const list = await app.request('/api/tokens', { headers: bearerJson(token) });
      expect(list.status).toBe(200);

      const revoke = await app.request(`/api/tokens/${summary.id}`, {
        method: 'DELETE',
        headers: bearerJson(token),
      });
      expect(revoke.status).toBe(200);
    });
  });
});
