import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { actorNameOf } from '../lib/actors.ts';
import { hashToken, TOKEN_PREFIX } from './tokens.ts';
import type { UserResolver } from './resolver.ts';
import { parseStoredScopes } from './scopes.ts';

interface BearerLookupRow {
  id: string;
  email: string;
  display_name: string;
  kind: 'person' | 'agent';
  via_user_id: string | null;
  token_id: string;
  scopes: string[] | null;
}

/**
 * Fire-and-forget update of `last_used_at` on a successful bearer resolution.
 * Throttled DB-side: only writes when the existing value is null or older than 60s.
 * Mirrors the pattern in `refreshSessionIfStale` (session.ts:79).
 */
function touchTokenLastUsed(tokenId: string): void {
  void db
    .execute(
      sql`
        UPDATE api_tokens
        SET last_used_at = now()
        WHERE id = ${tokenId}
          AND (last_used_at IS NULL OR last_used_at < now() - interval '60 seconds')
      `
    )
    .catch(() => undefined);
}

/**
 * Resolves the request's `Authorization: Bearer <token>` header to a user.
 *
 * Returns null when:
 *   - the header is missing,
 *   - the header is not `Bearer <something>`,
 *   - the token doesn't carry the `primer_pat_` prefix,
 *   - the hashed token matches no live row (unknown, revoked, or expired).
 *
 * On success: sets `authMethod='bearer'` on the Hono context and returns the user.
 */
export function makeBearerResolver(): UserResolver {
  return async (c) => {
    const header = c.req.header('authorization');
    if (!header) return null;
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    if (!token.startsWith(TOKEN_PREFIX)) return null;

    const tokenHash = hashToken(token);
    const rows = (await db.execute(sql`
      SELECT u.id, u.email, ${actorNameOf('u')} AS display_name, u.kind, u.via_user_id, t.id AS token_id, t.scopes
      FROM api_tokens t
      INNER JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ${tokenHash}
        AND t.revoked_at IS NULL
        AND (t.expires_at IS NULL OR t.expires_at > now())
      LIMIT 1
    `)) as unknown as BearerLookupRow[];

    const row = rows[0];
    if (!row) return null;

    touchTokenLastUsed(row.token_id);
    c.set('authMethod', 'bearer');
    const scopes = parseStoredScopes(row.scopes);
    if (scopes !== null) c.set('tokenScopes', scopes);
    return { id: row.id, email: row.email, displayName: row.display_name, kind: row.kind, viaUserId: row.via_user_id };
  };
}

/**
 * Composes resolvers by trying them in order. Returns the first non-null user;
 * short-circuits so later resolvers never run when an earlier one wins.
 */
export function composeResolvers(...resolvers: UserResolver[]): UserResolver {
  return async (c) => {
    for (const r of resolvers) {
      const u = await r(c);
      if (u) return u;
    }
    return null;
  };
}
