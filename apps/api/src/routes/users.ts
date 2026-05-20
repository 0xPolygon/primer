import type { Hono } from 'hono';
import { ne } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import { users } from '@primer/shared/schema';
import { db } from '../db/client.ts';
import type { MentionableUsersResponse } from '@primer/shared';

export function registerUserRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/users/mentionable', async (c) => {
    const me = c.get('user');
    const rows = await db
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(ne(users.id, me.id));
    const body: MentionableUsersResponse = { users: rows };
    return c.json(body, 200);
  });
}
