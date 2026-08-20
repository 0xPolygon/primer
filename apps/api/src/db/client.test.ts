import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from './client.ts';
import { users } from './schema.ts';

describe('db client', () => {
  it('reads the seeded mock user', async () => {
    const rows = await db.select().from(users).where(eq(users.id, 'mock-user-1'));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'mock-user-1',
      email: 'mock@polygon.technology',
      displayName: 'Mock User',
    });
  });
});
