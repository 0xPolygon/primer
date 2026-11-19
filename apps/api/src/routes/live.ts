import type { Hono } from 'hono';
import type { LiveReadFormat } from '@polygonlabs/primer-api-types';
import type { AppVariables } from '../app.ts';
import { getLiveDoc } from '../live/read.ts';
import { applyOps } from '../live/ops.ts';
import { runViewer } from '../live/runs.ts';

/** Agent-facing reads and writes of live documents (live/read.ts, live/ops.ts). */
export function registerLiveRoutes(app: Hono<{ Variables: AppVariables }>): void {
  // ?format=markdown|html|json&tabId=&since=<docVersion>&from=<blockId>&to=<blockId>&runId=
  app.get('/api/documents/:docId/live', async (c) => {
    const q = c.req.query();
    const format = parseFormat(q.format);
    if (!format) return badRequest(c, 'format must be markdown, html or json.');
    const since = q.since === undefined ? undefined : Number(q.since);
    if (since !== undefined && (!Number.isInteger(since) || since < 0)) {
      return badRequest(c, 'since must be a docVersion (a non-negative integer).');
    }
    const tabId = q.tabId || 'main';
    if ((q.from === undefined) !== (q.to === undefined)) return badRequest(c, 'Pass both from and to, or neither.');
    const range = q.from !== undefined ? { from: { tabId, blockId: q.from }, to: { tabId, blockId: q.to! } } : undefined;
    const viewer = q.runId ? ((await runViewer(c.req.param('docId'), c.get('user'), q.runId)) ?? undefined) : undefined;
    const out = await getLiveDoc(c.req.param('docId'), c.get('user'), { format, tabId, since, range, viewer });
    if (!out.ok) return c.json({ error: out.refusal.code, refusal: out.refusal }, out.status);
    return c.json(out.value, 200);
  });

  // Body: ApplyOpsRequest. 200 with the Reconciliation (per-op outcomes); a
  // batch refused before anything applied is 400 with per-op `errors`.
  app.post('/api/documents/:docId/ops', async (c) => {
    const body = await jsonBody(c);
    if (body === null) return badRequest(c, 'The body must be a JSON object.');
    const out = await applyOps(c.req.param('docId'), c.get('user'), body);
    if (!out.ok) return c.json({ error: out.refusal.code, refusal: out.refusal, errors: out.errors ?? [] }, out.status);
    return c.json(out.value, 200);
  });
}

export function parseFormat(raw: unknown): LiveReadFormat | null {
  if (raw === undefined || raw === null || raw === '') return 'markdown';
  return raw === 'markdown' || raw === 'html' || raw === 'json' ? raw : null;
}

function badRequest(c: { json: (body: unknown, status: 400) => Response }, message: string): Response {
  return c.json(
    { error: 'bad_request', refusal: { code: 'bad_request', message, fix: 'Fix the query parameters and retry.' } },
    400,
  );
}

export async function jsonBody(c: { req: { json: () => Promise<unknown> } }): Promise<Record<string, unknown> | null> {
  try {
    const body = await c.req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
