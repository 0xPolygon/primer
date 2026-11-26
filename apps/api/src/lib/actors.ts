import { sql, type SQL } from 'drizzle-orm';
import { users } from '../db/schema.ts';

/**
 * How an actor is named wherever Primer shows who did something: a person by
 * their display name; an agent as "<name> (via <person>)", or "<name>
 * (agent)" when it acts via no one. The suffix comes from the server, so an
 * agent (whose name its creator or OAuth client chose) can never pass as a
 * person.
 *
 * `actorNameOf('u')` is the same expression for raw SQL over a `users` alias.
 */
export function actorNameOf(alias: string): SQL<string> {
  const u = sql.raw(alias);
  return sql<string>`(CASE
    WHEN ${u}.kind IS DISTINCT FROM 'agent' THEN ${u}.display_name
    WHEN ${u}.via_user_id IS NULL THEN ${u}.display_name || ' (agent)'
    ELSE ${u}.display_name || ' (via ' || (SELECT via.display_name FROM users via WHERE via.id = ${u}.via_user_id) || ')'
  END)`;
}

/** actorNameOf for queries that join `users` unaliased (Drizzle selects). */
export const actorName: SQL<string> = actorNameOf('"users"');

/** Select columns naming a comment's author, for queries that join `users`
 *  on the author. Shared by every CommentDTO builder. */
export const authorColumns = {
  authorDisplayName: actorName,
  authorKind: users.kind,
  authorVia: sql<string | null>`(SELECT via.display_name FROM users via WHERE via.id = ${users.viaUserId})`,
};

/** Agent names come from untrusted input (a person's form, an OAuth
 *  client's registration): drop control and formatting characters (bidi
 *  overrides, zero-width), collapse whitespace, cap at 64 characters. */
export const MAX_AGENT_NAME = 64;
export function sanitizeAgentName(raw: string): string {
  return raw
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_AGENT_NAME)
    .trim();
}
