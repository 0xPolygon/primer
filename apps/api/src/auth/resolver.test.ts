import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { mockMultiResolver, makeOktaResolver, MOCK_USER } from './resolver.ts';
import { createSession } from './session.ts';
import { db } from '../db/client.ts';
import { users } from '../db/schema.ts';

function makeReq(cookieHeader?: string) {
  const app = new Hono<{ Variables: AppVariables }>();
  let captured: { user: string | null } = { user: null };
  let resolverUnderTest: ReturnType<typeof makeOktaResolver>;
  app.get('/test', async (c) => {
    const user = await resolverUnderTest(c);
    captured.user = user?.id ?? null;
    return c.text('ok');
  });
  return {
    async run(resolver: ReturnType<typeof makeOktaResolver>) {
      resolverUnderTest = resolver;
      await app.request('/test', {
        headers: cookieHeader ? { cookie: cookieHeader } : {},
      });
      return captured.user;
    },
  };
}

describe('oktaResolver (real path via lookupSession)', () => {
  it('returns null when no cookie is present', async () => {
    const resolver = makeOktaResolver({ cookieName: 'primer_sid' });
    const got = await makeReq().run(resolver);
    expect(got).toBeNull();
  });

  it('returns null when the cookie does not match a session', async () => {
    const resolver = makeOktaResolver({ cookieName: 'primer_sid' });
    const got = await makeReq('primer_sid=does-not-exist').run(resolver);
    expect(got).toBeNull();
  });

  it('returns the user when the cookie matches a live session', async () => {
    const userId = `user-resolver-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(users).values({
      id: userId,
      email: `${userId}@p.t`,
      displayName: userId,
    });
    const { id } = await createSession({ userId, userAgent: null });

    const resolver = makeOktaResolver({ cookieName: 'primer_sid' });
    const got = await makeReq(`primer_sid=${id}`).run(resolver);
    expect(got).toBe(userId);
  });
});

describe('mockMultiResolver', () => {
  it('returns MOCK_USER when no header is set', async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    let captured: string | null = null;
    app.get('/test', async (c) => {
      const user = await mockMultiResolver(c);
      captured = user?.id ?? null;
      return c.text('ok');
    });
    await app.request('/test');
    expect(captured).toBe(MOCK_USER.id);
  });

  it('returns the synthesized user for an explicit header', async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    let captured: { id: string; email: string; displayName: string } | null = null;
    app.get('/test', async (c) => {
      const user = await mockMultiResolver(c);
      captured = user;
      return c.text('ok');
    });
    await app.request('/test', { headers: { 'x-mock-user-id': 'mock-user-2' } });
    const c = captured as { id: string; email: string; displayName: string } | null;
    expect(c?.id).toBe('mock-user-2');
    expect(c?.email).toBe('mock-user-2@polygon.technology');
    expect(c?.displayName).toBe('mock-user-2');
  });
});
