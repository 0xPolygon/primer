// ── SPIKE SCAFFOLD (spike/agent-messages) ─────────────────────────────
// Structured agent messages on a document: a machine channel PARALLEL to
// comments, never touching them. Comments are human objects (anchored to a
// selection, rendered as threads); agent messages are typed JSON payloads
// an interactive artifact hands back to the agent that published it
// (canonical first consumer: PADD review packets — the reviewer taps
// "Send to agent" and the packet's export JSON lands here instead of being
// pasted into a comment).
//
// Write path: the artifact CANNOT call this API itself (sandbox +
// connect-src 'none' by threat model). It dispatches a CustomEvent that the
// companion forwards over the MessagePort as `agent_payload`; the PARENT
// page (authed, outside the sandbox) POSTs here. See companion-protocol.ts.
//
// Read paths: REST list for polling, SSE stream for push — a Claude Code
// session can consume the stream today via its Monitor tool
// (`curl -N .../stream` in a monitor command; each `data:` line = event).
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { AppVariables } from '../app.ts';
import { db } from '../db/client.ts';
import {
  effectiveRole,
  loadCollaboratorRole,
  canRead,
  type Visibility,
} from '../lib/permissions.ts';

const MAX_PAYLOAD_BYTES = 256 * 1024; // generous for review exports, hostile to abuse
const PAYLOAD_TYPE_RE = /^[a-z0-9][a-z0-9-]*(\/[a-z0-9][a-z0-9-]*)+$/; // e.g. "padd/export"

// In-process fanout for the SSE stream. Fine for the current single-node
// deployment; swap for LISTEN/NOTIFY if the API ever scales out.
type Listener = (msg: object) => void;
const listenersByDoc = new Map<string, Set<Listener>>();
function publish(documentId: string, msg: object): void {
  for (const l of listenersByDoc.get(documentId) ?? []) l(msg);
}

async function loadDocContext(documentId: string) {
  const [row] = (await db.execute(sql`
    SELECT d.id, d.uploader_id AS "uploaderId", d.visibility, d.deleted_at AS "deletedAt"
    FROM documents d WHERE d.id = ${documentId} LIMIT 1
  `)) as unknown as {
    id: string; uploaderId: string; visibility: Visibility; deletedAt: Date | null;
  }[];
  if (!row || row.deletedAt) return null;
  return row;
}

export function registerAgentMessageRoutes(app: Hono<{ Variables: AppVariables }>): void {
  // Submit (called by the WEB PARENT on `agent_payload`, or by any authed
  // client — e.g. an agent recording a processing acknowledgement).
  app.post('/api/documents/:documentId/agent-messages', async (c) => {
    const documentId = c.req.param('documentId');
    const doc = await loadDocContext(documentId);
    if (!doc) return c.json({ error: 'not_found' }, 404);

    const user = c.get('user');
    const collabRole = await loadCollaboratorRole(documentId, user.id);
    const eff = effectiveRole(
      { uploaderId: doc.uploaderId, visibility: doc.visibility }, user.id, collabRole);
    // Reading the doc is the bar: anyone who can review the artifact can
    // hand feedback back to its agent. (Deliberately NOT canComment — this
    // channel is not part of the human discussion surface.)
    if (!canRead(doc.visibility, eff)) return c.json({ error: 'not_found' }, 404);

    let body: { versionId?: string; payloadType?: string; payload?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    if (typeof body.payloadType !== 'string' || !PAYLOAD_TYPE_RE.test(body.payloadType)) {
      return c.json({ error: 'invalid_payload_type', message: 'expected namespaced kebab type, e.g. "padd/export"' }, 400);
    }
    const payloadJson = JSON.stringify(body.payload ?? null);
    if (payloadJson.length > MAX_PAYLOAD_BYTES) {
      return c.json({ error: 'payload_too_large', message: `max ${MAX_PAYLOAD_BYTES} bytes` }, 413);
    }
    // TODO(spike): validate body.versionId belongs to documentId when present.

    const id = randomUUID();
    await db.execute(sql`
      INSERT INTO agent_messages (id, document_id, version_id, author_id, payload_type, payload)
      VALUES (${id}, ${documentId}, ${body.versionId ?? null}, ${user.id},
              ${body.payloadType}, ${payloadJson}::jsonb)
    `);

    const msg = {
      id, documentId, versionId: body.versionId ?? null, authorId: user.id,
      payloadType: body.payloadType, payload: body.payload ?? null,
      createdAt: new Date().toISOString(),
    };
    publish(documentId, msg);
    return c.json(msg, 201);
  });

  // List (polling / catch-up): ?since=<ISO> &payloadType=<type>
  app.get('/api/documents/:documentId/agent-messages', async (c) => {
    const documentId = c.req.param('documentId');
    const doc = await loadDocContext(documentId);
    if (!doc) return c.json({ error: 'not_found' }, 404);
    const user = c.get('user');
    const collabRole = await loadCollaboratorRole(documentId, user.id);
    const eff = effectiveRole(
      { uploaderId: doc.uploaderId, visibility: doc.visibility }, user.id, collabRole);
    if (!canRead(doc.visibility, eff)) return c.json({ error: 'not_found' }, 404);

    const since = c.req.query('since'); // TODO(spike): validate ISO date
    const rows = (await db.execute(sql`
      SELECT id, document_id AS "documentId", version_id AS "versionId",
             author_id AS "authorId", payload_type AS "payloadType",
             payload, created_at AS "createdAt"
      FROM agent_messages
      WHERE document_id = ${documentId}
        AND (${since ?? null}::timestamptz IS NULL OR created_at > ${since ?? null}::timestamptz)
      ORDER BY created_at ASC
      LIMIT 200
    `)) as unknown as object[];
    return c.json({ messages: rows });
  });

  // Push: one SSE event per agent message, as it lands. This is what makes
  // remote PADD review push-delivered: the owning Claude Code session runs
  //   Monitor: curl -N -H "Authorization: Bearer <token>" <url>/stream
  // and each submission wakes it — no comment scraping, no polling.
  app.get('/api/documents/:documentId/agent-messages/stream', async (c) => {
    const documentId = c.req.param('documentId');
    const doc = await loadDocContext(documentId);
    if (!doc) return c.json({ error: 'not_found' }, 404);
    const user = c.get('user');
    const collabRole = await loadCollaboratorRole(documentId, user.id);
    const eff = effectiveRole(
      { uploaderId: doc.uploaderId, visibility: doc.visibility }, user.id, collabRole);
    if (!canRead(doc.visibility, eff)) return c.json({ error: 'not_found' }, 404);

    return streamSSE(c, async (stream) => {
      const listener: Listener = (msg) => {
        void stream.writeSSE({ event: 'agent-message', data: JSON.stringify(msg) });
      };
      let set = listenersByDoc.get(documentId);
      if (!set) { set = new Set(); listenersByDoc.set(documentId, set); }
      set.add(listener);
      // Heartbeat keeps intermediaries from timing the stream out.
      const heartbeat = setInterval(() => void stream.writeSSE({ event: 'ping', data: '' }), 25_000);
      stream.onAbort(() => {
        clearInterval(heartbeat);
        set?.delete(listener);
        if (set && set.size === 0) listenersByDoc.delete(documentId);
      });
      // Hold the stream open until abort.
      await new Promise<void>((resolve) => stream.onAbort(resolve));
    });
  });
}
