// Coalesced `primer.data.changed` lifecycle events. A burst of record writes
// by one actor on one document becomes one event, written DATA_CHANGED_WINDOW_MS
// after the first write and authored by that actor. Event reads never hand an
// actor its own `data.changed` (lib/events.ts), so an agent is not woken by its
// own writes while pages and other agents still are.
//
// In-process, like the event wakes: Primer runs one API instance. A window
// lost to a restart only delays readers until their next catch-up
// (`records/changes?since=`), which is the complete record.
import { transactionWithEvents } from '../lib/events.ts';
import { logger } from '../logger.ts';
import { refreshBoundWidgets } from '../widgets/records.ts';

export const DATA_CHANGED_WINDOW_MS = 2_000;

interface Pending {
  documentId: string;
  actorId: string;
  collections: Set<string>;
  fromChangeId: number;
  toChangeId: number;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();
const running = new Set<Promise<void>>();

/** Notes committed shared-record changes by `actorId` on a document. */
export function scheduleDataChanged(
  documentId: string,
  actorId: string,
  change: { collections: string[]; fromChangeId: number; toChangeId: number },
): void {
  const key = `${documentId}\u0000${actorId}`;
  const open = pending.get(key);
  if (open) {
    for (const c of change.collections) open.collections.add(c);
    open.fromChangeId = Math.min(open.fromChangeId, change.fromChangeId);
    open.toChangeId = Math.max(open.toChangeId, change.toChangeId);
    return;
  }
  const entry: Pending = {
    documentId,
    actorId,
    collections: new Set(change.collections),
    fromChangeId: change.fromChangeId,
    toChangeId: change.toChangeId,
    timer: setTimeout(() => run(key), DATA_CHANGED_WINDOW_MS),
  };
  entry.timer.unref?.();
  pending.set(key, entry);
}

function run(key: string): void {
  const job = emit(key);
  running.add(job);
  void job.finally(() => running.delete(job));
}

async function emit(key: string): Promise<void> {
  const entry = pending.get(key);
  if (!entry) return;
  pending.delete(key);
  clearTimeout(entry.timer);
  try {
    await transactionWithEvents(async (_tx, emitEvent) => {
      emitEvent({
        documentId: entry.documentId,
        actorId: entry.actorId,
        type: 'data.changed',
        payload: {
          document_id: entry.documentId,
          collections: [...entry.collections].sort(),
          from_change_id: entry.fromChangeId,
          to_change_id: entry.toChangeId,
        },
      });
    });
  } catch (err) {
    // The document may be gone; readers catch up from the change log anyway.
    logger.warn({ error: String(err), documentId: entry.documentId }, 'records: data.changed not written');
  }
  // Charts bound to these collections redraw from the new records.
  await refreshBoundWidgets(entry.documentId, [...entry.collections]).catch((err: unknown) =>
    logger.warn({ error: String(err), documentId: entry.documentId }, 'records: bound widgets not redrawn'),
  );
}

/** Writes every open window now and waits, windows already being written
 *  included (tests, shutdown). */
export async function flushDataChanged(): Promise<void> {
  for (const key of [...pending.keys()]) run(key);
  await Promise.all([...running]);
}
