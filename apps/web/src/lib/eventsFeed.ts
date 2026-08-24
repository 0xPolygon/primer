/**
 * Parent-side delivery engine for the document-events read relay
 * (issue #78, fleet-command Pin 9): hydrate the visible event list, hold an
 * SSE subscription, and hand `artifact`-audience rows to the caller in
 * coalesced batches for forwarding into the sandboxed iframe.
 *
 * Delivery mechanics are ENTIRELY this side's responsibility and invisible
 * to the artifact (it has no network and no connection awareness). The
 * contract owed is at-least-once, eventually-complete delivery of the
 * document's `artifact`-audience rows:
 *
 *  - every stream event carries an SSE `id:` equal to the row id, so
 *    EventSource's native reconnect resumes via Last-Event-ID;
 *  - on (re)connect and on page-visibility regain — or any doubt — we
 *    re-fetch the list with an overlap window strictly below the highest id
 *    we've seen and re-relay anything missed;
 *  - duplicates and overlaps are legal by design (this module suppresses
 *    them by id as a courtesy; artifact code must dedupe by id anyway).
 *
 * Batch grouping carries NO semantics: consumers must derive identical
 * state however the same rows are partitioned into dispatches — which is
 * exactly what makes coalescing purely this side's optimization to tune.
 *
 * DI-friendly by construction (fetch, EventSource, and timers injected) so
 * the whole engine is testable without a browser.
 */
import type { EventRowDTO, EventsListResponse } from '@polygonlabs/primer-api-types';

/** Minimal slice of EventSource this engine needs. */
export interface EventSourceLike {
  onmessage: ((ev: { data: string; lastEventId?: string }) => void) | null;
  onopen: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  close(): void;
}

export interface EventsFeedOptions {
  documentId: string;
  /** Receives coalesced batches of `artifact`-audience rows, ascending id. */
  onBatch: (rows: EventRowDTO[]) => void;
  /** Same-origin fetch (cookie-authed); inject `api` from lib/fetch.ts. */
  fetchImpl: (url: string) => Promise<Response>;
  /** EventSource factory; inject `(url) => new EventSource(url)`. */
  eventSourceFactory: (url: string) => EventSourceLike;
  /** Stream-burst coalescing window, ms. */
  coalesceMs?: number;
  /** How far below the highest seen id an overlap re-fetch starts. */
  overlapWindow?: number;
  setTimeoutImpl?: (fn: () => void, ms: number) => unknown;
  clearTimeoutImpl?: (handle: unknown) => void;
}

export interface EventsFeed {
  /** Hydrates the list (one relay batch), then subscribes to the stream. */
  start(): Promise<void>;
  stop(): void;
  /** Call on page-visibility regain (or any doubt): overlap re-fetch. */
  refresh(): Promise<void>;
}

const DEFAULT_COALESCE_MS = 25;
const DEFAULT_OVERLAP_WINDOW = 100;

/** Browser glue: adapts a real EventSource to the injectable interface
 *  (the native handler-property types don't structurally match the minimal
 *  slice above). */
export function browserEventSourceFactory(url: string): EventSourceLike {
  const es = new EventSource(url);
  const like: EventSourceLike = {
    onmessage: null,
    onopen: null,
    onerror: null,
    close: () => es.close(),
  };
  es.onmessage = (ev) => like.onmessage?.({ data: String(ev.data), lastEventId: ev.lastEventId });
  es.onopen = (ev) => like.onopen?.(ev);
  es.onerror = (ev) => like.onerror?.(ev);
  return like;
}

export function createEventsFeed(opts: EventsFeedOptions): EventsFeed {
  const {
    documentId,
    onBatch,
    fetchImpl,
    eventSourceFactory,
    coalesceMs = DEFAULT_COALESCE_MS,
    overlapWindow = DEFAULT_OVERLAP_WINDOW,
    setTimeoutImpl = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutImpl = (h) => clearTimeout(h as Parameters<typeof clearTimeout>[0]),
  } = opts;

  let stopped = false;
  let source: EventSourceLike | null = null;
  /** Ids already relayed — the courtesy dedupe. */
  const seen = new Set<number>();
  let highestSeen = 0;
  /** True once the initial hydrate ran; later `onopen`s trigger re-fetches. */
  let hydrated = false;
  let sawError = false;

  let pending: EventRowDTO[] = [];
  let flushHandle: unknown = null;

  function relay(rows: EventRowDTO[]): void {
    const fresh = rows
      .filter((r) => r.audience === 'artifact' && !seen.has(r.id))
      .sort((a, b) => a.id - b.id);
    for (const r of rows) {
      // Track EVERY delivered row (any audience) for the overlap cursor —
      // the stream's Last-Event-ID advances over them all.
      if (r.id > highestSeen) highestSeen = r.id;
    }
    if (fresh.length === 0) return;
    for (const r of fresh) seen.add(r.id);
    onBatch(fresh);
  }

  function scheduleFlush(): void {
    if (flushHandle !== null) return;
    flushHandle = setTimeoutImpl(() => {
      flushHandle = null;
      const batch = pending;
      pending = [];
      relay(batch);
    }, coalesceMs);
  }

  async function fetchAll(sinceId: number | null): Promise<EventRowDTO[]> {
    const rows: EventRowDTO[] = [];
    let pageToken: string | null = null;
    do {
      const params = new URLSearchParams();
      if (sinceId !== null && sinceId > 0) params.set('since', String(sinceId));
      if (pageToken !== null) params.set('pageToken', pageToken);
      const qs = params.size > 0 ? `?${params.toString()}` : '';
      const res = await fetchImpl(`/api/documents/${documentId}/events${qs}`);
      if (!res.ok) throw new Error(`events list fetch failed: ${res.status}`);
      const body = (await res.json()) as EventsListResponse;
      rows.push(...body.events);
      pageToken = body.nextPageToken;
    } while (pageToken !== null);
    return rows;
  }

  async function hydrate(sinceId: number | null): Promise<void> {
    const rows = await fetchAll(sinceId);
    if (stopped) return;
    relay(rows); // one batch — a (re-)fetch arrives as a single dispatch
  }

  async function refresh(): Promise<void> {
    if (stopped) return;
    // Overlap window strictly below the highest seen id, so a
    // late-committing lower id is picked up rather than silently skipped.
    const since = Math.max(0, highestSeen - overlapWindow);
    try {
      await hydrate(since > 0 ? since : null);
    } catch {
      // Best-effort: the stream (or the next refresh) will catch us up.
    }
  }

  function subscribe(): void {
    if (stopped) return;
    const params = new URLSearchParams();
    if (highestSeen > 0) params.set('since', String(highestSeen));
    const qs = params.size > 0 ? `?${params.toString()}` : '';
    source = eventSourceFactory(`/api/documents/${documentId}/events/stream${qs}`);
    source.onmessage = (ev) => {
      let row: EventRowDTO;
      try {
        row = JSON.parse(ev.data) as EventRowDTO;
      } catch {
        return;
      }
      if (typeof row?.id !== 'number') return;
      pending.push(row);
      scheduleFlush();
    };
    source.onerror = () => {
      // EventSource reconnects on its own (with Last-Event-ID). We just
      // remember to overlap-re-fetch once it comes back.
      sawError = true;
    };
    source.onopen = () => {
      if (hydrated && sawError) {
        sawError = false;
        void refresh();
      }
    };
  }

  return {
    async start(): Promise<void> {
      try {
        await hydrate(null);
      } catch {
        // Initial hydrate failed (transient network?) — the stream +
        // visibility refreshes still converge; artifact state is a fold, so
        // late delivery is correctness-preserving.
      }
      hydrated = true;
      subscribe();
    },
    stop(): void {
      stopped = true;
      if (flushHandle !== null) {
        clearTimeoutImpl(flushHandle);
        flushHandle = null;
      }
      pending = [];
      source?.close();
      source = null;
    },
    refresh,
  };
}
