import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import {
  approveRun,
  cancelRun,
  claimRun,
  finishRun,
  listDocumentAgents,
  listAgentRuns,
  listDocumentRuns,
  requestRun,
  retryRun,
  updateRunStatus,
  type RunResult,
} from '../live/runs.ts';
import { undoRun } from '../live/undo.ts';
import { jsonBody } from './live.ts';

/** Agent runs on live documents (live/runs.ts). */
export function registerRunRoutes(app: Hono<{ Variables: AppVariables }>): void {
  const send = <T>(c: { json: (body: unknown, status: number) => Response }, out: RunResult<T>, status = 200) =>
    out.ok ? c.json(out.value, status) : c.json({ error: out.refusal.code, refusal: out.refusal }, out.status);

  app.get('/api/documents/:docId/agents', async (c) => {
    const out = await listDocumentAgents(c.get('user'), c.req.param('docId'));
    return out.ok ? c.json({ agents: out.value }, 200) : send(c as never, out);
  });

  app.get('/api/documents/:docId/runs', async (c) => {
    const out = await listDocumentRuns(c.get('user'), c.req.param('docId'));
    return out.ok ? c.json({ runs: out.value }, 200) : send(c as never, out);
  });

  app.post('/api/documents/:docId/runs', async (c) => {
    const body = (await jsonBody(c)) ?? {};
    return send(c as never, await requestRun(c.get('user'), c.req.param('docId'), body), 201);
  });

  // The calling agent's runs: ?documentId=&status= (active ones by default).
  app.get('/api/runs', async (c) => {
    const runs = await listAgentRuns(c.get('user'), { documentId: c.req.query('documentId'), status: c.req.query('status') });
    return c.json({ runs }, 200);
  });

  app.post('/api/runs/:runId/claim', async (c) => send(c as never, await claimRun(c.get('user'), c.req.param('runId'))));

  // { statusLine?, plan? }
  app.post('/api/runs/:runId/status', async (c) =>
    send(c as never, await updateRunStatus(c.get('user'), c.req.param('runId'), (await jsonBody(c)) ?? {})),
  );

  // { error? }: with an error the run failed, else it is done.
  app.post('/api/runs/:runId/finish', async (c) =>
    send(c as never, await finishRun(c.get('user'), c.req.param('runId'), (await jsonBody(c)) ?? {})),
  );

  app.post('/api/runs/:runId/cancel', async (c) => send(c as never, await cancelRun(c.get('user'), c.req.param('runId'))));
  app.post('/api/runs/:runId/retry', async (c) => send(c as never, await retryRun(c.get('user'), c.req.param('runId')), 201));
  // Undo one run's edits (live/undo.ts); a Reconciliation like ops.
  app.post('/api/runs/:runId/undo', async (c) => send(c as never, await undoRun(c.req.param('runId'), c.get('user'))));
  app.post('/api/runs/:runId/approve', async (c) => send(c as never, await approveRun(c.get('user'), c.req.param('runId'))));
}
