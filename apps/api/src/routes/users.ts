import type { Hono } from 'hono';
import { and, eq, ilike, ne, notInArray, sql } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import { documents, documentCollaborators, users } from '../db/schema.ts';
import { db } from '../db/client.ts';
import type {
  MentionableUsersResponse,
  UserLookupResponse,
  UserSearchResponse,
} from '@polygonlabs/primer-api-types';
import { SERVICE_USER_ID } from '../auth/admin.ts';

const TYPEAHEAD_LIMIT = 20;

export function registerUserRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/users/mentionable', async (c) => {
    const me = c.get('user');
    const rows = await db
      .select({ id: users.id, displayName: users.displayName, email: users.email })
      .from(users)
      // Service accounts (Claude) can't be mentioned — they only act via API tokens.
      .where(and(ne(users.id, me.id), ne(users.id, SERVICE_USER_ID)));
    const body: MentionableUsersResponse = { users: rows };
    return c.json(body, 200);
  });

  // User-lookup primitive (issue #78): resolve a human-entered email to the
  // canonical server user id. Consumers name their responsible humans and
  // classify authority by comparing those identities against the
  // server-attributed row author on document events — that only works when
  // both sides live in the same id space, so tooling resolves up front and
  // refuses on an unresolvable entry rather than silently misclassifying.
  // Case-insensitive on the email; 404 when no user matches.
  app.get('/api/users/lookup', async (c) => {
    const email = (c.req.query('email') ?? '').trim();
    if (email.length === 0) {
      return c.json({ error: 'bad_request', message: 'email query param is required' }, 400);
    }
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email.toLowerCase()}`)
      .limit(1);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const body: UserLookupResponse = { id: row.id };
    return c.json(body, 200);
  });

  app.get('/api/users', async (c) => {
    const q = (c.req.query('q') ?? '').trim();
    if (q.length === 0) {
      const empty: UserSearchResponse = { users: [] };
      return c.json(empty, 200);
    }

    const docId = c.req.query('docId') ?? null;

    // Excluded ids: caller + service account + (optionally) owner + existing collaborators.
    const excluded = new Set<string>([c.get('user').id, SERVICE_USER_ID]);
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
