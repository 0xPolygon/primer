import type * as Y from 'yjs';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { transactionWithEvents } from '../lib/events.ts';
import { logger } from '../logger.ts';
import { presentThreadIds } from './marks.ts';
import { persistedUpTo } from './persist.ts';

/** Quiet time after the last update before threads are rechecked. */
export const ORPHAN_SYNC_DELAY_MS = 2_000;

/**
 * Flags the document's open mark-anchored threads whose comment mark is gone
 * from reachable content (`orphaned_at`, "Text removed") and clears the flag
 * on those whose mark is back. Each change emits `thread.orphaned`. Orphaned
 * threads stay open and keep their quote.
 */
export async function syncOrphans(documentId: string, doc: Y.Doc): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT id, orphaned_at IS NOT NULL AS orphaned
      FROM threads
     WHERE document_id = ${documentId}
       AND version_id IS NULL
       AND resolved_at IS NULL
       AND anchor->>'type' = 'prose'
  `)) as unknown as { id: string; orphaned: boolean }[];
  if (rows.length === 0) return;
  const present = presentThreadIds(doc);
  const changes = rows
    .filter((row) => present.has(row.id) === row.orphaned)
    .map((row) => ({ id: row.id, orphaned: !row.orphaned }));
  if (changes.length === 0) return;
  // Attributed to whoever last changed the document (else its uploader).
  const [by] = (await db.execute(sql`
    SELECT coalesce(
      (SELECT actor_id FROM doc_updates
        WHERE document_id = ${documentId} AND actor_id IS NOT NULL
        ORDER BY id DESC LIMIT 1),
      (SELECT uploader_id FROM documents WHERE id = ${documentId})
    ) AS id
  `)) as unknown as { id: string }[];
  await transactionWithEvents(async (tx, emit) => {
    for (const change of changes) {
      await tx.execute(sql`
        UPDATE threads SET orphaned_at = ${change.orphaned ? sql`now()` : sql`NULL`} WHERE id = ${change.id}
      `);
      emit({
        documentId,
        actorId: by!.id,
        type: 'thread.orphaned',
        payload: { document_id: documentId, thread_id: change.id, orphaned: change.orphaned },
      });
    }
  });
}

const timers = new Map<string, NodeJS.Timeout>();

/** Rechecks the document's threads once its updates are stored and it has
 *  been quiet for ORPHAN_SYNC_DELAY_MS. */
export function scheduleOrphanSync(documentId: string, doc: Y.Doc): void {
  clearTimeout(timers.get(documentId));
  timers.set(
    documentId,
    setTimeout(() => {
      timers.delete(documentId);
      void persistedUpTo(doc)
        .then(() => syncOrphans(documentId, doc))
        .catch((err: unknown) =>
          logger.warn({ documentId, error: String(err) }, 'live document: thread orphan check failed'),
        );
    }, ORPHAN_SYNC_DELAY_MS),
  );
}

export function cancelOrphanSync(documentId: string): void {
  clearTimeout(timers.get(documentId));
  timers.delete(documentId);
}
