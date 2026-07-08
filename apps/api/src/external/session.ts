import { randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { externalViewerSessions } from '@primer/shared/schema';

export const VIEWER_COOKIE_NAME = 'primer_ext_sid';
export const VIEWER_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days, no sliding refresh

export interface ViewerContext {
  sessionId: string;
  recipient: { id: string; email: string; firstViewedAt: Date | null; addedBy: string };
  share: { id: string; documentId: string; publishedVersionId: string | null };
  document: { id: string; title: string };
}

export async function createViewerSession(
  recipientId: string,
  userAgent: string | null,
): Promise<{ id: string; expiresAt: Date }> {
  const id = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + VIEWER_SESSION_TTL_MS);
  await db.insert(externalViewerSessions).values({ id, recipientId, expiresAt, userAgent });
  return { id, expiresAt };
}

/**
 * Validate the entire chain in one query: session unexpired, recipient not
 * revoked/expired, share matches the token in the URL and is not revoked,
 * document not soft-deleted. Any broken link → null → viewer bounced to the
 * OTP screen. This is what makes revocation immediate.
 */
export async function lookupViewerSession(
  id: string,
  shareToken: string,
): Promise<ViewerContext | null> {
  const [row] = (await db.execute(sql`
    SELECT s.id                    AS "sessionId",
           r.id                    AS "recipientId",
           r.email                 AS "email",
           r.first_viewed_at       AS "firstViewedAt",
           r.added_by              AS "addedBy",
           sh.id                   AS "shareId",
           sh.document_id          AS "documentId",
           sh.published_version_id AS "publishedVersionId",
           d.id                    AS "docId",
           d.title                 AS "title"
    FROM external_viewer_sessions s
    INNER JOIN external_recipients r ON r.id = s.recipient_id
    INNER JOIN external_shares sh    ON sh.id = r.share_id
    INNER JOIN documents d           ON d.id = sh.document_id
    WHERE s.id = ${id}
      AND s.expires_at > now()
      AND r.revoked_at IS NULL
      AND r.expires_at > now()
      AND sh.share_token = ${shareToken}
      AND sh.revoked_at IS NULL
      AND d.deleted_at IS NULL
    LIMIT 1
  `)) as unknown as Array<{
    sessionId: string;
    recipientId: string;
    email: string;
    firstViewedAt: Date | string | null;
    addedBy: string;
    shareId: string;
    documentId: string;
    publishedVersionId: string | null;
    docId: string;
    title: string;
  }>;
  if (!row) return null;
  return {
    sessionId: row.sessionId,
    recipient: {
      id: row.recipientId,
      email: row.email,
      firstViewedAt:
        row.firstViewedAt === null
          ? null
          : row.firstViewedAt instanceof Date
            ? row.firstViewedAt
            : new Date(row.firstViewedAt),
      addedBy: row.addedBy,
    },
    share: { id: row.shareId, documentId: row.documentId, publishedVersionId: row.publishedVersionId },
    document: { id: row.docId, title: row.title },
  };
}

export async function deleteSessionsForRecipient(recipientId: string): Promise<void> {
  await db.execute(sql`DELETE FROM external_viewer_sessions WHERE recipient_id = ${recipientId}`);
}

export async function deleteSessionsForShare(shareId: string): Promise<void> {
  await db.execute(sql`
    DELETE FROM external_viewer_sessions
    WHERE recipient_id IN (SELECT id FROM external_recipients WHERE share_id = ${shareId})
  `);
}
