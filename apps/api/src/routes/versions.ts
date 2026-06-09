import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import type { VersionSummaryDTO } from '@primer/shared';
import { documents, versions } from '@primer/shared/schema';
import { resolveDocumentTemplate } from '@primer/shared/templates';
import { db } from '../db/client.ts';

export function registerVersionRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.patch('/api/versions/:versionId', async (c) => {
    const versionId = c.req.param('versionId');
    const user = c.get('user');

    let payload: { versionNote?: unknown };
    try {
      payload = (await c.req.json()) as { versionNote?: unknown };
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }

    if (!Object.prototype.hasOwnProperty.call(payload, 'versionNote')) {
      return c.json({ error: 'invalid_body', message: 'versionNote required (string or null)' }, 400);
    }

    let versionNote: string | null;
    if (payload.versionNote === null) {
      versionNote = null;
    } else if (typeof payload.versionNote === 'string') {
      const trimmed = payload.versionNote.trim();
      if (trimmed.length > 500) {
        return c.json({ error: 'invalid_body', message: 'versionNote must be ≤500 chars' }, 400);
      }
      versionNote = trimmed.length === 0 ? null : trimmed;
    } else {
      return c.json({ error: 'invalid_body', message: 'versionNote must be string or null' }, 400);
    }

    const [row] = await db
      .select({
        versionId: versions.id,
        documentId: versions.documentId,
        uploaderId: documents.uploaderId,
        docDeletedAt: documents.deletedAt,
      })
      .from(versions)
      .innerJoin(documents, eq(documents.id, versions.documentId))
      .where(eq(versions.id, versionId));
    if (!row) return c.json({ error: 'not_found' }, 404);
    if (row.docDeletedAt !== null) return c.json({ error: 'not_found' }, 404);
    if (row.uploaderId !== user.id) return c.json({ error: 'forbidden' }, 403);

    await db.update(versions).set({ versionNote }).where(eq(versions.id, versionId));

    const [updated] = await db
      .select({
        id: versions.id,
        versionNumber: versions.versionNumber,
        versionNote: versions.versionNote,
        sizeBytes: versions.sizeBytes,
        template: versions.template,
        createdAt: versions.createdAt,
      })
      .from(versions)
      .where(eq(versions.id, versionId));

    const dto: VersionSummaryDTO = {
      id: updated.id,
      versionNumber: updated.versionNumber,
      versionNote: updated.versionNote,
      sizeBytes: updated.sizeBytes,
      template: resolveDocumentTemplate(updated.template),
      createdAt: updated.createdAt.toISOString(),
    };
    return c.json(dto, 200);
  });
}
