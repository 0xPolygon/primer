import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { sessions, users } from '@primer/shared/schema';
import { createApp } from '../app.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { mockResolver, makeOktaResolver } from '../auth/resolver.ts';
import { makeMockOktaAdapter } from '../auth/okta.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSession } from '../auth/session.ts';

async function withAppForAuth<T>(fn: (app: ReturnType<typeof createApp>) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-auth-'));
  try {
    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: mockResolver,
      oktaAdapter: makeMockOktaAdapter(),
      authCookieName: 'primer_sid',
      authStateCookieName: 'primer_auth_state',
    });
    return await fn(app);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('GET /auth/login', () => {
  it('302 redirects to Okta with state cookie set', async () => {
    await withAppForAuth(async (app) => {
      const res = await app.request('/auth/login', { redirect: 'manual' });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('https://mock-okta.test/authorize?fake=1');
      const setCookie = res.headers.get('set-cookie');
      expect(setCookie).not.toBeNull();
      expect(setCookie).toContain('primer_auth_state=');
      expect(setCookie).toContain('HttpOnly');
      expect(setCookie).toContain('Path=/');
    });
  });

  it('persists return_to in the state cookie payload', async () => {
    await withAppForAuth(async (app) => {
      const res = await app.request('/auth/login?return_to=%2Fd%2Fabc', { redirect: 'manual' });
      expect(res.status).toBe(302);
      const setCookie = res.headers.get('set-cookie') ?? '';
      expect(setCookie).toContain('primer_auth_state=');
    });
  });

  it('rejects an off-origin return_to with default fallback', async () => {
    await withAppForAuth(async (app) => {
      const res = await app.request('/auth/login?return_to=https%3A%2F%2Fevil.example%2F', { redirect: 'manual' });
      expect(res.status).toBe(302);
      // The cookie should encode returnTo='/' not the malicious URL — covered by T12 callback tests.
    });
  });
});

describe('GET /auth/callback', () => {
  it('rejects when state cookie is missing', async () => {
    await withAppForAuth(async (app) => {
      const res = await app.request('/auth/callback?code=abc&state=xyz', { redirect: 'manual' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_state');
    });
  });

  it('rejects when state in URL does not match state in cookie', async () => {
    await withAppForAuth(async (app) => {
      // Set up a state cookie by hitting /auth/login first.
      const loginRes = await app.request('/auth/login', { redirect: 'manual' });
      const setCookie = loginRes.headers.get('set-cookie') ?? '';
      // Pull just the cookie name=value part to send back.
      const cookieValue = setCookie.split(';')[0]!;
      const res = await app.request('/auth/callback?code=abc&state=WRONG-STATE', {
        redirect: 'manual',
        headers: { cookie: cookieValue },
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('invalid_state');
    });
  });

  it('happy path: creates user + session, sets primer_sid cookie, redirects to returnTo', async () => {
    await withAppForAuth(async (app) => {
      const loginRes = await app.request('/auth/login?return_to=%2Fd%2Fdest', { redirect: 'manual' });
      const cookieValue = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;

      const res = await app.request('/auth/callback?code=fake-code&state=mock-state', {
        redirect: 'manual',
        headers: { cookie: cookieValue },
      });
      expect(res.status).toBe(302);
      expect(res.headers.get('location')).toBe('/d/dest');

      const setCookies = res.headers.get('set-cookie') ?? '';
      expect(setCookies).toContain('primer_sid=');
      expect(setCookies).toContain('primer_auth_state=;');  // cleared

      // The mock adapter's default claims:
      const [user] = await db.select().from(users).where(eq(users.id, 'okta-sub-123'));
      expect(user).toBeDefined();
      expect(user.email).toBe('alice@polygon.technology');
      expect(user.displayName).toBe('Alice Tester');

      const sids = await db
        .select()
        .from(sessions)
        .where(eq(sessions.userId, 'okta-sub-123'));
      expect(sids.length).toBeGreaterThan(0);
    });
  });

  it('upserts user on subsequent login (name change propagates)', async () => {
    await withAppForAuth(async (app) => {
      // Pre-seed the user with an old name.
      await db.insert(users).values({
        id: 'okta-sub-123',
        email: 'alice@polygon.technology',
        displayName: 'Alice Old Name',
      }).onConflictDoNothing();

      const loginRes = await app.request('/auth/login', { redirect: 'manual' });
      const cookieValue = (loginRes.headers.get('set-cookie') ?? '').split(';')[0]!;
      await app.request('/auth/callback?code=fake-code&state=mock-state', {
        redirect: 'manual',
        headers: { cookie: cookieValue },
      });

      const [updated] = await db.select().from(users).where(eq(users.id, 'okta-sub-123'));
      expect(updated.displayName).toBe('Alice Tester');   // upserted from claims
    });
  });
});

async function withAuthenticatedApp<T>(
  fn: (app: ReturnType<typeof createApp>, ctx: { sid: string; userId: string }) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'primer-auth-logout-'));
  try {
    const userId = `logout-user-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(users).values({
      id: userId,
      email: `${userId}@p.t`,
      displayName: userId,
    });
    const { id: sid } = await createSession({ userId, userAgent: null });

    const app = createApp({
      storage: new FilesystemStorage(root),
      notifier: new NoopNotifier(),
      userResolver: makeOktaResolver({ cookieName: 'primer_sid' }),
      oktaAdapter: makeMockOktaAdapter(),
      authCookieName: 'primer_sid',
      authStateCookieName: 'primer_auth_state',
    });
    return await fn(app, { sid, userId });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('POST /auth/logout', () => {
  it('204 deletes the session row and clears the cookie', async () => {
    await withAuthenticatedApp(async (app, { sid }) => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: {
          cookie: `primer_sid=${sid}`,
          'x-primer-csrf': '1',
        },
      });
      expect(res.status).toBe(204);
      const setCookies = res.headers.get('set-cookie') ?? '';
      expect(setCookies).toContain('primer_sid=;');
      expect(setCookies).toContain('Max-Age=0');

      const rows = await db.select().from(sessions).where(eq(sessions.id, sid));
      expect(rows).toHaveLength(0);
    });
  });

  it('401 if no session cookie present', async () => {
    await withAuthenticatedApp(async (app) => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: { 'x-primer-csrf': '1' },
      });
      expect(res.status).toBe(401);
    });
  });

  it('403 if CSRF header missing', async () => {
    await withAuthenticatedApp(async (app, { sid }) => {
      const res = await app.request('/auth/logout', {
        method: 'POST',
        headers: { cookie: `primer_sid=${sid}` },
      });
      expect(res.status).toBe(403);
    });
  });
});
