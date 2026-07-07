import type { Hono } from 'hono';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables, AppDeps } from '../app.ts';
import type {
  AddExternalRecipientRequest, ExternalShareResponse, PublishExternalShareRequest,
} from '@primer/shared';
import { documents, versions, externalShares, externalRecipients } from '@primer/shared/schema';
import { db } from '../db/client.ts';
import { logger } from '../logger.ts';
import {
  canManage, canRead, effectiveRole, loadCollaboratorRole, type Visibility,
} from '../lib/permissions.ts';
import { generateShareToken } from '../external/tokens.ts';
import { deleteSessionsForRecipient, deleteSessionsForShare } from '../external/session.ts';

const DEFAULT_EXPIRY_DAYS = 90;
const MAX_EXPIRY_DAYS = 365;

// Same manage-gate as collaborators.ts: non-readers get 404 (don't reveal the
// doc exists), readers without manage rights get 403.
async function loadDocForManage(
  docId: string,
  userId: string,
): Promise<{ status: 'not_found' } | { status: 'forbidden' } | { status: 'ok' }> {
  const [row] = await db
    .select({
      uploaderId: documents.uploaderId,
      visibility: documents.visibility,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(eq(documents.id, docId));
  if (!row || row.deletedAt !== null) return { status: 'not_found' };
  const collabRole = await loadCollaboratorRole(docId, userId);
  const eff = effectiveRole(
    { uploaderId: row.uploaderId, visibility: row.visibility as Visibility },
    userId,
    collabRole,
  );
  if (!canRead(row.visibility as Visibility, eff)) return { status: 'not_found' };
  if (!canManage(eff)) return { status: 'forbidden' };
  return { status: 'ok' };
}

async function activeShare(docId: string): Promise<{ id: string; shareToken: string; publishedVersionId: string | null; createdAt: Date } | null> {
  const [row] = await db
    .select({
      id: externalShares.id,
      shareToken: externalShares.shareToken,
      publishedVersionId: externalShares.publishedVersionId,
      createdAt: externalShares.createdAt,
    })
    .from(externalShares)
    .where(and(eq(externalShares.documentId, docId), isNull(externalShares.revokedAt)));
  return row ?? null;
}

export function registerExternalShareAdminRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps,
): void {
  app.get('/api/documents/:docId/external-share', async (c) => {
    const docId = c.req.param('docId');
    const gate = await loadDocForManage(docId, c.get('user').id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    const emailEnabled = deps.notifier.emailEnabled;
    const share = await activeShare(docId);
    if (!share) {
      return c.json({ share: null, recipients: [], emailEnabled } satisfies ExternalShareResponse);
    }

    let publishedVersionNumber: number | null = null;
    if (share.publishedVersionId !== null) {
      const [v] = await db
        .select({ versionNumber: versions.versionNumber })
        .from(versions)
        .where(eq(versions.id, share.publishedVersionId));
      publishedVersionNumber = v?.versionNumber ?? null;
    }

    const recipients = (await db.execute(sql`
      SELECT r.id, r.email,
             r.created_at      AS "createdAt",
             r.expires_at      AS "expiresAt",
             r.revoked_at      AS "revokedAt",
             r.first_viewed_at AS "firstViewedAt",
             count(v.id)::int  AS "viewCount",
             max(v.viewed_at)  AS "lastViewedAt"
      FROM external_recipients r
      LEFT JOIN external_views v ON v.recipient_id = r.id
      WHERE r.share_id = ${share.id}
      GROUP BY r.id
      ORDER BY r.created_at
    `)) as unknown as Array<{
      id: string; email: string; createdAt: Date | string; expiresAt: Date | string;
      revokedAt: Date | string | null; firstViewedAt: Date | string | null;
      viewCount: number; lastViewedAt: Date | string | null;
    }>;

    const iso = (d: Date | string | null): string | null =>
      d === null ? null : (d instanceof Date ? d : new Date(d)).toISOString();

    const body: ExternalShareResponse = {
      emailEnabled,
      share: {
        id: share.id,
        shareToken: share.shareToken,
        publishedVersionId: share.publishedVersionId,
        publishedVersionNumber,
        createdAt: share.createdAt.toISOString(),
      },
      recipients: recipients.map((r) => ({
        id: r.id,
        email: r.email,
        createdAt: iso(r.createdAt)!,
        expiresAt: iso(r.expiresAt)!,
        revokedAt: iso(r.revokedAt),
        firstViewedAt: iso(r.firstViewedAt),
        viewCount: r.viewCount,
        lastViewedAt: iso(r.lastViewedAt),
      })),
    };
    return c.json(body);
  });

  app.post('/api/documents/:docId/external-share', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user.id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);
    if (await activeShare(docId)) return c.json({ error: 'share_exists' }, 409);

    const share = {
      id: uuidv7(),
      documentId: docId,
      shareToken: generateShareToken(),
      createdBy: user.id,
    };
    await db.insert(externalShares).values(share);
    logger.info({ docId, shareId: share.id, userId: user.id }, 'external share created');
    return c.json({ share: { id: share.id, shareToken: share.shareToken } }, 201);
  });

  app.delete('/api/documents/:docId/external-share', async (c) => {
    const docId = c.req.param('docId');
    const gate = await loadDocForManage(docId, c.get('user').id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);
    const share = await activeShare(docId);
    if (!share) return c.json({ error: 'not_found' }, 404);

    await db.update(externalShares).set({ revokedAt: new Date() }).where(eq(externalShares.id, share.id));
    await deleteSessionsForShare(share.id);
    logger.info({ docId, shareId: share.id }, 'external share revoked');
    return c.json({ ok: true });
  });

  app.post('/api/documents/:docId/external-share/recipients', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user.id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);
    const share = await activeShare(docId);
    if (!share) return c.json({ error: 'not_found' }, 404);

    const body = (await c.req.json().catch(() => null)) as AddExternalRecipientRequest | null;
    const email = typeof body?.email === 'string' ? body.email.trim().toLowerCase() : '';
    const atIdx = email.indexOf('@');
    if (!email || email.length > 320 || atIdx < 1 || atIdx === email.length - 1) {
      return c.json({ error: 'invalid_email' }, 400);
    }
    const days = Math.min(
      typeof body?.expiresInDays === 'number' && body.expiresInDays > 0
        ? Math.floor(body.expiresInDays)
        : DEFAULT_EXPIRY_DAYS,
      MAX_EXPIRY_DAYS,
    );

    const [existing] = await db
      .select({ id: externalRecipients.id, revokedAt: externalRecipients.revokedAt })
      .from(externalRecipients)
      .where(and(eq(externalRecipients.shareId, share.id), eq(externalRecipients.email, email)));
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

    if (existing && existing.revokedAt === null) return c.json({ error: 'recipient_exists' }, 409);
    if (existing) {
      // Re-adding a previously revoked email: un-revoke with a fresh expiry.
      await db.update(externalRecipients)
        .set({ revokedAt: null, expiresAt, addedBy: user.id })
        .where(eq(externalRecipients.id, existing.id));
      return c.json({ recipient: { id: existing.id, email, expiresAt: expiresAt.toISOString() } }, 201);
    }
    const id = uuidv7();
    await db.insert(externalRecipients).values({ id, shareId: share.id, email, addedBy: user.id, expiresAt });
    return c.json({ recipient: { id, email, expiresAt: expiresAt.toISOString() } }, 201);
  });

  app.delete('/api/documents/:docId/external-share/recipients/:recipientId', async (c) => {
    const docId = c.req.param('docId');
    const recipientId = c.req.param('recipientId');
    const gate = await loadDocForManage(docId, c.get('user').id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);
    const share = await activeShare(docId);
    if (!share) return c.json({ error: 'not_found' }, 404);

    const result = await db.update(externalRecipients)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(externalRecipients.id, recipientId),
        eq(externalRecipients.shareId, share.id), // recipient must belong to THIS doc's share
        isNull(externalRecipients.revokedAt),
      ))
      .returning({ id: externalRecipients.id });
    if (result.length === 0) return c.json({ error: 'not_found' }, 404);
    await deleteSessionsForRecipient(recipientId);
    return c.json({ ok: true });
  });

  app.post('/api/documents/:docId/external-share/publish', async (c) => {
    const docId = c.req.param('docId');
    const gate = await loadDocForManage(docId, c.get('user').id);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);
    const share = await activeShare(docId);
    if (!share) return c.json({ error: 'not_found' }, 404);

    const body = (await c.req.json().catch(() => null)) as PublishExternalShareRequest | null;
    const versionId = typeof body?.versionId === 'string' ? body.versionId : '';
    const [version] = await db
      .select({ id: versions.id })
      .from(versions)
      .where(and(eq(versions.id, versionId), eq(versions.documentId, docId)));
    if (!version) return c.json({ error: 'invalid_version' }, 400);

    await db.update(externalShares)
      .set({ publishedVersionId: version.id })
      .where(eq(externalShares.id, share.id));
    logger.info({ docId, shareId: share.id, versionId }, 'external share published');
    return c.json({ ok: true });
  });
}
