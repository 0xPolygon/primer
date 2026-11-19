import type { Context, Hono } from 'hono';
import { sql } from 'drizzle-orm';
import { db } from '../../db/client.ts';
import { recheckLive } from '../../live/revoke.ts';
import { ACCESS_TOKEN_PREFIX, REFRESH_TOKEN_PREFIX, hashHex } from './tokens.ts';

async function readForm(c: Context): Promise<URLSearchParams> {
  const raw = await c.req.text();
  return new URLSearchParams(raw);
}

export function registerOAuthRevocationRoute(app: Hono): void {
  app.post('/oauth/revoke', async (c) => {
    const body = await readForm(c);
    const token = body.get('token') ?? '';
    if (token.length === 0) return c.body(null, 200);

    const tokenHash = hashHex(token);

    if (token.startsWith(REFRESH_TOKEN_PREFIX)) {
      // Revoke by family so a captured refresh + rotated successor can't survive.
      await db.execute(sql`
        UPDATE oauth_refresh_tokens
        SET revoked_at = now()
        WHERE family_id IN (
          SELECT family_id FROM oauth_refresh_tokens WHERE token_hash = ${tokenHash}
        ) AND revoked_at IS NULL
      `);
    } else if (token.startsWith(ACCESS_TOKEN_PREFIX)) {
      await db.execute(sql`DELETE FROM oauth_access_tokens WHERE token_hash = ${tokenHash}`);
      await recheckLive({ credentialHash: tokenHash });
    }
    // Unknown tokens: 200 per RFC 7009.
    return c.body(null, 200);
  });
}
