import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import type { ApiTokensListResponse } from '@primer/shared';
import { isAdmin, SERVICE_USER_ID } from '../auth/admin.ts';
import {
  listTokensForUser,
  mintTokenForUser,
  parseTokenName,
  revokeTokenForUser,
} from './tokenSummary.ts';

/**
 * Admin-gated management of the Claude service account's API tokens.
 * Tokens minted here authenticate as the service user (SERVICE_USER_ID), so
 * external tools using them act as Claude rather than as any employee.
 * Non-admins get 403 on every route; 404 is reserved for unknown token ids.
 */
export function registerServiceTokenRoutes(
  app: Hono<{ Variables: AppVariables }>,
  opts: { adminEmails: string[] },
): void {
  app.get('/api/service-tokens', async (c) => {
    if (!isAdmin(c.get('user'), opts.adminEmails)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body: ApiTokensListResponse = { tokens: await listTokensForUser(SERVICE_USER_ID) };
    return c.json(body, 200);
  });

  app.post('/api/service-tokens', async (c) => {
    if (!isAdmin(c.get('user'), opts.adminEmails)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_name' }, 400);
    }
    const name = parseTokenName((raw as { name?: unknown } | null)?.name);
    if (name === null) {
      return c.json({ error: 'invalid_name' }, 400);
    }

    const result = await mintTokenForUser(SERVICE_USER_ID, name);
    if (result === 'token_limit') {
      return c.json({ error: 'token_limit' }, 400);
    }
    // CRITICAL: do NOT log the token plaintext, token hash, or response body.
    return c.json(result, 201);
  });

  app.delete('/api/service-tokens/:id', async (c) => {
    if (!isAdmin(c.get('user'), opts.adminEmails)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const id = c.req.param('id');
    const found = await revokeTokenForUser(SERVICE_USER_ID, id);
    if (!found) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ ok: true }, 200);
  });
}
