// Shared records over REST. Thin: every route calls the records service
// (records/store.ts), which checks access and validates; MCP tools and the
// page bridge (through the host, which calls these routes) use the same verbs.
// One POST route per verb, so a scoped token's records:read / records:write
// is decided per route, and collection names (which may contain `/`) travel
// in the body, never the path.
import type { Context, Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import {
  MAX_RECORDS_BATCH,
  MAX_RECORD_BYTES,
  RECORD_VERBS,
  type Refusal,
  type RecordVerb,
} from '@polygonlabs/primer-api-types';
import type { AppVariables } from '../app.ts';
import { listRecordChanges, purgePersonalRecords, recordsApi, revertChange, type RecordsResult } from '../records/store.ts';

// A batch at the per-record cap plus framing; the service enforces the exact caps.
const MAX_RECORDS_BODY_BYTES = MAX_RECORDS_BATCH * (MAX_RECORD_BYTES + 1024);

const STATUS: Record<string, 400 | 403 | 404 | 409 | 413> = {
  bad_request: 400,
  forbidden: 403,
  not_found: 404,
  record_conflict: 409,
  records_cap: 413,
};

function respond<T>(c: Context<{ Variables: AppVariables }>, out: RecordsResult<T>, okStatus: 200 = 200) {
  if (out.ok) return c.json(out.value as object, okStatus);
  const refusal: Refusal = out.refusal;
  return c.json({ error: refusal.code, refusal }, STATUS[refusal.code] ?? 400);
}

/** The host marks every call it makes for a page with this header. Page
 *  code reaches records only through the host, so a marked call is a page's:
 *  shared records only, never the viewer's personal ones. */
export const PAGE_BRIDGE_HEADER = 'x-primer-page-bridge';

const pageRefusal: Refusal = {
  code: 'forbidden',
  message: "A page can't read or write personal records.",
  fix: 'Use scope "shared".',
};

function touchesPersonal(args: object): boolean {
  const a = args as { scope?: unknown; ops?: unknown };
  const ops = Array.isArray(a.ops) ? a.ops : [];
  return a.scope === 'personal' || ops.some((op) => typeof op === 'object' && op !== null && (op as { scope?: unknown }).scope === 'personal');
}

export function registerRecordRoutes(app: Hono<{ Variables: AppVariables }>): void {
  const limit = bodyLimit({
    maxSize: MAX_RECORDS_BODY_BYTES,
    onError: (c) => c.json({ error: 'payload_too_large', message: `request body exceeds ${MAX_RECORDS_BODY_BYTES} bytes` }, 413),
  });

  for (const verb of RECORD_VERBS) {
    app.post(`/api/documents/:docId/records/${verb}`, limit, async (c) => {
      let args: unknown;
      try {
        args = await c.req.json();
      } catch {
        return c.json({ error: 'bad_request', message: 'body must be JSON' }, 400);
      }
      if (typeof args !== 'object' || args === null || Array.isArray(args)) {
        return c.json({ error: 'bad_request', message: 'body must be an object of verb arguments' }, 400);
      }
      if (c.req.header(PAGE_BRIDGE_HEADER) && touchesPersonal(args)) {
        return c.json({ error: pageRefusal.code, refusal: pageRefusal }, 403);
      }
      const api = recordsApi(c.get('user'), c.req.param('docId'));
      const call = api[verb as RecordVerb] as (a: unknown) => Promise<RecordsResult<unknown>>;
      return respond(c, await call(args));
    });
  }

  app.get('/api/documents/:docId/records/changes', async (c) => {
    const since = c.req.query('since');
    const lim = c.req.query('limit');
    if ((since !== undefined && !/^\d{1,18}$/.test(since)) || (lim !== undefined && !/^\d{1,4}$/.test(lim))) {
      return c.json({ error: 'bad_request', message: 'since and limit must be non-negative integers' }, 400);
    }
    // The feed carries the caller's own personal changes; a page gets shared ones only.
    return respond(
      c,
      await listRecordChanges(c.get('user'), c.req.param('docId'), {
        since: since === undefined ? undefined : Number(since),
        limit: lim === undefined ? undefined : Number(lim),
        sharedOnly: Boolean(c.req.header(PAGE_BRIDGE_HEADER)),
      }),
    );
  });

  // Owner only: delete one user's personal records on the document.
  app.post('/api/documents/:docId/records/purge-personal', async (c) => {
    let body: { userId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'bad_request', message: 'body must be JSON' }, 400);
    }
    return respond(c, await purgePersonalRecords(c.get('user'), c.req.param('docId'), body?.userId));
  });

  app.post('/api/record-changes/:changeId/revert', async (c) => {
    const raw = c.req.param('changeId');
    if (!/^\d{1,18}$/.test(raw)) return c.json({ error: 'bad_request', message: 'changeId must be a change id' }, 400);
    return respond(c, await revertChange(Number(raw), c.get('user')));
  });
}
