import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { sessions, users } from '../db/schema.ts';
import {
  createSession,
  lookupSession,
  deleteSession,
  refreshSessionIfStale,
  SESSION_TTL_MS,
} from './session.ts';

async function seedUser(id = `u-${Math.random().toString(36).slice(2, 10)}`) {
  await db.insert(users).values({
    id,
    email: `${id}@polygon.technology`,
    displayName: id,
  });
  return id;
}

describe('createSession', () => {
  it('inserts a row, returns id + expiresAt', async () => {
    const userId = await seedUser();
    const result = await createSession({ userId, userAgent: 'vitest' });
    expect(result.id).toMatch(/^[a-f0-9]{64}$/);
    expect(result.expiresAt.getTime()).toBeGreaterThan(Date.now() + SESSION_TTL_MS - 5_000);
    expect(result.expiresAt.getTime()).toBeLessThan(Date.now() + SESSION_TTL_MS + 5_000);

    const [row] = await db
      .select()
      .from(sessions)
      .where(eq(sessions.id, result.id));
    expect(row.userId).toBe(userId);
    expect(row.userAgent).toBe('vitest');
  });

  it('accepts null userAgent', async () => {
    const userId = await seedUser();
    const result = await createSession({ userId, userAgent: null });
    const [row] = await db.select().from(sessions).where(eq(sessions.id, result.id));
    expect(row.userAgent).toBeNull();
  });
});

describe('lookupSession', () => {
  it('returns user + session for a live id', async () => {
    const userId = await seedUser();
    const { id } = await createSession({ userId, userAgent: null });

    const found = await lookupSession(id);
    expect(found).not.toBeNull();
    expect(found?.user.id).toBe(userId);
    expect(found?.session.id).toBe(id);
  });

  it('returns null for unknown id', async () => {
    const found = await lookupSession('does-not-exist');
    expect(found).toBeNull();
  });

  it('returns null for an expired session', async () => {
    const userId = await seedUser();
    const expiredId = 'a'.repeat(64);
    await db.insert(sessions).values({
      id: expiredId,
      userId,
      expiresAt: new Date(Date.now() - 60_000),
      lastSeenAt: new Date(),
      createdAt: new Date(),
    });
    const found = await lookupSession(expiredId);
    expect(found).toBeNull();
  });
});

describe('deleteSession', () => {
  it('removes the row', async () => {
    const userId = await seedUser();
    const { id } = await createSession({ userId, userAgent: null });
    await deleteSession(id);
    const found = await lookupSession(id);
    expect(found).toBeNull();
  });

  it('is idempotent on missing id', async () => {
    await deleteSession('not-a-session');
    // Should not throw.
  });
});

describe('refreshSessionIfStale', () => {
  it('does NOT update when expiresAt is more than 7 days out', async () => {
    const userId = await seedUser();
    const { id } = await createSession({ userId, userAgent: null });
    const [before] = await db.select().from(sessions).where(eq(sessions.id, id));

    await refreshSessionIfStale(id);

    const [after] = await db.select().from(sessions).where(eq(sessions.id, id));
    expect(after.expiresAt.getTime()).toBe(before.expiresAt.getTime());
  });

  it('extends expiresAt when less than 7 days remain', async () => {
    const userId = await seedUser();
    const id = 'b'.repeat(64);
    const soonExpiry = new Date(Date.now() + 6 * 24 * 60 * 60 * 1000); // 6 days out
    await db.insert(sessions).values({
      id,
      userId,
      expiresAt: soonExpiry,
      lastSeenAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
    });

    await refreshSessionIfStale(id);

    const [after] = await db.select().from(sessions).where(eq(sessions.id, id));
    expect(after.expiresAt.getTime()).toBeGreaterThan(soonExpiry.getTime() + 60_000);
    expect(after.lastSeenAt.getTime()).toBeGreaterThan(Date.now() - 5_000);
  });
});
