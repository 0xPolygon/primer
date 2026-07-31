import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthRefreshTokens,
  users,
} from '../../db/schema.ts';
import { registerOAuthTokenRoute } from './token.ts';
import { createClient, type OAuthClientRow } from './clients.ts';
import { hashHex } from './tokens.ts';

const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

function makeApp(): Hono {
  const app = new Hono();
  registerOAuthTokenRoute(app);
  return app;
}

async function seedUser(): Promise<string> {
  const id = `u-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(users).values({ id, email: `${id}@x.test`, displayName: id });
  return id;
}

async function seedClient(): Promise<OAuthClientRow> {
  return createClient({
    clientName: 'Claude',
    redirectUris: [REDIRECT_URI],
    grantTypes: ['authorization_code', 'refresh_token'],
  });
}

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return { verifier, challenge };
}

async function seedAuthCode(
  clientId: string,
  userId: string,
  overrides: { challenge: string; redirectUri?: string; expiresAt?: Date },
): Promise<{ code: string }> {
  const code = randomBytes(32).toString('base64url');
  await db.insert(oauthAuthorizationCodes).values({
    id: uuidv7(),
    codeHash: hashHex(code),
    userId,
    clientId,
    redirectUri: overrides.redirectUri ?? REDIRECT_URI,
    codeChallenge: overrides.challenge,
    codeChallengeMethod: 'S256',
    scopes: ['primer'],
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 5 * 60 * 1000),
  });
  return { code };
}

beforeEach(async () => {
  await db.delete(oauthAccessTokens);
  await db.delete(oauthRefreshTokens);
  await db.delete(oauthAuthorizationCodes);
  await db.delete(oauthClients);
  await db.execute(sql`DELETE FROM users WHERE id LIKE 'u-%' OR id LIKE 'mcp-%'`);
});

describe('POST /oauth/token — grant_type=authorization_code', () => {
  it('mints access + refresh on the happy path and marks the code consumed', async () => {
    const userId = await seedUser();
    const client = await seedClient();
    const { verifier, challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, { challenge });

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT_URI,
      client_id: client.clientId,
    });
    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.token_type).toBe('bearer');
    expect(typeof json.access_token).toBe('string');
    expect(typeof json.refresh_token).toBe('string');
    expect(json.expires_in).toBe(3600);
    expect(json.scope).toBe('primer');

    const consumed = (await db.execute(sql`
      SELECT consumed_at FROM oauth_authorization_codes WHERE code_hash = ${hashHex(code)}
    `)) as unknown as { consumed_at: Date | null }[];
    expect(consumed[0].consumed_at).not.toBeNull();
  });

  it('returns invalid_grant for a consumed code', async () => {
    const userId = await seedUser();
    const client = await seedClient();
    const { verifier, challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, { challenge });

    const doPost = () =>
      makeApp().request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
          client_id: client.clientId,
        }).toString(),
      });

    expect((await doPost()).status).toBe(200);
    const second = await doPost();
    expect(second.status).toBe(400);
    expect((await second.json()).error).toBe('invalid_grant');
  });

  it('returns invalid_grant on PKCE mismatch', async () => {
    const userId = await seedUser();
    const client = await seedClient();
    const { challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, { challenge });

    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: 'wrong-verifier',
        redirect_uri: REDIRECT_URI,
        client_id: client.clientId,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('returns invalid_grant on redirect_uri mismatch', async () => {
    const userId = await seedUser();
    const client = await seedClient();
    const { verifier, challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, { challenge });

    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'https://other.example.com/cb',
        client_id: client.clientId,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('returns invalid_grant on expired code', async () => {
    const userId = await seedUser();
    const client = await seedClient();
    const { verifier, challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, {
      challenge,
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        client_id: client.clientId,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_grant');
  });

  it('returns invalid_client on unknown client_id', async () => {
    const userId = await seedUser();
    const client = await seedClient();
    const { verifier, challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, { challenge });
    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        client_id: 'not-a-real-client',
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_client');
  });
});

describe('POST /oauth/token — grant_type=refresh_token', () => {
  async function issueInitialTokens(): Promise<{ client: OAuthClientRow; userId: string; refresh: string }> {
    const userId = await seedUser();
    const client = await seedClient();
    const { verifier, challenge } = pkcePair();
    const { code } = await seedAuthCode(client.clientId, userId, { challenge });
    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
        client_id: client.clientId,
      }).toString(),
    });
    const json = await res.json();
    return { client, userId, refresh: json.refresh_token };
  }

  it('rotates the refresh token on successful refresh', async () => {
    const { client, refresh } = await issueInitialTokens();
    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: client.clientId,
      }).toString(),
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.access_token).toBeTruthy();
    expect(json.refresh_token).toBeTruthy();
    expect(json.refresh_token).not.toBe(refresh);
  });

  it('revokes the whole family on reuse of a rotated refresh token', async () => {
    const { client, refresh } = await issueInitialTokens();
    // First refresh — rotates the presented token.
    await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: client.clientId,
      }).toString(),
    });
    // Replay the original refresh — must trip reuse detection.
    const replay = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refresh,
        client_id: client.clientId,
      }).toString(),
    });
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe('invalid_grant');

    const rows = (await db.execute(sql`
      SELECT revoked_at FROM oauth_refresh_tokens
    `)) as unknown as { revoked_at: Date | null }[];
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
  });

  it('returns unsupported_grant_type for unknown grants', async () => {
    const res = await makeApp().request('/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'password' }).toString(),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unsupported_grant_type');
  });
});
