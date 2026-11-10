import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import type { ApiTokensListResponse } from '@polygonlabs/primer-api-types';
import {
  listTokensForUser,
  mintTokenForUser,
  parseCreateTokenBody,
  revokeTokenForUser,
} from './tokenSummary.ts';
import { sessionOnly } from '../auth/sessionOnly.ts';

export function registerTokenRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/tokens', async (c) => {
    const user = c.get('user');
    const body: ApiTokensListResponse = { tokens: await listTokensForUser(user.id) };
    return c.json(body, 200);
  });

  // Minting is session-only: a bearer must not be able to mint a sibling
  // credential and read its plaintext back. Listing and revoking stay
  // bearer-callable (the local MCP server's logout revokes its own token).
  app.post('/api/tokens', sessionOnly, async (c) => {
    const user = c.get('user');
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

    const result = await mintTokenForUser(user.id, parsed.name, parsed.scopes);
    if (result === 'token_limit') {
      return c.json({ error: 'token_limit' }, 400);
    }
    // CRITICAL: do NOT log the token plaintext, token hash, or response body.
    return c.json(result, 201);
  });

  app.delete('/api/tokens/:id', async (c) => {
    const user = c.get('user');
    const id = c.req.param('id');
    const found = await revokeTokenForUser(user.id, id);
    if (!found) {
      return c.json({ error: 'not_found' }, 404);
    }
    return c.json({ ok: true }, 200);
  });
}
