import { useEffect, useRef } from 'react';

const THREAD_EVENTS = new Set(['comment.created', 'thread.resolved', 'thread.updated', 'thread.orphaned']);

type Shared = { source: EventSource; listeners: Set<(type: string) => void> };

/** One event stream per document, shared by every listener on the page: each
 *  stream holds a connection, and a browser allows only a few per host. */
const streams = new Map<string, Shared>();

function subscribe(documentId: string, listener: (type: string) => void): () => void {
  let shared = streams.get(documentId);
  if (!shared) {
    const source = new EventSource(`/api/documents/${encodeURIComponent(documentId)}/events/stream`);
    const created: Shared = { source, listeners: new Set() };
    source.onmessage = (message) => {
      const row = JSON.parse(message.data as string) as { namespace?: string; type?: string };
      if (row.namespace === 'primer' && row.type) for (const l of created.listeners) l(row.type);
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
