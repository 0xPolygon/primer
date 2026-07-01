import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import type { UserResolver } from '../resolver.ts';
import { ACCESS_TOKEN_PREFIX, hashHex } from './tokens.ts';

interface OAuthBearerRow {
  id: string;
  email: string;
  display_name: string;
}

/**
 * Resolves `Authorization: Bearer primer_oat_<...>` to a user.
 *
 * Falls through (returns null) when:
 *   - the header is missing or not `Bearer <...>`,
 *   - the token doesn't carry the `primer_oat_` prefix,
 *   - the hashed token matches no live row.
 *
 * This resolver is inserted BEFORE the PAT bearer resolver in the chain, so
 * OAuth-issued tokens win when their prefix matches, and PAT tokens continue
 * to work when they don't.
 */
export function makeOAuthBearerResolver(): UserResolver {
  return async (c) => {
    const header = c.req.header('authorization');
    if (!header) return null;
    if (!header.startsWith('Bearer ')) return null;
    const token = header.slice('Bearer '.length).trim();
    if (!token.startsWith(ACCESS_TOKEN_PREFIX)) return null;

    const tokenHash = hashHex(token);
    const rows = (await db.execute(sql`
      SELECT u.id, u.email, u.display_name
      FROM oauth_access_tokens t
      INNER JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ${tokenHash}
        AND t.expires_at > now()
      LIMIT 1
    `)) as unknown as OAuthBearerRow[];

    const row = rows[0];
    if (!row) return null;

    c.set('authMethod', 'bearer');
    return { id: row.id, email: row.email, displayName: row.display_name };
  };
}
