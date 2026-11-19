// Awareness of change over REST (M10b.1). Thin: live/catchup.ts holds the
// logic; MCP primer_get_digest calls the same function.
import type { Hono } from 'hono';
import type { AppDeps, AppVariables } from '../app.ts';
import { getCatchUp, getDigest } from '../live/catchup.ts';
import { sendDigestEmail } from '../live/digestEmail.ts';

const DAY = 24 * 60 * 60 * 1000;

/** A `since` time: ISO 8601, not in the future, at most 30 days back.
 *  Missing means the last 24 hours. */
export function parseDigestSince(raw: unknown): Date | null {
  if (raw === undefined || raw === null || raw === '') return new Date(Date.now() - DAY);
  if (typeof raw !== 'string') return null;
  const at = new Date(raw);
  if (Number.isNaN(at.getTime()) || at.getTime() > Date.now() || at.getTime() < Date.now() - 30 * DAY) return null;
  return at;
}

const badSince = { error: 'bad_request', message: 'since must be an ISO time within the last 30 days' } as const;

export function registerCatchUpRoutes(app: Hono<{ Variables: AppVariables }>, deps: AppDeps): void {
  // ?since=<ISO>&sinceVersion=<docVersion>: the caller's lastView from
  // GET /api/documents/:docId, or any earlier point.
  app.get('/api/documents/:docId/catchup', async (c) => {
    const since = c.req.query('since');
    if (!since || Number.isNaN(new Date(since).getTime())) return c.json(badSince, 400);
    const rawVersion = c.req.query('sinceVersion');
    const docVersion = rawVersion === undefined || rawVersion === '' ? null : Number(rawVersion);
    if (docVersion !== null && (!Number.isSafeInteger(docVersion) || docVersion < 0)) {
      return c.json({ error: 'bad_request', message: 'sinceVersion must be a docVersion' }, 400);
    }
    const out = await getCatchUp(c.get('user'), c.req.param('docId'), { at: since, docVersion });
    if (!out.ok) return c.json({ error: out.refusal.code, refusal: out.refusal }, out.status);
    return c.json(out.value, 200);
  });

  app.get('/api/me/digest', async (c) => {
    const since = parseDigestSince(c.req.query('since'));
    if (!since) return c.json(badSince, 400);
    return c.json(await getDigest(c.get('user'), since), 200);
  });

  // Emails the caller their digest now (people only; nothing when nothing changed).
  app.post('/api/me/digest/email', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { since?: unknown };
    const since = parseDigestSince(body?.since);
    if (!since) return c.json(badSince, 400);
    if (c.get('user').kind !== 'person') return c.json({ error: 'forbidden', message: 'agents have no mailbox' }, 403);
    return c.json(await sendDigestEmail(deps.notifier, c.get('user'), since), 200);
  });
}
