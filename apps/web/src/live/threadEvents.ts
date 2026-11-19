import { useEffect, useRef } from 'react';

const THREAD_EVENTS = new Set(['comment.created', 'thread.resolved', 'thread.updated', 'thread.orphaned']);

type Listener = (type: string, payload: unknown) => void;
type Shared = { source: EventSource; listeners: Set<Listener> };

/** One event stream per document, shared by every listener on the page: each
 *  stream holds a connection, and a browser allows only a few per host. */
const streams = new Map<string, Shared>();

function subscribe(documentId: string, listener: Listener): () => void {
  let shared = streams.get(documentId);
  if (!shared) {
    const source = new EventSource(`/api/documents/${encodeURIComponent(documentId)}/events/stream`);
    const created: Shared = { source, listeners: new Set() };
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
export function useDataChanged(documentId: string, onChange: (collections: string[]) => void): void {
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    if (typeof EventSource === 'undefined') return;
    return subscribe(documentId, (type, payload) => {
      if (type !== 'data.changed') return;
      const collections = (payload as { collections?: unknown } | null)?.collections;
      if (Array.isArray(collections)) latest.current(collections.filter((c): c is string => typeof c === 'string'));
    });
  }, [documentId]);
}
