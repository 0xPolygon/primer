import { sql } from 'drizzle-orm';
import { users } from '../db/schema.ts';

/** Select columns naming a comment's author, for queries that join `users`
 *  on the author: display name, kind, and the display name of the person an
 *  agent acts via. Shared by every CommentDTO builder. */
export const authorColumns = {
  authorDisplayName: users.displayName,
  authorKind: users.kind,
  authorVia: sql<string | null>`(SELECT via.display_name FROM users via WHERE via.id = ${users.viaUserId})`,
};
