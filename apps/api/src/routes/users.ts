import type { Hono } from 'hono';
import { and, eq, ilike, ne, notInArray, sql } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import { documents, documentCollaborators, users } from '@primer/shared/schema';
import { db } from '../db/client.ts';
import type { MentionableUsersResponse, UserSearchResponse } from '@primer/shared';

const TYPEAHEAD_LIMIT = 20;

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

  app.get('/api/users', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length === 0) {
      const empty: UserSearchResponse = { users: [] };
      return c.json(empty, 200);
    }

    const docId = c.req.query('docId') ?? null;

    // Excluded ids: caller + (optionally) owner + existing collaborators.
    const excluded = new Set<string>([c.get('user').id]);
    if (docId) {
      const [doc] = await db
        .select({ uploaderId: documents.uploaderId })
        .from(documents)
        .where(eq(documents.id, docId));
      if (doc) {
        excluded.add(doc.uploaderId);
        const collabRows = await db
          .select({ userId: documentCollaborators.userId })
          .from(documentCollaborators)
          .where(eq(documentCollaborators.documentId, docId));
        for (const r of collabRows) excluded.add(r.userId);
      }
    }

    const rows = await db
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      .where(
        and(
          ilike(users.displayName, `${q}%`),
          notInArray(users.id, Array.from(excluded)),
        ),
      )
      .orderBy(sql`lower(${users.displayName})`)
      .limit(TYPEAHEAD_LIMIT);

    const body: UserSearchResponse = { users: rows };
    return c.json(body, 200);
  });
}
