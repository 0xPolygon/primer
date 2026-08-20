import { describe, it, expect, beforeEach } from 'vitest';
import { v7 as uuidv7 } from 'uuid';
import { Hono } from 'hono';
import type { AppVariables } from '../../app.ts';
import { db } from '../../db/client.ts';
import { oauthAccessTokens, oauthClients, users } from '../../db/schema.ts';
import { makeOAuthBearerResolver } from './bearer.ts';
import { generateAccessToken } from './tokens.ts';
import { createClient } from './clients.ts';

async function seedUser(id: string): Promise<void> {
  await db.insert(users).values({ id, email: `${id}@x.test`, displayName: id });
}

async function withApp<T>(fn: (app: Hono<{ Variables: AppVariables }>) => Promise<T>): Promise<T> {
  const app = new Hono<{ Variables: AppVariables }>();
  const resolver = makeOAuthBearerResolver();
  app.use('*', async (c, next) => {
    const user = await resolver(c);
    if (user) c.set('user', user);
    await next();
  });
  app.get('/probe', (c) => {
    const u = c.get('user');
    return u ? c.json({ id: u.id }) : c.json({ error: 'no user' }, 401);
  });
  return fn(app);
}

beforeEach(async () => {
  await db.delete(oauthAccessTokens);
  await db.delete(oauthClients);
});

describe('makeOAuthBearerResolver', () => {
  it('resolves a valid primer_oat_ token to its user', async () => {
    await seedUser('user-1');
    const client = await createClient({
      clientName: 'test',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      grantTypes: ['authorization_code'],
    });
    const { token, tokenHash } = generateAccessToken();
    await db.insert(oauthAccessTokens).values({
      id: uuidv7(),
      tokenHash,
      userId: 'user-1',
      clientId: client.clientId,
      scopes: ['primer'],
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });

    await withApp(async (app) => {
      const res = await app.request('/probe', { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ id: 'user-1' });
    });
  });

  it('returns null when the Authorization header is missing', async () => {
    await withApp(async (app) => {
      const res = await app.request('/probe');
      expect(res.status).toBe(401);
    });
  });

  it('returns null when the prefix is not primer_oat_', async () => {
    await withApp(async (app) => {
      const res = await app.request('/probe', {
        headers: { authorization: 'Bearer primer_pat_abc' },
      });
      expect(res.status).toBe(401);
    });
  });

  it('returns null when the token is expired', async () => {
    await seedUser('user-2');
    const client = await createClient({
      clientName: 'test',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
      grantTypes: ['authorization_code'],
    });
    const { token, tokenHash } = generateAccessToken();
    await db.insert(oauthAccessTokens).values({
      id: uuidv7(),
      tokenHash,
      userId: 'user-2',
      clientId: client.clientId,
      scopes: ['primer'],
      expiresAt: new Date(Date.now() - 60 * 1000),
    });

    await withApp(async (app) => {
      const res = await app.request('/probe', { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
    });
  });
});
