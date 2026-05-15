import type { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { eq } from 'drizzle-orm';
import type { AppVariables, AppDeps } from '../app.ts';
import type { CommentBodyRequest, CommentDTO, ThreadDTO } from '@primer/shared';
import { threads, comments, users } from '@primer/shared/schema';
import { db } from '../db/client.ts';

const MAX_BODY = 5000;

function validateBody(raw: unknown): { ok: true; body: string } | { ok: false } {
  if (typeof raw !== 'string') return { ok: false };
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_BODY) return { ok: false };
  return { ok: true, body: trimmed };
}

interface ThreadRow {
  id: string;
  versionId: string;
  anchor: unknown;
  resolvedAt: Date | null;
  resolvedBy: string | null;
  resolvedByDisplayName: string | null;
  createdAt: Date;
}

interface CommentRow {
  id: string;
  threadId: string;
  authorId: string;
  authorDisplayName: string;
  body: string;
  mentions: string[];
  createdAt: Date;
  updatedAt: Date | null;
  deletedAt: Date | null;
}

function commentToDTO(row: CommentRow): CommentDTO {
  const isTombstoned = row.deletedAt !== null;
  return {
    id: row.id,
    threadId: row.threadId,
    authorId: row.authorId,
    authorDisplayName: row.authorDisplayName,
    body: isTombstoned ? '' : row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    mentions: row.mentions,
  };
}

async function loadThreadDTO(threadId: string): Promise<ThreadDTO | null> {
  const [row] = (await db
    .select({
      id: threads.id,
      versionId: threads.versionId,
      anchor: threads.anchor,
      resolvedAt: threads.resolvedAt,
      resolvedBy: threads.resolvedBy,
      resolvedByDisplayName: users.displayName,
      createdAt: threads.createdAt,
    })
    .from(threads)
    .leftJoin(users, eq(users.id, threads.resolvedBy))
    .where(eq(threads.id, threadId))) as ThreadRow[];
  if (!row) return null;

  const commentRows = (await db
    .select({
      id: comments.id,
      threadId: comments.threadId,
      authorId: comments.authorId,
      authorDisplayName: users.displayName,
      body: comments.body,
      mentions: comments.mentions,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      deletedAt: comments.deletedAt,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(eq(comments.threadId, threadId))
    .orderBy(comments.createdAt)) as CommentRow[];

  return {
    id: row.id,
    versionId: row.versionId,
    anchor: row.anchor as ThreadDTO['anchor'],
    resolvedAt: row.resolvedAt?.toISOString() ?? null,
    resolvedBy: row.resolvedBy,
    resolvedByDisplayName: row.resolvedByDisplayName,
    createdAt: row.createdAt.toISOString(),
    comments: commentRows.map(commentToDTO),
  };
}

export function registerCommentRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
  app.post('/api/threads/:threadId/comments', async (c) => {
    const threadId = c.req.param('threadId');
    let payload: Partial<CommentBodyRequest>;
    try {
      payload = (await c.req.json()) as Partial<CommentBodyRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    const validation = validateBody(payload.body);
    if (!validation.ok) {
      return c.json({ error: 'invalid_body', message: `Body must be 1–${MAX_BODY} chars after trim.` }, 400);
    }

    // Pre-flight thread existence check — otherwise a fake threadId would
    // trigger an unhandled FK violation in the transaction below.
    const [existingThread] = await db
      .select({ id: threads.id })
      .from(threads)
      .where(eq(threads.id, threadId));
    if (!existingThread) {
      return c.json({ error: 'not_found', message: 'thread not found' }, 404);
    }

    const commentId = uuidv7();
    const user = c.get('user');

    const priorAuthors = (await db
      .select({ authorId: comments.authorId })
      .from(comments)
      .where(eq(comments.threadId, threadId))) as { authorId: string }[];
    const participantUserIds = Array.from(
      new Set(priorAuthors.map((r) => r.authorId).filter((id) => id !== user.id))
    );

    await db.transaction(async (tx) => {
      await tx.insert(comments).values({
        id: commentId,
        threadId,
        authorId: user.id,
        body: validation.body,
        mentions: [],
      });
      // Auto-reopen if resolved (no-op when not resolved).
      await tx
        .update(threads)
        .set({ resolvedAt: null, resolvedBy: null })
        .where(eq(threads.id, threadId));
    });

    await deps.notifier.notifyReplyParticipants({
      participantUserIds,
      threadId,
      commentId,
      actorUserId: user.id,
    });
    await deps.notifier.notifyMentions({
      mentions: [],
      threadId,
      commentId,
      actorUserId: user.id,
    });

    const dto = await loadThreadDTO(threadId);
    if (!dto) return c.json({ error: 'not_found' }, 404);
    const newComment = dto.comments.find((cm) => cm.id === commentId)!;
    return c.json({ comment: newComment, thread: dto }, 201);
  });

  app.patch('/api/comments/:commentId', async (c) => {
    const commentId = c.req.param('commentId');
    let payload: Partial<CommentBodyRequest>;
    try {
      payload = (await c.req.json()) as Partial<CommentBodyRequest>;
    } catch {
      return c.json({ error: 'invalid_body', message: 'JSON parse failed' }, 400);
    }
    const validation = validateBody(payload.body);
    if (!validation.ok) {
      return c.json({ error: 'invalid_body', message: `Body must be 1–${MAX_BODY} chars after trim.` }, 400);
    }
    const user = c.get('user');

    const [existing] = await db.select().from(comments).where(eq(comments.id, commentId));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.authorId !== user.id) return c.json({ error: 'forbidden' }, 403);
    if (existing.deletedAt !== null) return c.json({ error: 'conflict' }, 409);

    await db
      .update(comments)
      .set({ body: validation.body, updatedAt: new Date() })
      .where(eq(comments.id, commentId));

    await deps.notifier.notifyMentions({
      mentions: [],
      threadId: existing.threadId,
      commentId,
      actorUserId: user.id,
    });

    const [row] = (await db
      .select({
        id: comments.id,
        threadId: comments.threadId,
        authorId: comments.authorId,
        authorDisplayName: users.displayName,
        body: comments.body,
        mentions: comments.mentions,
        createdAt: comments.createdAt,
        updatedAt: comments.updatedAt,
        deletedAt: comments.deletedAt,
      })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.id, commentId))) as CommentRow[];
    return c.json(commentToDTO(row), 200);
  });

  app.delete('/api/comments/:commentId', async (c) => {
    const commentId = c.req.param('commentId');
    const user = c.get('user');
    const [existing] = await db.select().from(comments).where(eq(comments.id, commentId));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.authorId !== user.id) return c.json({ error: 'forbidden' }, 403);
    if (existing.deletedAt === null) {
      await db.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, commentId));
    }
    const [row] = (await db
      .select({
        id: comments.id,
        threadId: comments.threadId,
        authorId: comments.authorId,
        authorDisplayName: users.displayName,
        body: comments.body,
        mentions: comments.mentions,
        createdAt: comments.createdAt,
        updatedAt: comments.updatedAt,
        deletedAt: comments.deletedAt,
      })
      .from(comments)
      .innerJoin(users, eq(users.id, comments.authorId))
      .where(eq(comments.id, commentId))) as CommentRow[];
    return c.json(commentToDTO(row), 200);
  });
}
