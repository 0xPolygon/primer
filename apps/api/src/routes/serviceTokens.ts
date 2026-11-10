import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import type { ApiTokensListResponse } from '@polygonlabs/primer-api-types';
import { isAdmin, SERVICE_USER_ID } from '../auth/admin.ts';
import { sessionOnly } from '../auth/sessionOnly.ts';
import {
  listTokensForUser,
  mintTokenForUser,
  parseCreateTokenBody,
  revokeTokenForUser,
} from './tokenSummary.ts';

/**
 * Admin-gated management of the Claude service account's API tokens.
 * Tokens minted here authenticate as the service user (SERVICE_USER_ID), so
 * external tools using them act as Claude rather than as any employee.
 * Non-admins get 403 on every route; 404 is reserved for unknown token ids.
 * Every route is session-only: no API token — the service token included —
 * can manage service tokens, even if its user is on the admin allowlist.
 * Service tokens must be minted with explicit scopes: one shared identity
 * acting for many people should only ever hold the permissions it needs.
 */
export function registerServiceTokenRoutes(
  app: Hono<{ Variables: AppVariables }>,
  opts: { adminEmails: string[] },
): void {
  app.get('/api/service-tokens', sessionOnly, async (c) => {
    if (!isAdmin(c.get('user'), opts.adminEmails)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    const body: ApiTokensListResponse = { tokens: await listTokensForUser(SERVICE_USER_ID) };
    return c.json(body, 200);
  });

  app.post('/api/service-tokens', sessionOnly, async (c) => {
    if (!isAdmin(c.get('user'), opts.adminEmails)) {
      return c.json({ error: 'forbidden' }, 403);
    }
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_name' }, 400);
    }
    const parsed = parseCreateTokenBody(raw);
    if (!parsed.ok) {
      return c.json({ error: parsed.error }, 400);
    }
    if (parsed.scopes === null) {
      return c.json({ error: 'scopes_required' }, 400);
    }

    const result = await mintTokenForUser(SERVICE_USER_ID, parsed.name, parsed.scopes);
    if (result === 'token_limit') {
      return c.json({ error: 'token_limit' }, 400);
    }
    // CRITICAL: do NOT log the token plaintext, token hash, or response body.
    return c.json(result, 201);
  });

  app.delete('/api/service-tokens/:id', sessionOnly, async (c) => {
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
