import type { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables, AppDeps, AuthUser } from '../app.ts';
import {
  isCollaboratorRole,
  type AddCollaboratorRequest,
  type Collaborator,
  type CollaboratorsListResponse,
  type UpdateCollaboratorRequest,
} from '@polygonlabs/primer-api-types';
import { documents, documentCollaborators, users } from '../db/schema.ts';
import { db } from '../db/client.ts';
import { actorName } from '../lib/actors.ts';
import { logger } from '../logger.ts';
import { recheckLive } from '../live/revoke.ts';
import {
  canManage,
  canRead,
  loadEffectiveRole,
  type CollaboratorRole,
  type Visibility,
} from '../lib/permissions.ts';

async function loadDocForManage(
  docId: string,
  actor: AuthUser,
): Promise<
  | { status: 'not_found' }
  | { status: 'forbidden' }
  | { status: 'ok'; doc: { id: string; title: string; uploaderId: string; visibility: Visibility } }
> {
  const [row] = await db
    .select({
      id: documents.id,
      title: documents.title,
      uploaderId: documents.uploaderId,
      visibility: documents.visibility,
      deletedAt: documents.deletedAt,
    })
    .from(documents)
    .where(eq(documents.id, docId));
  if (!row) return { status: 'not_found' };
  if (row.deletedAt !== null) return { status: 'not_found' };

  const eff = await loadEffectiveRole(
    { id: docId, uploaderId: row.uploaderId, visibility: row.visibility as Visibility },
    actor,
  );
  if (!canRead(row.visibility as Visibility, eff)) return { status: 'not_found' };
  if (!canManage(eff)) return { status: 'forbidden' };
  return {
    status: 'ok',
    doc: { id: row.id, title: row.title, uploaderId: row.uploaderId, visibility: row.visibility as Visibility },
  };
}

export function registerCollaboratorRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps,
): void {
  app.get('/api/documents/:docId/collaborators', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    const rows = await db
      .select({
        userId: documentCollaborators.userId,
        role: documentCollaborators.role,
        grantedBy: documentCollaborators.grantedBy,
        createdAt: documentCollaborators.createdAt,
        displayName: actorName,
      })
      .from(documentCollaborators)
      .innerJoin(users, eq(users.id, documentCollaborators.userId))
      .where(eq(documentCollaborators.documentId, docId))
      .orderBy(documentCollaborators.createdAt);

    const body: CollaboratorsListResponse = {
      collaborators: rows.map((r) => ({
        userId: r.userId,
        displayName: r.displayName,
        role: r.role as CollaboratorRole,
        grantedBy: r.grantedBy,
        createdAt: r.createdAt.toISOString(),
      })),
    };
    return c.json(body, 200);
  });

  app.post('/api/documents/:docId/collaborators', async (c) => {
    const docId = c.req.param('docId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    let payload: Partial<AddCollaboratorRequest>;
    try {
      payload = (await c.req.json()) as Partial<AddCollaboratorRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    if (typeof payload.userId !== 'string' || payload.userId.length === 0 || !isCollaboratorRole(payload.role)) {
      return c.json({ error: 'invalid_body', message: 'userId (string) and role (commenter|responder|editor) are required' }, 400);
    }
    const { userId: targetUserId, role } = payload;
    if (targetUserId === gate.doc.uploaderId) {
      return c.json({ error: 'owner_not_collaborator', message: 'Owner cannot be added as their own collaborator.' }, 400);
    }
    // Responder is allowed on org documents because it grants what org visibility
    // does not (event-write); commenter is not because it grants nothing there.
    if (gate.doc.visibility === 'org' && role === 'commenter') {
      return c.json(
        { error: 'invalid_role_for_visibility', message: 'Commenter role is only meaningful under private visibility.' },
        400,
      );
    }
    const [target] = await db
      .select({ id: users.id, displayName: actorName })
      .from(users)
      .where(eq(users.id, targetUserId));
    if (!target) return c.json({ error: 'user_not_found', message: 'target user does not exist' }, 400);

    const id = uuidv7();
    const createdAt = new Date();
    try {
      await db.insert(documentCollaborators).values({
        id,
        documentId: docId,
        userId: targetUserId,
        role,
        grantedBy: user.id,
        createdAt,
      });
    } catch (err) {
      const pgErr = err as { code?: string; cause?: { code?: string } };
      const pgCode = pgErr.code ?? pgErr.cause?.code;
      if (pgCode === '23505') {
        return c.json({ error: 'collaborator_exists', message: 'that user is already a collaborator' }, 409);
      }
      throw err;
    }

    void deps.notifier
      .notifyCollaboratorAdded({
        docId,
        docTitle: gate.doc.title,
        addedUserId: targetUserId,
        addedByUserId: user.id,
        role,
      })
      .catch((err) => logger.error({ err, docId, addedUserId: targetUserId }, 'notifier notifyCollaboratorAdded failed'));

    const body: Collaborator = {
      userId: targetUserId,
      displayName: target.displayName,
      role,
      grantedBy: user.id,
      createdAt: createdAt.toISOString(),
    };
    return c.json(body, 201);
  });

  app.patch('/api/documents/:docId/collaborators/:userId', async (c) => {
    const docId = c.req.param('docId');
    const targetUserId = c.req.param('userId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    let payload: Partial<UpdateCollaboratorRequest>;
    try {
      payload = (await c.req.json()) as Partial<UpdateCollaboratorRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    if (!isCollaboratorRole(payload.role)) {
      return c.json({ error: 'invalid_body', message: 'role (commenter|responder|editor) is required' }, 400);
    }
    const { role } = payload;
    if (gate.doc.visibility === 'org' && role === 'commenter') {
      return c.json(
        { error: 'invalid_role_for_visibility', message: 'Commenter role is only meaningful under private visibility.' },
        400,
      );
    }

    const [existing] = await db
      .select({ userId: documentCollaborators.userId })
      .from(documentCollaborators)
      .where(and(eq(documentCollaborators.documentId, docId), eq(documentCollaborators.userId, targetUserId)));
    if (!existing) return c.json({ error: 'not_found' }, 404);

    await db
      .update(documentCollaborators)
      .set({ role })
      .where(and(eq(documentCollaborators.documentId, docId), eq(documentCollaborators.userId, targetUserId)));
    await recheckLive({ documentId: docId });

    const [row] = await db
      .select({
        userId: documentCollaborators.userId,
        role: documentCollaborators.role,
        grantedBy: documentCollaborators.grantedBy,
        createdAt: documentCollaborators.createdAt,
        displayName: actorName,
      })
      .from(documentCollaborators)
      .innerJoin(users, eq(users.id, documentCollaborators.userId))
      .where(and(eq(documentCollaborators.documentId, docId), eq(documentCollaborators.userId, targetUserId)));

    const body: Collaborator = {
      userId: row.userId,
      displayName: row.displayName,
      role: row.role as CollaboratorRole,
      grantedBy: row.grantedBy,
      createdAt: row.createdAt.toISOString(),
    };
    return c.json(body, 200);
  });

  app.delete('/api/documents/:docId/collaborators/:userId', async (c) => {
    const docId = c.req.param('docId');
    const targetUserId = c.req.param('userId');
    const user = c.get('user');
    const gate = await loadDocForManage(docId, user);
    if (gate.status === 'not_found') return c.json({ error: 'not_found' }, 404);
    if (gate.status === 'forbidden') return c.json({ error: 'forbidden' }, 403);

    await db
      .delete(documentCollaborators)
      .where(and(eq(documentCollaborators.documentId, docId), eq(documentCollaborators.userId, targetUserId)));
    await recheckLive({ documentId: docId });
    return new Response(null, { status: 204 });
  });
}
