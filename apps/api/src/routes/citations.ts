import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { listCitations } from '../live/citations.ts';
import { respond } from './choices.ts';

/** Evidence provenance (M10b.4): a live document's citations and what they cite. */
export function registerCitationRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/documents/:docId/citations', async (c) => respond(c, await listCitations(c.get('user'), c.req.param('docId'))));
}
