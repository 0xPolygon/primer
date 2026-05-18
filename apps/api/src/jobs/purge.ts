import { sql, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { documents, versions } from '@primer/shared/schema';
import { logger } from '../logger.ts';
import type { Storage } from '@primer/shared';

export const RESTORE_WINDOW_DAYS = 30;

export interface PurgeReport {
  purgedDocumentIds: string[];
  purgedStorageKeys: string[];
  failedStorageKeys: { key: string; error: string }[];
  durationMs: number;
}

export async function purgeExpiredDocuments(deps: { storage: Storage }): Promise<PurgeReport> {
  const startedAt = Date.now();
  const report: PurgeReport = {
    purgedDocumentIds: [],
    purgedStorageKeys: [],
    failedStorageKeys: [],
    durationMs: 0,
  };

  const candidates = (await db.execute(sql`
    SELECT id FROM documents
    WHERE deleted_at IS NOT NULL
      AND deleted_at < now() - make_interval(days => ${RESTORE_WINDOW_DAYS})
    ORDER BY deleted_at ASC
  `)) as unknown as { id: string }[];

  for (const { id: docId } of candidates) {
    const versionRows = await db
      .select({ id: versions.id, storageKey: versions.storageKey })
      .from(versions)
      .where(eq(versions.documentId, docId));

    // Delete storage files first.
    for (const v of versionRows) {
      try {
        await deps.storage.delete(v.storageKey);
        report.purgedStorageKeys.push(v.storageKey);
      } catch (err) {
        report.failedStorageKeys.push({
          key: v.storageKey,
          error: (err as Error).message,
        });
        logger.warn({ docId, storageKey: v.storageKey, err }, 'purge: storage delete failed');
      }
    }

    // Delete the doc row; FK cascade removes versions / threads / comments / document_views.
    await db.delete(documents).where(eq(documents.id, docId));
    report.purgedDocumentIds.push(docId);
    logger.info({ docId }, 'purge: document hard-deleted');
  }

  report.durationMs = Date.now() - startedAt;
  return report;
}

export interface SessionPurgeReport {
  deletedCount: number;
  durationMs: number;
}

const SESSION_GRACE_DAYS = 7;

export async function purgeExpiredSessions(): Promise<SessionPurgeReport> {
  const startedAt = Date.now();
  const result = (await db.execute(sql`
    DELETE FROM sessions
    WHERE expires_at < now() - make_interval(days => ${SESSION_GRACE_DAYS})
  `)) as unknown as { count?: number; rowCount?: number } | unknown;
  // Drizzle's underlying driver may surface rowCount via different keys.
  let deletedCount = 0;
  if (result && typeof result === 'object') {
    const obj = result as Record<string, unknown>;
    if (typeof obj.count === 'number') deletedCount = obj.count;
    else if (typeof obj.rowCount === 'number') deletedCount = obj.rowCount;
  }
  return { deletedCount, durationMs: Date.now() - startedAt };
}

export function startPurgeInterval(deps: {
  storage: Storage;
  intervalMs?: number;
}): () => Promise<void> {
  const intervalMs = deps.intervalMs ?? 60 * 60 * 1000;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const tick = async () => {
    if (stopped) return;
    inFlight = (async () => {
      try {
        const docReport = await purgeExpiredDocuments({ storage: deps.storage });
        const sessionReport = await purgeExpiredSessions();
        if (
          docReport.purgedDocumentIds.length > 0 ||
          docReport.failedStorageKeys.length > 0 ||
          sessionReport.deletedCount > 0
        ) {
          logger.info({ docReport, sessionReport }, 'purge interval: complete');
        }
      } catch (err) {
        logger.error({ err }, 'purge interval: unexpected failure');
      } finally {
        inFlight = null;
      }
    })();
    await inFlight;
  };

  const timer = setInterval(() => { void tick(); }, intervalMs);

  return async () => {
    stopped = true;
    clearInterval(timer);
    if (inFlight) await inFlight;
  };
}
