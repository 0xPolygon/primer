import type { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AgentsListResponse, CreateAgentResponse } from '@polygonlabs/primer-api-types';
import type { AppVariables } from '../app.ts';
import { agentEmail } from '../auth/agents.ts';
import { sessionOnly } from '../auth/sessionOnly.ts';
import { db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { MAX_AGENT_NAME, sanitizeAgentName } from '../lib/actors.ts';
import { listTokensForUser, mintTokenForUser, parseCreateTokenBody, revokeTokenForUser } from './tokenSummary.ts';

/**
 * A person's agents: identities of their own (attribution, ownership) that
 * act via the person, capped at editor on the person's documents (see
 * lib/permissions.ts). Every route is session-only: no token, an agent's
 * included, can create agents or mint credentials. Tokens must be minted with
 * explicit scopes.
 */
export function registerAgentRoutes(app: Hono<{ Variables: AppVariables }>): void {
  /** The agent `agentId` if it acts via the caller. */
  async function myAgent(agentId: string, personId: string) {
    const [row] = await db
      .select({ id: users.id })
      .from(users)
      .where(and(eq(users.id, agentId), eq(users.kind, 'agent'), eq(users.viaUserId, personId)));
    return row ?? null;
  }

  app.get('/api/agents', sessionOnly, async (c) => {
    const me = c.get('user');
    const rows = await db
      .select({ id: users.id, displayName: users.displayName, createdAt: users.createdAt })
      .from(users)
      .where(and(eq(users.kind, 'agent'), eq(users.viaUserId, me.id)))
      .orderBy(desc(users.createdAt));
    const body: AgentsListResponse = {
      agents: await Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          displayName: r.displayName,
          createdAt: r.createdAt.toISOString(),
          tokens: await listTokensForUser(r.id),
        })),
      ),
    };
    return c.json(body, 200);
  });

  app.post('/api/agents', sessionOnly, async (c) => {
    const me = c.get('user');
    if (me.kind !== 'person') return c.json({ error: 'forbidden' }, 403);
    let raw: { displayName?: unknown };
    try {
      raw = (await c.req.json()) as { displayName?: unknown };
    } catch {
      return c.json({ error: 'invalid_body' }, 400);
    }
    const displayName = typeof raw?.displayName === 'string' ? sanitizeAgentName(raw.displayName) : '';
    if (displayName.length === 0) {
      return c.json({ error: 'invalid_body', message: `displayName must be 1–${MAX_AGENT_NAME} characters` }, 400);
    }
    const id = `agent_${uuidv7()}`;
    await db.insert(users).values({ id, email: agentEmail(id), displayName, kind: 'agent', viaUserId: me.id });
    const body: CreateAgentResponse = { id };
    return c.json(body, 201);
  });

  app.post('/api/agents/:agentId/tokens', sessionOnly, async (c) => {
    const agent = await myAgent(c.req.param('agentId'), c.get('user').id);
    if (!agent) return c.json({ error: 'not_found' }, 404);
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_name' }, 400);
    }
    const parsed = parseCreateTokenBody(raw);
    if (!parsed.ok) return c.json({ error: parsed.error }, 400);
    if (parsed.scopes === null) return c.json({ error: 'scopes_required' }, 400);
    const result = await mintTokenForUser(agent.id, parsed.name, parsed.scopes);
    if (result === 'token_limit') return c.json({ error: 'token_limit' }, 400);
    // CRITICAL: do NOT log the token plaintext, token hash, or response body.
    return c.json(result, 201);
  });

  app.delete('/api/agents/:agentId/tokens/:tokenId', sessionOnly, async (c) => {
    const agent = await myAgent(c.req.param('agentId'), c.get('user').id);
    if (!agent) return c.json({ error: 'not_found' }, 404);
    const found = await revokeTokenForUser(agent.id, c.req.param('tokenId'));
    if (!found) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true }, 200);
  });
}
