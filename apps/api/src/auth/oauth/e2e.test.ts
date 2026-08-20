import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { createApp } from '../../app.ts';
import { FilesystemStorage } from '../../storage/filesystem.ts';
import { NoopNotifier } from '../../notifications/notifier.ts';
import { db } from '../../db/client.ts';
import {
  oauthAccessTokens,
  oauthAuthorizationCodes,
  oauthClients,
  oauthConsents,
  oauthRefreshTokens,
  sessions,
  users,
} from '../../db/schema.ts';

const AUTH_BASE_URL = 'http://localhost:5173';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

async function withApp<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-oauth-e2e-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      authBaseUrl: AUTH_BASE_URL,
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  for (const table of [
    oauthAccessTokens,
    oauthRefreshTokens,
    oauthAuthorizationCodes,
    oauthConsents,
    oauthClients,
    sessions,
  ]) {
    await db.delete(table);
  }
  await db.execute(sql`DELETE FROM users WHERE id LIKE 'u-%' OR id LIKE 'mcp-%'`);
});

describe('OAuth end-to-end (register → authorize → token)', () => {
  it('completes the full flow and issues an access token', async () => {
    // Seed a session so /oauth/authorize doesn't redirect to Okta.
    const userId = `u-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(users).values({ id: userId, email: `${userId}@x.test`, displayName: userId });
    const sid = `s-${randomBytes(16).toString('hex')}`;
    await db.insert(sessions).values({
      id: sid,
      userId,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    });

    await withApp(async (app) => {
      // 1. Register.
      const regRes = await app.request('/oauth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          client_name: 'e2e',
          redirect_uris: [REDIRECT_URI],
          grant_types: ['authorization_code', 'refresh_token'],
        }),
      });
      expect(regRes.status).toBe(201);
      const { client_id } = await regRes.json();

      // 2. Authorize (with existing consent to keep test simple: allow via consent form).
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');

      const authRes = await app.request('/oauth/consent', {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          cookie: `primer_sid=${sid}`,
          'x-primer-csrf': '1',
        },
        body: new URLSearchParams({
          client_id,
          redirect_uri: REDIRECT_URI,
          response_type: 'code',
          code_challenge: challenge,
          code_challenge_method: 'S256',
          state: 'e2e',
          scope: 'primer',
          decision: 'allow',
        }).toString(),
      });
      expect(authRes.status).toBe(302);
      const loc = new URL(authRes.headers.get('location') ?? '', 'http://x');
      const code = loc.searchParams.get('code');
      expect(code).toBeTruthy();

      // 3. Exchange code for tokens.
      const tokenRes = await app.request('/oauth/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: code!,
          code_verifier: verifier,
          redirect_uri: REDIRECT_URI,
          client_id,
        }).toString(),
      });
      expect(tokenRes.status).toBe(200);
      const tokens = await tokenRes.json();
      expect(tokens.token_type).toBe('bearer');
      expect(typeof tokens.access_token).toBe('string');
      expect(typeof tokens.refresh_token).toBe('string');
    });
  });
});
