// Tests for the parent-side events relay engine (issue #78, Pin 9):
// hydrate-to-exhaustion as one batch, artifact-audience-only forwarding,
// stream coalescing, dedupe by id, and the overlap re-fetch on reconnect /
// visibility regain. All I/O is injected — no browser needed.
import { describe, it, expect } from 'vitest';
import type { EventRowDTO } from '@polygonlabs/primer-api-types';
import { createEventsFeed, type EventSourceLike } from './eventsFeed.ts';

function row(id: number, over: Partial<EventRowDTO> = {}): EventRowDTO {
  return {
    id,
    documentId: 'doc-1',
    authorId: 'user-1',
    audience: 'artifact',
    namespace: 'padd',
    type: 'export',
    payload: { id },
    createdAt: '2026-08-24T00:00:00.000Z',
    ...over,
  };
}

/** In-memory paginated server + controllable fake EventSource. */
function makeHarness(initialRows: EventRowDTO[], pageSize = 2) {
  const state = { rows: [...initialRows], listCalls: [] as string[] };

  const fetchImpl = async (url: string): Promise<Response> => {
    state.listCalls.push(url);
    const u = new URL(url, 'http://test.local');
    const since = u.searchParams.has('since') ? Number(u.searchParams.get('since')) : null;
    const pageToken = u.searchParams.get('pageToken');
    const matching = state.rows
      .filter((r) => (since === null ? true : r.id > since))
      .sort((a, b) => a.id - b.id);
    const offset = pageToken === null ? 0 : Number(pageToken);
    const page = matching.slice(offset, offset + pageSize);
    const next = offset + pageSize < matching.length ? String(offset + pageSize) : null;
    return new Response(JSON.stringify({ events: page, nextPageToken: next }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const sources: FakeEventSource[] = [];
  class FakeEventSource implements EventSourceLike {
    onmessage: EventSourceLike['onmessage'] = null;
    onopen: EventSourceLike['onopen'] = null;
    onerror: EventSourceLike['onerror'] = null;
    closed = false;
    constructor(public url: string) {
      sources.push(this);
    }
    close(): void {
      this.closed = true;
    }
    emit(r: EventRowDTO): void {
      this.onmessage?.({ data: JSON.stringify(r), lastEventId: String(r.id) });
    }
  }

  const batches: EventRowDTO[][] = [];
  const docChanges: EventRowDTO[] = [];
  let resyncs = 0;
  // Immediate-flush timers keep the tests deterministic; coalescing is
  // exercised by pushing several rows before the queued flush runs.
  const timers: (() => void)[] = [];
  const feed = createEventsFeed({
    documentId: 'doc-1',
    onBatch: (rows) => batches.push(rows),
    onDocChange: (r) => docChanges.push(r),
    onResync: () => {
      resyncs += 1;
    },
    fetchImpl,
    eventSourceFactory: (url) => new FakeEventSource(url),
    setTimeoutImpl: (fn) => {
      timers.push(fn);
      return timers.length - 1;
    },
    clearTimeoutImpl: () => {},
  });

  return {
    state,
    feed,
    batches,
    docChanges,
    resyncs: () => resyncs,
    sources,
    flushTimers(): void {
      const pending = timers.splice(0);
      for (const fn of pending) fn();
    },
  };
}

describe('createEventsFeed', () => {
  it('hydrates the full list (following pagination to exhaustion) as ONE batch of artifact rows', async () => {
    const h = makeHarness([
      row(1),
      row(2, { audience: 'collaborators' }), // never crosses the injection boundary
      row(3),
      row(4, { audience: 'author' }),
      row(5),
    ]);
    await h.feed.start();
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0].map((r) => r.id)).toEqual([1, 3, 5]);
    // 5 rows / page size 2 → 3 sequential paginated reads.
    expect(h.state.listCalls.length).toBe(3);
  });

  it('coalesces a stream burst into a single dispatch, ascending by id', async () => {
    const h = makeHarness([]);
    await h.feed.start();
    const src = h.sources[0];
    src.emit(row(12));
    src.emit(row(10));
    src.emit(row(11, { audience: 'collaborators' }));
    h.flushTimers();
    expect(h.batches).toHaveLength(1);
    expect(h.batches[0].map((r) => r.id)).toEqual([10, 12]);
  });

  it('dedupes by id across hydrate and stream (at-least-once upstream, once downstream)', async () => {
    const h = makeHarness([row(1), row(2)]);
    await h.feed.start();
    const src = h.sources[0];
    src.emit(row(2)); // stream replays a row the hydrate already delivered
    src.emit(row(3));
    h.flushTimers();
    expect(h.batches.map((b) => b.map((r) => r.id))).toEqual([[1, 2], [3]]);
  });

  it('subscribes with ?since=<highest seen id> after hydrating', async () => {
    const h = makeHarness([row(7), row(9)]);
    await h.feed.start();
    expect(h.sources[0].url).toContain('/events/stream?since=9');
  });

  it('re-hydrates in FULL on reconnect: a late-committing lower id is delivered', async () => {
    const h = makeHarness([row(20), row(21)]);
    await h.feed.start();
    const src = h.sources[0];

    // Connection drops; while offline, a LOWER id (assigned earlier,
    // committed later) becomes visible — exactly the Pin 6 case.
    src.onerror?.({});
    h.state.rows.push(row(15));
    src.onopen?.({});
    await new Promise((r) => setTimeout(r, 0)); // let refresh()'s fetches settle

    const delivered = h.batches.flat().map((r) => r.id);
    expect(delivered).toContain(15);
    // The reconnect re-fetch was FULL — no since param (any bounded window
    // could silently skip a row that committed far below the frontier).
    const reconnectCalls = h.state.listCalls.slice(1); // [0] is the initial hydrate
    expect(reconnectCalls.length).toBeGreaterThan(0);
    for (const u of reconnectCalls) expect(u).not.toContain('since=');
  });

  it('delivers a row committed ARBITRARILY far below the frontier during a disconnect (no bounded window)', async () => {
    const h = makeHarness([row(500), row(501)]);
    await h.feed.start();
    const src = h.sources[0];
    src.onerror?.({});
    // While disconnected, a transaction that drew id 3 long ago finally
    // commits — 497 ids below the frontier, beyond any plausible window.
    h.state.rows.push(row(3));
    src.onopen?.({});
    await new Promise((r) => setTimeout(r, 0));
    expect(h.batches.flat().map((r) => r.id)).toContain(3);
  });

  it('refresh() (visibility regain) re-hydrates in full without a connection error', async () => {
    const h = makeHarness([row(30)]);
    await h.feed.start();
    h.state.rows.push(row(25)); // late-committing lower id
    await h.feed.refresh();
    expect(h.batches.flat().map((r) => r.id)).toEqual([30, 25]);
  });

  it("hands Primer's lifecycle rows to onDocChange, never to the artifact, and resyncs after a refresh", async () => {
    const h = makeHarness([]);
    await h.feed.start();
    h.sources[0].emit(row(5, { namespace: 'primer', type: 'comment.created', audience: 'readers' }));
    h.flushTimers();
    expect(h.docChanges.map((r) => r.id)).toEqual([5]);
    expect(h.batches.flat()).toEqual([]);
    expect(h.resyncs()).toBe(0);
    await h.feed.refresh();
    expect(h.resyncs()).toBe(1);
  });

  it('stop() closes the stream and drops pending flushes', async () => {
    const h = makeHarness([]);
    await h.feed.start();
    const src = h.sources[0];
    src.emit(row(1));
    h.feed.stop();
    h.flushTimers();
    expect(src.closed).toBe(true);
    expect(h.batches).toHaveLength(0);
  });
});
