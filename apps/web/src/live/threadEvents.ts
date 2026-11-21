import { useEffect, useRef } from 'react';

const THREAD_EVENTS = new Set(['comment.created', 'thread.resolved', 'thread.updated', 'thread.orphaned']);

type Listener = (type: string, payload: unknown) => void;
/** The pseudo event a stream's listeners get when it (re)connects. */
const OPEN = 'stream.open';
type Shared = { source: EventSource; listeners: Set<Listener> };

/** One event stream per document, shared by every listener on the page: each
 *  stream holds a connection, and a browser allows only a few per host. */
const streams = new Map<string, Shared>();

function subscribe(documentId: string, listener: Listener): () => void {
  let shared = streams.get(documentId);
  if (!shared) {
    const source = new EventSource(`/api/documents/${encodeURIComponent(documentId)}/events/stream`);
    const created: Shared = { source, listeners: new Set() };
    // A stream starts at the server's head: what happened between a viewer's
    // first read and this connection is not on it, so listeners read again.
    source.onopen = () => {
      for (const l of created.listeners) l(OPEN, null);
    };
    source.onmessage = (message) => {
      const row = JSON.parse(message.data as string) as { namespace?: string; type?: string; payload?: unknown };
      if (row.namespace === 'primer' && row.type) for (const l of created.listeners) l(row.type, row.payload);
    };
    shared = created;
    streams.set(documentId, shared);
  }
  const entry = shared;
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) {
      entry.source.close();
      streams.delete(documentId);
    }
  };
}

/**
 * Calls `onChange` when the document's comments change (Primer's own
 * lifecycle events on the document's event stream), so every viewer's
 * comments sidebar follows other people's comments, replies and resolves.
 */
export function useThreadEvents(documentId: string, onChange: () => void, types: ReadonlySet<string> = THREAD_EVENTS): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    return subscribe(documentId, (type) => {
      if (types.has(type)) latest.current();
    });
  }, [documentId, types]);
}

/**
 * Calls `onChange` with the collections others changed (a coalesced
 * `primer.data.changed` on the document's stream). The viewer's own writes
 * never come back as events: refresh after them yourself.
 */
export function useDataChanged(documentId: string, onChange: (collections: string[]) => void, onOpen?: () => void): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  const opened = useRef(onOpen);
  opened.current = onOpen;
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    return subscribe(documentId, (type, payload) => {
      if (type === OPEN) return opened.current?.();
      if (type !== 'data.changed') return;
      const collections = (payload as { collections?: unknown } | null)?.collections;
      if (Array.isArray(collections)) latest.current(collections.filter((c): c is string => typeof c === 'string'));
    });
  }, [documentId]);
}

/** The viewer's own write to `collections`: the server never sends it back, so
 *  every table of the page that shows them reads again. */
export function announceDataChanged(documentId: string, collections: string[]): void {
  for (const l of streams.get(documentId)?.listeners ?? []) l('data.changed', { collections });
}
