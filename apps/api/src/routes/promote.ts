import type { Hono } from 'hono';
import type { AppDeps, AppVariables } from '../app.ts';
import { promoteConversation, promoteThread, type PromoteResult } from '../live/promote.ts';

/** Promote a conversation into a document (M10b.5); MCP primer_promote_conversation calls the same function. */
export function registerPromoteRoutes(app: Hono<{ Variables: AppVariables }>, deps: AppDeps): void {
  const reply = (c: { json: (body: unknown, status: number) => Response }, out: PromoteResult) =>
    out.ok ? c.json(out.value, 201) : c.json({ error: out.refusal.code, refusal: out.refusal }, out.status);

  app.post('/api/documents/from-conversation', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'bad_request', message: 'body must be a JSON object' }, 400);
    return reply(c, await promoteConversation(deps.storage, c.get('user'), body as never));
  });

  app.post('/api/threads/:threadId/promote', async (c) => reply(c, await promoteThread(deps.storage, c.get('user'), c.req.param('threadId'))));
}
