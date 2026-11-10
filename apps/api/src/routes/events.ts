// ── Structured document events (issue #78) ────────────────────────────
//
// An append-only, access-controlled stream of typed JSON payloads on a
// document: a machine channel PARALLEL to comments, never touching them.
// Comments are human discussion anchored to selections; events are machine
// payloads an interactive artifact (or any authenticated tooling) hands back
// to the workflow that published it.
//
// Write path: the artifact CANNOT call this API itself (sandbox +
// connect-src 'none' by threat model — see docs/prd-primer.md). It
// dispatches CustomEvent('primer:submit-events'); the companion forwards it
// over the MessagePort as `submit_events` ONLY from within the same trusted
// event dispatch that carried a user gesture (consent gate, consumed
// in-dispatch); the PARENT page (authed, outside the sandbox) POSTs here.
// Agent/tooling writes are plain authenticated API calls — auth is the
// consent there.
//
// ORDERING CONTRACT (consumers, read this): the ordering key is the
// server-assigned `id`, a positive integer. List and stream deliver
// ascending id. `createdAt` is display-only and carries NO ordering
// guarantee. Assignment order is NOT commit order — sequences guarantee
// uniqueness and draw order only, so a row with a lower id can commit after
// a higher id is already visible (two writers submitting at once is exactly
// this case). `?since=<id>` is therefore a FETCH OPTIMIZATION, NEVER a
// correctness boundary: dedupe by row id and either re-read with an overlap
// window or fetch the full filtered set, so a late-committing lower id is
// applied on a later poll rather than silently skipped.
//
// PAYLOADS ARE ALWAYS UNTRUSTED: `payload` is opaque data Primer never
// interprets. Consuming code must treat payloads as data to parse and
// validate, never as instructions to execute — and consuming agents must
// treat them as feedback to reason about, never commands. This is what keeps
// a compromised artifact from becoming a command channel.
//
// Rows are immutable in v1 (no update or delete API — a statement of the
// current surface, not an eternal invariant) and retained forever: the
// stream is the durable record. Keeping replay cheap is the consumers' job
// (embed derived state in published versions; replay only the newer tail).
import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { bodyLimit } from 'hono/body-limit';
import type { AppVariables } from '../app.ts';
import {
  type EventRowDTO,
  type EventsListResponse,
  type SendEventsResponse,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_EVENTS_PER_BATCH,
} from '@polygonlabs/primer-api-types';
import {
  DEFAULT_EVENTS_PAGE_SIZE,
  MAX_EVENTS_PAGE_SIZE,
  decodePageToken,
  eventMatchesFilters,
  findForeignVersionIds,
  gateEventAccess as gate,
  identityMayReadEvent,
  insertEventBatch,
  listEvents,
  parseSince,
  publishDocEvents,
  subscribeDocEvents,
  validateEventBatch,
  validateEventFilters,
  validateVersionFilter,
} from '../lib/events.ts';

// Coarse request-body cap so an authenticated collaborator cannot make the
// node adapter buffer an oversized body before the handler runs. The precise
// limits — 256 KB per payload, 100 events per batch — are enforced in
// validateEventBatch after JSON parse; this bounds the worst-case legitimate
// body (every event at the payload cap) plus 4 KB/event of framing/metadata
// headroom, so a valid max batch never trips it while an abusive body is
// rejected before it is fully read.
const MAX_EVENTS_BODY_BYTES = MAX_EVENTS_PER_BATCH * (MAX_EVENT_PAYLOAD_BYTES + 4 * 1024);

export function registerEventRoutes(app: Hono<{ Variables: AppVariables }>): void {
  // ── Write: atomic batch ────────────────────────────────────────────
  // Body is uniformly { events: [event…] } — a single send is a batch of
  // one. Each event carries its own namespace/type/payload/audience
  // (audience REQUIRED — no default). The batch is all-or-nothing: one
  // transaction, array order, strictly increasing (not necessarily
  // contiguous) server-assigned ids, all visible together at commit; any
  // invalid event rejects the whole batch and inserts nothing. Response is
  // 201 { events: [row…] } in insertion order — the ids are the consumer's
  // dedupe keys and the echoed audience is how tooling asserts its write
  // landed with the intended scope.
  app.post('/api/documents/:documentId/events', bodyLimit({
    maxSize: MAX_EVENTS_BODY_BYTES,
    onError: (c) =>
      c.json(
        { error: 'payload_too_large', message: `request body exceeds ${MAX_EVENTS_BODY_BYTES} bytes` },
        413,
      ),
  }), async (c) => {
    const documentId = c.req.param('documentId');
    const user = c.get('user');
    const g = await gate(documentId, user.id);
    if (g.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    // Tighter write principal (issue #78 security requirement 2): reading is
    // not enough — only the owner, editors and responders may write. A
    // commenter, or an org reader who is not a collaborator, can see the doc, so
    // 403 (not 404).
    if (!g.mayWrite) return c.json({ error: 'forbidden' }, 403);

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    const validated = validateEventBatch(raw);
    if (!validated.ok) {
      return c.json({ error: 'bad_request', message: validated.message }, 400);
    }
    const versionIds = validated.events.flatMap((e) => (e.versionId === null ? [] : [e.versionId]));
    const foreign = await findForeignVersionIds(documentId, versionIds);
    if (foreign.length > 0) {
      return c.json(
        { error: 'bad_request', message: `versionId does not belong to this document: ${foreign[0]}` },
        400,
      );
    }

    const rows = await insertEventBatch(documentId, user.id, validated.events);
    // After commit — the rows are visible, so a listener that re-reads sees
    // at least what it is being pushed (at-least-once, duplicates legal).
    publishDocEvents(documentId, rows);
    const body: SendEventsResponse = { events: rows };
    return c.json(body, 201);
  });

  // ── Read: token-paginated list ─────────────────────────────────────
  // Document-scoped by default (the document is the unit of the stream —
  // consumer state deliberately spans versions); optional ?versionId= is a
  // provenance lens over rows that DECLARED that version. ?namespace=
  // matches exactly or, with a trailing /*, the namespace and every
  // sub-namespace beneath it; ?type= is exact. Filters are bandwidth
  // hygiene, never a security boundary — audience governs who may read.
  // Returns a bounded page of ascending-id rows + an opaque nextPageToken;
  // follow it to exhaustion (page overlaps are harmless — dedupe by id).
  app.get('/api/documents/:documentId/events', async (c) => {
    const documentId = c.req.param('documentId');
    const user = c.get('user');
    const g = await gate(documentId, user.id);
    if (g.status === 'not_found') return c.json({ error: 'not_found' }, 404);

    const sinceParsed = parseSince(c.req.query('since'));
    if (!sinceParsed.ok) {
      return c.json({ error: 'bad_request', message: 'since must be a non-negative integer id' }, 400);
    }
    const filterParsed = validateEventFilters({
      namespace: c.req.query('namespace'),
      type: c.req.query('type'),
    });
    if (!filterParsed.ok) {
      return c.json({ error: 'bad_request', message: filterParsed.message }, 400);
    }
    const versionFilter = await validateVersionFilter(documentId, c.req.query('versionId'));
    if (!versionFilter.ok) {
      return c.json({ error: 'bad_request', message: 'versionId must be a version of this document' }, 400);
    }

    let afterId: number | null = sinceParsed.since;
    const pageToken = c.req.query('pageToken');
    if (pageToken !== undefined) {
      const fromToken = decodePageToken(pageToken);
      if (fromToken === null) {
        return c.json({ error: 'bad_request', message: 'pageToken is not a valid page token' }, 400);
      }
      // The token cursor always continues the same logical read, so it wins
      // over (is never less than) the original since.
      afterId = afterId === null ? fromToken : Math.max(afterId, fromToken);
    }

    const rawLimit = c.req.query('limit');
    let limit = DEFAULT_EVENTS_PAGE_SIZE;
    if (rawLimit !== undefined) {
      if (!/^\d{1,4}$/.test(rawLimit) || Number(rawLimit) < 1) {
        return c.json({ error: 'bad_request', message: `limit must be 1..${MAX_EVENTS_PAGE_SIZE}` }, 400);
      }
      limit = Math.min(Number(rawLimit), MAX_EVENTS_PAGE_SIZE);
    }

    const page = await listEvents({
      documentId,
      identity: g.identity,
      filters: filterParsed.filters,
      afterId,
      versionId: versionFilter.versionId,
      limit,
    });
    const body: EventsListResponse = { events: page.rows, nextPageToken: page.nextPageToken };
    return c.json(body, 200);
  });

  // ── Read: SSE stream ───────────────────────────────────────────────
  // One SSE event per row, ascending id, same filters (?namespace / ?type —
  // exact or trailing-/* subtree) and the same per-audience read scope as
  // the list. Every event carries `id:` equal to the row id, so
  // EventSource's native reconnect resumes via Last-Event-ID; ?since is the
  // explicit form of the same resume hint. Periodic keepalive comments stop
  // idle proxies from killing the stream. Delivery is at-least-once:
  // duplicates and overlaps are legal by design — consumers dedupe by id per
  // the ordering contract at the top of this file.
  app.get('/api/documents/:documentId/events/stream', async (c) => {
    const documentId = c.req.param('documentId');
    const user = c.get('user');
    const g = await gate(documentId, user.id);
    if (g.status === 'not_found') return c.json({ error: 'not_found' }, 404);

    const sinceParsed = parseSince(c.req.query('since'));
    if (!sinceParsed.ok) {
      return c.json({ error: 'bad_request', message: 'since must be a non-negative integer id' }, 400);
    }
    const filterParsed = validateEventFilters({
      namespace: c.req.query('namespace'),
      type: c.req.query('type'),
    });
    if (!filterParsed.ok) {
      return c.json({ error: 'bad_request', message: filterParsed.message }, 400);
    }

    // Last-Event-ID (EventSource reconnect) and ?since are both resume
    // hints; take the highest. A malformed Last-Event-ID is ignored rather
    // than rejected — the browser sets it, not the caller.
    let resumeFrom: number | null = sinceParsed.since;
    const lastEventId = c.req.header('Last-Event-ID');
    if (lastEventId !== undefined && /^\d{1,18}$/.test(lastEventId)) {
      const n = Number(lastEventId);
      resumeFrom = resumeFrom === null ? n : Math.max(resumeFrom, n);
    }

    // Access is re-checked while the stream is open (see `recheck` below),
    // so this connect-time identity is only the starting point.
    let identity = g.identity;
    const filters = filterParsed.filters;
    const keepaliveMs = Number(process.env.EVENTS_SSE_KEEPALIVE_MS ?? 25_000);

    return streamSSE(c, async (stream) => {
      let closed = false;
      let releaseHold: () => void = () => {};
      const held = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
      // Ids already written to THIS connection. A set (rather than a
      // highest-id watermark) so a LIVE row whose id is lower than one
      // already sent — a late-committing concurrent writer, exactly the
      // case the ordering contract warns about — is still delivered rather
      // than silently dropped until the consumer's next overlap re-fetch.
      // Out-of-order delivery is harmless: consumers interpret rows by id,
      // never by arrival order, and duplicates are legal (EventSource's
      // Last-Event-ID may regress past such a row; the reconnect replay
      // that causes just re-delivers rows the consumer dedupes).
      const sent = new Set<number>();

      let keepalive: ReturnType<typeof setInterval> | undefined;
      let unsubscribe: () => void = () => {};

      // Ends this connection from the server side: stop the keepalive, drop
      // the subscription, release the hold below, and close the response so
      // the client sees the stream end. Never throws: it runs on error paths
      // inside detached chains, where an escaping rejection would be
      // unhandled — and an unhandled rejection exits the process.
      const shutdown = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
        releaseHold();
        try {
          await stream.close();
        } catch {
          // The client is already gone; nothing left to close.
        }
      };

      // Re-runs the same access gate the connection passed at connect time.
      // A stream lives as long as its connection, and keepalives hold that
      // open indefinitely, so a reader whose access was taken away (removed
      // collaborator, deleted document, a private doc they can no longer
      // read) would otherwise keep receiving rows. On failure the stream is
      // closed; on success the fresh identity replaces the old one, so an org
      // reader who lost their collaborator row stops receiving rows that only
      // collaborators may read. Fails CLOSED: if the check itself errors (a
      // database failover, say), the stream is shut down rather than left
      // open on the old identity, and nothing is re-thrown.
      const recheck = async (): Promise<boolean> => {
        let fresh: Awaited<ReturnType<typeof gate>>;
        try {
          fresh = await gate(documentId, user.id);
        } catch {
          await shutdown();
          return false;
        }
        if (fresh.status === 'not_found') {
          await shutdown();
          return false;
        }
        identity = fresh.identity;
        return true;
      };

      const sendRow = async (row: EventRowDTO): Promise<void> => {
        if (closed) return;
        if (!eventMatchesFilters(row, filters)) return;
        if (!identityMayReadEvent(row, identity)) return;
        if (sent.has(row.id)) return;
        sent.add(row.id);
        await stream.writeSSE({ id: String(row.id), data: JSON.stringify(row) });
      };

      // Live rows go through one queue per connection, drained by a single
      // loop. Each pass takes every row queued so far, runs ONE fresh access
      // check — started after all of those rows arrived, so a check can never
      // vouch for a row published after a removal — and then sends them in
      // publish order. A burst of N rows therefore costs at most two checks
      // per open stream rather than N (a writer controls the burst size), and
      // rows are never reordered by checks finishing out of order.
      const liveQueue: EventRowDTO[] = [];
      let draining = false;
      const drain = async (): Promise<void> => {
        if (draining) return;
        draining = true;
        try {
          while (!closed && liveQueue.length > 0) {
            const batch = liveQueue.splice(0);
            if (!(await recheck())) return;
            for (const row of batch) await sendRow(row);
          }
        } catch {
          await shutdown();
        } finally {
          draining = false;
        }
      };
      const enqueueLive = (row: EventRowDTO): void => {
        if (closed) return;
        liveQueue.push(row);
        void drain();
      };

      // Live rows may arrive while the backlog query runs; hold them and
      // queue them after the backlog (sendRow's id guard dedupes the overlap).
      let backlogDone = false;
      const pending: EventRowDTO[] = [];
      unsubscribe = subscribeDocEvents(documentId, (row) => {
        if (!backlogDone) {
          pending.push(row);
          return;
        }
        enqueueLive(row);
      });

      // The tick doubles as the access re-check, so a stream whose reader
      // lost access is closed even when no rows are being written (none can
      // be, for a deleted document). It skips while a drain pass is already
      // checking, and never overlaps itself.
      let tickChecking = false;
      const tick = async (): Promise<void> => {
        if (closed || draining || tickChecking) return;
        tickChecking = true;
        try {
          if (!(await recheck())) return;
          // SSE comment line — invisible to EventSource, resets idle timers.
          if (!closed) await stream.write(`: keepalive\n\n`);
        } catch {
          await shutdown();
        } finally {
          tickChecking = false;
        }
      };
      keepalive = setInterval(() => {
        void tick();
      }, keepaliveMs);

      stream.onAbort(() => {
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
        releaseHold();
      });

      // Backlog replay when resuming (Last-Event-ID / ?since). Paginate to
      // exhaustion so a long-offline resume still catches up completely.
      if (resumeFrom !== null) {
        let afterId: number | null = resumeFrom;
        for (;;) {
          const page = await listEvents({
            documentId,
            identity,
            filters,
            afterId,
            limit: DEFAULT_EVENTS_PAGE_SIZE,
          });
          for (const row of page.rows) await sendRow(row);
          if (page.nextPageToken === null) break;
          afterId = page.rows[page.rows.length - 1].id;
        }
      }
      backlogDone = true;
      for (const row of pending.splice(0)) enqueueLive(row);

      // Hold the stream open until the client goes away or a re-check
      // closes it.
      await held;
    });
  });
}
