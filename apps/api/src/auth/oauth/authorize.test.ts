import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import {
  oauthAuthorizationCodes,
  oauthClients,
  oauthConsents,
  sessions,
  users,
} from '@primer/shared/schema';
import { registerOAuthAuthorizationRoutes } from './authorize.ts';
import { createClient } from './clients.ts';
import { csrfMiddleware } from '../csrf.ts';

const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

async function seedUserAndSession(): Promise<{ userId: string; sid: string }> {
  const userId = `u-${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(users).values({ id: userId, email: `${userId}@x.test`, displayName: userId });
  const sid = `s-${Math.random().toString(36).slice(2, 24)}`;
  await db.insert(sessions).values({
    id: sid,
    userId,
    expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
  });
  return { userId, sid };
}

function makeApp(): Hono {
  const app = new Hono();
  app.use('*', csrfMiddleware);
  registerOAuthAuthorizationRoutes(app, { sessionCookieName: 'primer_sid' });
  return app;
}

beforeEach(async () => {
  await db.delete(oauthAuthorizationCodes);
  await db.delete(oauthConsents);
  await db.delete(oauthClients);
  await db.delete(sessions);
});

function authorizeUrl(clientId: string, extra: Record<string, string> = {}): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'primer',
    ...extra,
  });
  return `/oauth/authorize?${params.toString()}`;
}

describe('GET /oauth/authorize', () => {
  it('302s to /auth/login when the session cookie is missing', async () => {
    const client = await createClient({
      clientName: 'C',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const res = await makeApp().request(authorizeUrl(client.clientId));
    expect(res.status).toBe(302);
    const loc = res.headers.get('location') ?? '';
    expect(loc.startsWith('/auth/login?return_to=')).toBe(true);
    expect(decodeURIComponent(loc.split('return_to=')[1])).toContain('/oauth/authorize');
  });

  it('renders a consent form when the session is valid and no prior consent exists', async () => {
    const { sid } = await seedUserAndSession();
    const client = await createClient({
      clientName: 'Claude',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const res = await makeApp().request(authorizeUrl(client.clientId), {
      headers: { cookie: `primer_sid=${sid}` },
    });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('Claude');
    expect(html).toContain('Allow');
    expect(html).toContain('Deny');
    // CSRF token round-trips through the form as a hidden input.
    expect(html).toMatch(/name="csrf"/);
  });

  it('skips the form and 302s with a code when consent already exists', async () => {
    const { userId, sid } = await seedUserAndSession();
    const client = await createClient({
      clientName: 'Claude',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    await db.insert(oauthConsents).values({
      id: uuidv7(),
      userId,
      clientId: client.clientId,
      scopes: ['primer'],
    });
    const res = await makeApp().request(authorizeUrl(client.clientId), {
      headers: { cookie: `primer_sid=${sid}` },
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '', 'http://x');
    expect(loc.origin + loc.pathname).toBe(REDIRECT_URI);
    expect(loc.searchParams.get('code')).toBeTruthy();
    expect(loc.searchParams.get('state')).toBe('xyz');

    const codes = await db.execute(sql`SELECT COUNT(*)::int AS n FROM oauth_authorization_codes`);
    expect((codes as unknown as { n: number }[])[0].n).toBe(1);
  });

  it('renders an error page for an unknown redirect_uri (no redirect)', async () => {
    const { sid } = await seedUserAndSession();
    const client = await createClient({
      clientName: 'C',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const res = await makeApp().request(
      authorizeUrl(client.clientId, { redirect_uri: 'https://evil.example.com/cb' }),
      { headers: { cookie: `primer_sid=${sid}` } },
    );
    expect(res.status).toBe(400);
    const html = await res.text();
    expect(html).toContain('invalid_redirect_uri');
  });

  it('302s to the redirect_uri with error=invalid_request on missing code_challenge', async () => {
    const { sid } = await seedUserAndSession();
    const client = await createClient({
      clientName: 'C',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const params = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'primer',
    });
    const res = await makeApp().request(`/oauth/authorize?${params.toString()}`, {
      headers: { cookie: `primer_sid=${sid}` },
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '', 'http://x');
    expect(loc.searchParams.get('error')).toBe('invalid_request');
    expect(loc.searchParams.get('state')).toBe('xyz');
  });
});

describe('POST /oauth/consent', () => {
  it('records consent and 302s with a code on Allow', async () => {
    const { userId, sid } = await seedUserAndSession();
    const client = await createClient({
      clientName: 'Claude',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const body = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'primer',
      decision: 'allow',
    });
    const res = await makeApp().request('/oauth/consent', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `primer_sid=${sid}`,
        'x-primer-csrf': '1',
      },
      body: body.toString(),
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '', 'http://x');
    expect(loc.searchParams.get('code')).toBeTruthy();

    const consents = await db.execute(sql`SELECT user_id AS "userId" FROM oauth_consents`);
    expect((consents as unknown as { userId: string }[])[0].userId).toBe(userId);
  });

  it('302s with error=access_denied on Deny (and no consent row is created)', async () => {
    const { sid } = await seedUserAndSession();
    const client = await createClient({
      clientName: 'C',
      redirectUris: [REDIRECT_URI],
      grantTypes: ['authorization_code', 'refresh_token'],
    });
    const body = new URLSearchParams({
      client_id: client.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'primer',
      decision: 'deny',
    });
    const res = await makeApp().request('/oauth/consent', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `primer_sid=${sid}`,
        'x-primer-csrf': '1',
      },
      body: body.toString(),
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location') ?? '', 'http://x');
    expect(loc.searchParams.get('error')).toBe('access_denied');

    const consents = await db.execute(sql`SELECT COUNT(*)::int AS n FROM oauth_consents`);
    expect((consents as unknown as { n: number }[])[0].n).toBe(0);
  });
});
