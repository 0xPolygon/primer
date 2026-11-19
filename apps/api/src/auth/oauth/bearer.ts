import { createHash } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import type { AuthUser } from '../../app.ts';
import type { UserResolver } from '../resolver.ts';
import { agentEmail } from '../agents.ts';
import { ACCESS_TOKEN_PREFIX, hashHex } from './tokens.ts';

interface OAuthBearerRow {
  user_id: string;
  client_id: string;
  client_name: string;
}

/**
 * The agent an OAuth MCP client acts as for one person: one per (client,
 * person), named after the client, acting via the person. Created on first
 * use; the client's later name changes follow.
 */
export async function ensureOAuthAgent(clientId: string, clientName: string, userId: string): Promise<AuthUser> {
  const id = `agent_oauth_${createHash('sha256').update(`${clientId}:${userId}`).digest('hex').slice(0, 24)}`;
  await db.execute(sql`
    INSERT INTO users (id, email, display_name, kind, via_user_id)
    VALUES (${id}, ${agentEmail(id)}, ${clientName}, 'agent', ${userId})
    ON CONFLICT (id) DO UPDATE SET display_name = excluded.display_name
      WHERE users.display_name IS DISTINCT FROM excluded.display_name
  `);
  return { id, email: agentEmail(id), displayName: clientName, kind: 'agent', viaUserId: userId };
}

/**
 * Resolves `Authorization: Bearer primer_oat_<...>` to the client's agent for
 * the person who authorized it (see ensureOAuthAgent). Token rows stay keyed
 * to the person; only the resolved identity is the agent.
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
      SELECT t.user_id, t.client_id, oc.client_name
      FROM oauth_access_tokens t
      INNER JOIN oauth_clients oc ON oc.client_id = t.client_id
      WHERE t.token_hash = ${tokenHash}
        AND t.expires_at > now()
      LIMIT 1
    `)) as unknown as OAuthBearerRow[];

    const row = rows[0];
    if (!row) return null;

    c.set('authMethod', 'bearer');
    // OAuth tokens carry no scopes yet, so `tokenScopes` stays unset and the
    // scope checks in auth/scopes.ts don't apply to them.
    return ensureOAuthAgent(row.client_id, row.client_name, row.user_id);
  };
}
