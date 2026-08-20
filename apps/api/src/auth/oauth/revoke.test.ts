import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  oauthAccessTokens,
  oauthClients,
  oauthRefreshTokens,
  users,
} from '../../db/schema.ts';
import { registerOAuthRevocationRoute } from './revoke.ts';
import { createClient } from './clients.ts';
import { generateAccessToken, generateRefreshToken } from './tokens.ts';

async function seed(): Promise<{ userId: string; clientId: string }> {
  const userId = `u-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(users).values({ id: userId, email: `${userId}@x.test`, displayName: userId });
  const client = await createClient({
    clientName: 'C',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    grantTypes: ['authorization_code'],
  });
  return { userId, clientId: client.clientId };
}

function makeApp(): Hono {
  const app = new Hono();
  registerOAuthRevocationRoute(app);
  return app;
}

beforeEach(async () => {
  await db.delete(oauthAccessTokens);
  await db.delete(oauthRefreshTokens);
  await db.delete(oauthClients);
});

describe('POST /oauth/revoke', () => {
  it('revokes a refresh token family', async () => {
    const { userId, clientId } = await seed();
    const familyId = uuidv7();
    const first = generateRefreshToken();
    const second = generateRefreshToken();
    for (const t of [first, second]) {
      await db.insert(oauthRefreshTokens).values({
        id: uuidv7(),
        familyId,
        tokenHash: t.tokenHash,
        userId,
        clientId,
        scopes: ['primer'],
        expiresAt: new Date(Date.now() + 3600 * 1000),
      });
    }
    const res = await makeApp().request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: first.token }).toString(),
    });
    expect(res.status).toBe(200);

    const rows = (await db.execute(sql`
      SELECT revoked_at FROM oauth_refresh_tokens WHERE family_id = ${familyId}
    `)) as unknown as { revoked_at: Date | null }[];
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
  });

  it('deletes an access token', async () => {
    const { userId, clientId } = await seed();
    const t = generateAccessToken();
    await db.insert(oauthAccessTokens).values({
      id: uuidv7(),
      tokenHash: t.tokenHash,
      userId,
      clientId,
      scopes: ['primer'],
      expiresAt: new Date(Date.now() + 3600 * 1000),
    });
    const res = await makeApp().request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: t.token }).toString(),
    });
    expect(res.status).toBe(200);
    const rows = (await db.execute(sql`
      SELECT COUNT(*)::int AS n FROM oauth_access_tokens WHERE token_hash = ${t.tokenHash}
    `)) as unknown as { n: number }[];
    expect(rows[0].n).toBe(0);
  });

  it('returns 200 for an unknown token', async () => {
    const res = await makeApp().request('/oauth/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: 'primer_ort_nope' }).toString(),
    });
    expect(res.status).toBe(200);
  });
});
