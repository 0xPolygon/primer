import { describe, it, expect, vi } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import { db } from '../db/client.ts';
import { apiTokens, users } from '@primer/shared/schema';
import { generateToken, TOKEN_PREFIX } from './tokens.ts';
import { makeBearerResolver, composeResolvers } from './bearer.ts';
import {
  makeOktaResolver,
  mockMultiResolver,
  type UserResolver,
} from './resolver.ts';
import { createSession } from './session.ts';

interface Captured {
  user: string | null;
  authMethod: AppVariables['authMethod'];
}

function makeReq(headers?: Record<string, string>) {
  const app = new Hono<{ Variables: AppVariables }>();
  const captured: Captured = { user: null, authMethod: undefined };
  let resolverUnderTest: UserResolver;
  app.get('/test', async (c) => {
    const user = await resolverUnderTest(c);
    captured.user = user?.id ?? null;
    captured.authMethod = c.get('authMethod');
    return c.text('ok');
  });
  return {
    async run(resolver: UserResolver) {
      resolverUnderTest = resolver;
      await app.request('/test', { headers: headers ?? {} });
      return captured;
    },
  };
}

async function seedUser(id = `bearer-user-${Math.random().toString(36).slice(2, 8)}`) {
  await db.insert(users).values({
    id,
    email: `${id}@polygon.technology`,
    displayName: id,
  });
  return id;
}

describe('makeBearerResolver', () => {
  it('returns null when no Authorization header is present', async () => {
    const got = await makeReq().run(makeBearerResolver());
    expect(got.user).toBeNull();
    expect(got.authMethod).toBeUndefined();
  });

  it('returns null when the Authorization header is not a Bearer scheme', async () => {
    const got = await makeReq({ authorization: 'Basic abc123' }).run(makeBearerResolver());
    expect(got.user).toBeNull();
    expect(got.authMethod).toBeUndefined();
  });

  it('returns null when the Bearer token does not start with TOKEN_PREFIX', async () => {
    const got = await makeReq({ authorization: 'Bearer not-a-primer-token' }).run(
      makeBearerResolver()
    );
    expect(got.user).toBeNull();
    expect(got.authMethod).toBeUndefined();
  });

  it('returns null when the token is well-formed but unknown to the DB', async () => {
    const fake = `${TOKEN_PREFIX}unknown-random-payload`;
    const got = await makeReq({ authorization: `Bearer ${fake}` }).run(makeBearerResolver());
    expect(got.user).toBeNull();
    expect(got.authMethod).toBeUndefined();
  });

  it('resolves a valid token to its user and sets authMethod=bearer', async () => {
    const userId = await seedUser();
    const { token, tokenHash, tokenPrefix } = generateToken();
    await db.insert(apiTokens).values({
      id: randomUUID(),
      userId,
      name: 'test token',
      tokenHash,
      tokenPrefix,
    });

    const got = await makeReq({ authorization: `Bearer ${token}` }).run(makeBearerResolver());
    expect(got.user).toBe(userId);
    expect(got.authMethod).toBe('bearer');
  });

  it('returns null for a revoked token', async () => {
    const userId = await seedUser();
    const { token, tokenHash, tokenPrefix } = generateToken();
    await db.insert(apiTokens).values({
      id: randomUUID(),
      userId,
      name: 'revoked token',
      tokenHash,
      tokenPrefix,
      revokedAt: new Date(),
    });

    const got = await makeReq({ authorization: `Bearer ${token}` }).run(makeBearerResolver());
    expect(got.user).toBeNull();
    expect(got.authMethod).toBeUndefined();
  });

  it('returns null for an expired token', async () => {
    const userId = await seedUser();
    const { token, tokenHash, tokenPrefix } = generateToken();
    await db.insert(apiTokens).values({
      id: randomUUID(),
      userId,
      name: 'expired token',
      tokenHash,
      tokenPrefix,
      expiresAt: new Date(Date.now() - 60_000),
    });

    const got = await makeReq({ authorization: `Bearer ${token}` }).run(makeBearerResolver());
    expect(got.user).toBeNull();
    expect(got.authMethod).toBeUndefined();
  });

  it('treats a non-expired token (expires_at in the future) as valid', async () => {
    const userId = await seedUser();
    const { token, tokenHash, tokenPrefix } = generateToken();
    await db.insert(apiTokens).values({
      id: randomUUID(),
      userId,
      name: 'future-expiry token',
      tokenHash,
      tokenPrefix,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

    const got = await makeReq({ authorization: `Bearer ${token}` }).run(makeBearerResolver());
    expect(got.user).toBe(userId);
    expect(got.authMethod).toBe('bearer');
  });

  it('updates last_used_at on a successful resolution (fire-and-forget)', async () => {
    const userId = await seedUser();
    const tokenId = randomUUID();
    const { token, tokenHash, tokenPrefix } = generateToken();
    await db.insert(apiTokens).values({
      id: tokenId,
      userId,
      name: 'touch-me token',
      tokenHash,
      tokenPrefix,
    });

    const got = await makeReq({ authorization: `Bearer ${token}` }).run(makeBearerResolver());
    expect(got.user).toBe(userId);

    // The update is fire-and-forget; poll until it lands rather than sleeping a
    // fixed duration that can flake on slow CI runners.
    await vi.waitFor(
      async () => {
        const [r] = await db.select().from(apiTokens).where(eq(apiTokens.id, tokenId));
        expect(r.lastUsedAt).not.toBeNull();
        expect(r.lastUsedAt!.getTime()).toBeGreaterThan(Date.now() - 5_000);
      },
      { timeout: 5_000, interval: 20 },
    );
  });
});

describe('composeResolvers', () => {
  it('returns null when every resolver returns null', async () => {
    const resolver = composeResolvers(
      async () => null,
      async () => null
    );
    const got = await makeReq().run(resolver);
    expect(got.user).toBeNull();
  });

  it('returns the first non-null result', async () => {
    const resolver = composeResolvers(
      async () => null,
      async (c) => {
        c.set('authMethod', 'mock');
        return { id: 'second', email: 'a@b', displayName: 'second' };
      }
    );
    const got = await makeReq().run(resolver);
    expect(got.user).toBe('second');
    expect(got.authMethod).toBe('mock');
  });

  it('short-circuits — later resolvers never run when an earlier one wins', async () => {
    const winner: UserResolver = async (c) => {
      c.set('authMethod', 'bearer');
      return { id: 'first', email: 'first@x', displayName: 'first' };
    };
    const throwsIfReached: UserResolver = async () => {
      throw new Error('later resolver must not run');
    };
    const resolver = composeResolvers(winner, throwsIfReached);
    const got = await makeReq().run(resolver);
    expect(got.user).toBe('first');
    expect(got.authMethod).toBe('bearer');
  });

  it('invalid bearer header + valid cookie ⇒ cookie wins, authMethod=cookie', async () => {
    const userId = `compose-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(users).values({
      id: userId,
      email: `${userId}@polygon.technology`,
      displayName: userId,
    });
    const { id: sid } = await createSession({ userId, userAgent: null });

    const resolver = composeResolvers(
      makeBearerResolver(),
      makeOktaResolver({ cookieName: 'primer_sid' })
    );

    const got = await makeReq({
      authorization: 'Bearer not-a-real-token',
      cookie: `primer_sid=${sid}`,
    }).run(resolver);

    expect(got.user).toBe(userId);
    expect(got.authMethod).toBe('cookie');
  });

  it('bearer wins over a valid cookie when the bearer is valid (composeResolvers order)', async () => {
    // Bearer-issuing user.
    const bearerUserId = `b-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(users).values({
      id: bearerUserId,
      email: `${bearerUserId}@polygon.technology`,
      displayName: bearerUserId,
    });
    const { token, tokenHash, tokenPrefix } = generateToken();
    await db.insert(apiTokens).values({
      id: randomUUID(),
      userId: bearerUserId,
      name: 'compose-bearer-wins',
      tokenHash,
      tokenPrefix,
    });

    // Cookie-issuing user (different identity, never used).
    const cookieUserId = `c-${Math.random().toString(36).slice(2, 8)}`;
    await db.insert(users).values({
      id: cookieUserId,
      email: `${cookieUserId}@polygon.technology`,
      displayName: cookieUserId,
    });
    const { id: sid } = await createSession({ userId: cookieUserId, userAgent: null });

    const resolver = composeResolvers(
      makeBearerResolver(),
      makeOktaResolver({ cookieName: 'primer_sid' })
    );

    const got = await makeReq({
      authorization: `Bearer ${token}`,
      cookie: `primer_sid=${sid}`,
    }).run(resolver);

    expect(got.user).toBe(bearerUserId);
    expect(got.authMethod).toBe('bearer');
  });
});

// Sanity: this file uses mockMultiResolver only to anchor the AppVariables import.
void mockMultiResolver;
