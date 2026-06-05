import type { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import { db } from '../db/client.ts';
import type { ApiTokenSummary, ApiTokensListResponse } from '@primer/shared';

interface TokenRow {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: Date | string;
  lastUsedAt: Date | string | null;
  expiresAt: Date | string | null;
  revokedAt: Date | string | null;
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function toIsoNullable(value: Date | string | null): string | null {
  return value === null ? null : toIso(value);
}

/**
 * Converts a DB row to a public ApiTokenSummary. NEVER include `token_hash`
 * or any other secret material here.
 */
function toSummary(row: TokenRow): ApiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    createdAt: toIso(row.createdAt),
    lastUsedAt: toIsoNullable(row.lastUsedAt),
    expiresAt: toIsoNullable(row.expiresAt),
    revokedAt: toIsoNullable(row.revokedAt),
  };
}

export function registerTokenRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/tokens', async (c) => {
    const user = c.get('user');
    const rows = (await db.execute(sql`
      SELECT id,
             name,
             token_prefix AS "tokenPrefix",
             created_at AS "createdAt",
             last_used_at AS "lastUsedAt",
             expires_at AS "expiresAt",
             revoked_at AS "revokedAt"
      FROM api_tokens
      WHERE user_id = ${user.id}
      ORDER BY created_at DESC
    `)) as unknown as TokenRow[];
    const body: ApiTokensListResponse = { tokens: rows.map(toSummary) };
    return c.json(body, 200);
  });

  app.delete('/api/tokens/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');

    // Owner-scoped existence check — 404 leaks nothing about other users'
    // tokens (don't distinguish "not yours" from "doesn't exist").
    const rows = (await db.execute(sql`
      SELECT id FROM api_tokens
      WHERE id = ${id} AND user_id = ${user.id}
      LIMIT 1
    `)) as unknown as { id: string }[];
    if (rows.length === 0) {
      return c.json({ error: 'not_found' }, 404);
    }

    // Idempotent: a no-op UPDATE when revoked_at is already set still returns 200.
    await db.execute(sql`
      UPDATE api_tokens
      SET revoked_at = now()
      WHERE id = ${id} AND user_id = ${user.id} AND revoked_at IS NULL
    `);

    return c.json({ ok: true }, 200);
  });
}
