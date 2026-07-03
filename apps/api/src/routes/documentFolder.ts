import type { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import { documents, folders, documentFolders } from '@primer/shared/schema';
import { db } from '../db/client.ts';
import {
  canRead,
  effectiveRole,
  loadCollaboratorRole,
  type Visibility,
} from '../lib/permissions.ts';

async function canReadDoc(docId: string, userId: string): Promise<boolean> {
  const [doc] = await db
    .select({
      uploaderId: documents.uploaderId,
      visibility: documents.visibility,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(eq(documents.id, docId));
  if (!doc || doc.deletedAt !== null) return false;
  const visibility = doc.visibility as Visibility;
  const collabRole = await loadCollaboratorRole(docId, userId);
  const eff = effectiveRole({ uploaderId: doc.uploaderId, visibility }, userId, collabRole);
  return canRead(visibility, eff);
}

async function folderBelongsTo(folderId: string, userId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: folders.id })
    .from(folders)
    .where(and(eq(folders.id, folderId), eq(folders.userId, userId)));
  return !!row;
}

export function registerDocumentFolderRoutes(app: Hono<{ Variables: AppVariables }>): void {
  app.put('/api/documents/:docId/folder', async (c) => {
    const userId = c.get('user').id;
    const docId = c.req.param('docId');
    const body = await c.req.json().catch(() => null);
    if (body === null || (body.folderId !== null && typeof body.folderId !== 'string')) {
      return c.json({ error: 'invalid_body' }, 400);
    }
    if (!(await canReadDoc(docId, userId))) {
      return c.json({ error: 'not_found' }, 404);
    }
    if (body.folderId === null) {
      await db
        .delete(documentFolders)
        .where(and(eq(documentFolders.userId, userId), eq(documentFolders.documentId, docId)));
      return c.body(null, 204);
    }
    if (!(await folderBelongsTo(body.folderId, userId))) {
      return c.json({ error: 'folder_forbidden' }, 403);
    }
    await db
      .insert(documentFolders)
      .values({ userId, documentId: docId, folderId: body.folderId })
      .onConflictDoUpdate({
        target: [documentFolders.userId, documentFolders.documentId],
        set: { folderId: body.folderId },
      });
    return c.body(null, 204);
  });
}
