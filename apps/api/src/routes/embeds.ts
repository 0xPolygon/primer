// Embed blocks over REST: one read, for the viewer who asks. Thin: live/embeds.ts
// checks access and validates.
import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { resolveEmbed } from '../live/embeds.ts';
import { checkRateLimit } from '../lib/rateLimiter.ts';
import { respond } from './choices.ts';

export function registerEmbedRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/documents/:docId/embeds/:blockId', async (c) => {
    // A link card makes the server fetch a page: bound how often one viewer can ask.
    if (!checkRateLimit(`embeds:${c.get('user').id}`, 120)) return c.json({ error: 'rate_limited' }, 429);
    return respond(c, await resolveEmbed(c.get('user'), c.req.param('docId'), c.req.param('blockId')));
  });
}
