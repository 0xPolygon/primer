import type { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, AppDeps } from '../app.ts';
import { logger } from '../logger.ts';
import type { CommentBodyRequest, CommentDTO, ThreadDTO } from '@primer/shared';
import { threads, comments, users } from '@primer/shared/schema';
import { db } from '../db/client.ts';
import { validateAndCleanMentions } from '../notifications/mentions.ts';

async function ensureLiveDocumentForThread(threadId: string): Promise<{ ok: true } | { ok: false }> {
  const [r] = (await db.execute(sql`
    SELECT d.deleted_at FROM threads t
    INNER JOIN versions v ON v.id = t.version_id
    INNER JOIN documents d ON d.id = v.document_id
    WHERE t.id = ${threadId}
    LIMIT 1
  `)) as unknown as { deleted_at: Date | null }[];
  if (!r) return { ok: false };
  return r.deleted_at === null ? { ok: true } : { ok: false };
}

async function ensureLiveDocumentForComment(commentId: string): Promise<{ ok: true } | { ok: false }> {
  const [r] = (await db.execute(sql`
    SELECT d.deleted_at FROM comments c
    INNER JOIN threads t ON t.id = c.thread_id
    INNER JOIN versions v ON v.id = t.version_id
    INNER JOIN documents d ON d.id = v.document_id
    WHERE c.id = ${commentId}
    LIMIT 1
  `)) as unknown as { deleted_at: Date | null }[];
  if (!r) return { ok: false };
  return r.deleted_at === null ? { ok: true } : { ok: false };
}

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

    const live = await ensureLiveDocumentForThread(threadId);
    if (!live.ok) return c.json({ error: 'not_found' }, 404);

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

    // Load thread context (existence check + doc/version info for notifier).
    const [threadCtx] = (await db.execute(sql`
      SELECT d.id AS doc_id, d.title AS doc_title,
             v.id AS version_id, v.version_number::int AS version_number
      FROM threads t
      INNER JOIN versions v ON v.id = t.version_id
      INNER JOIN documents d ON d.id = v.document_id
      WHERE t.id = ${threadId}
      LIMIT 1
    `)) as unknown as Array<{
      doc_id: string;
      doc_title: string;
      version_id: string;
      version_number: number;
    }>;
    if (!threadCtx) {
      return c.json({ error: 'not_found', message: 'thread not found' }, 404);
    }

    const user = c.get('user');

    // Validate mentions before touching the DB.
    const rawMentions = (payload as { mentions?: unknown }).mentions;
    let validated;
    if (rawMentions === undefined || (Array.isArray(rawMentions) && rawMentions.length === 0)) {
      validated = { ok: true as const, mentions: [] };
    } else {
      const userRows = await db.select({ id: users.id }).from(users);
      const knownUserIds = new Set(userRows.map((r) => r.id));
      validated = validateAndCleanMentions(rawMentions as string[], user.id, knownUserIds);
    }
    if (!validated.ok) {
      return c.json({ error: validated.error, message: validated.message }, 400);
    }
    const cleanedMentions = validated.mentions;

    const commentId = uuidv7();
    const insertedAt = new Date();

    // Prior thread participants (only non-deleted comments).
    const priorRows = (await db.execute(sql`
      SELECT DISTINCT author_id AS author_id
      FROM comments
      WHERE thread_id = ${threadId}
        AND deleted_at IS NULL
    `)) as unknown as Array<{ author_id: string }>;

    const mentionSet = new Set(cleanedMentions);
    const participantUserIds = priorRows
      .map((r) => r.author_id)
      .filter((id) => id !== user.id && !mentionSet.has(id));

    await db.transaction(async (tx) => {
      await tx.insert(comments).values({
        id: commentId,
        threadId,
        authorId: user.id,
        body: validation.body,
        mentions: cleanedMentions,
      });
      // Auto-reopen if resolved (no-op when not resolved).
      await tx
        .update(threads)
        .set({ resolvedAt: null, resolvedBy: null })
        .where(eq(threads.id, threadId));
    });

    void deps.notifier
      .notifyComment({
        doc: { id: threadCtx.doc_id, title: threadCtx.doc_title },
        version: { id: threadCtx.version_id, versionNumber: threadCtx.version_number },
        thread: { id: threadId },
        comment: { id: commentId, body: validation.body, createdAt: insertedAt },
        mentionedUserIds: cleanedMentions,
        participantUserIds,
        uploaderUserId: null,
        actorUserId: user.id,
      })
      .catch((err) => logger.error({ err, commentId }, 'notifier failed'));

    const dto = await loadThreadDTO(threadId);
    if (!dto) return c.json({ error: 'not_found' }, 404);
    const newComment = dto.comments.find((cm) => cm.id === commentId)!;
    return c.json({ comment: newComment, thread: dto }, 201);
  });

  app.patch('/api/comments/:commentId', async (c) => {
    const commentId = c.req.param('commentId');

    const live = await ensureLiveDocumentForComment(commentId);
    if (!live.ok) return c.json({ error: 'not_found' }, 404);

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

    // Validate mentions before touching the DB.
    const rawMentions = (payload as { mentions?: unknown }).mentions;
    let validated;
    if (rawMentions === undefined || (Array.isArray(rawMentions) && rawMentions.length === 0)) {
      validated = { ok: true as const, mentions: [] };
    } else {
      const userRows = await db.select({ id: users.id }).from(users);
      const knownUserIds = new Set(userRows.map((r) => r.id));
      validated = validateAndCleanMentions(rawMentions as string[], user.id, knownUserIds);
    }
    if (!validated.ok) {
      return c.json({ error: validated.error, message: validated.message }, 400);
    }
    const cleanedMentions = validated.mentions;

    const [existing] = await db.select().from(comments).where(eq(comments.id, commentId));
    if (!existing) return c.json({ error: 'not_found' }, 404);
    if (existing.authorId !== user.id) return c.json({ error: 'forbidden' }, 403);
    if (existing.deletedAt !== null) return c.json({ error: 'conflict' }, 409);

    // Diff mentions: only newly-added ones trigger a notification.
    const previous = new Set(existing.mentions);
    const newlyAdded = cleanedMentions.filter((id) => !previous.has(id));

    const updatedAt = new Date();
    await db
      .update(comments)
      .set({ body: validation.body, mentions: cleanedMentions, updatedAt })
      .where(eq(comments.id, commentId));

    if (newlyAdded.length > 0) {
      const [editCtx] = (await db.execute(sql`
        SELECT d.id AS doc_id, d.title AS doc_title,
               v.id AS version_id, v.version_number::int AS version_number
        FROM threads t
        INNER JOIN versions v ON v.id = t.version_id
        INNER JOIN documents d ON d.id = v.document_id
        WHERE t.id = ${existing.threadId}
        LIMIT 1
      `)) as unknown as Array<{
        doc_id: string;
        doc_title: string;
        version_id: string;
        version_number: number;
      }>;

      if (editCtx) {
        void deps.notifier
          .notifyComment({
            doc: { id: editCtx.doc_id, title: editCtx.doc_title },
            version: { id: editCtx.version_id, versionNumber: editCtx.version_number },
            thread: { id: existing.threadId },
            comment: { id: commentId, body: validation.body, createdAt: existing.createdAt },
            mentionedUserIds: newlyAdded,
            participantUserIds: [],   // edits never re-notify participants
            uploaderUserId: null,
            actorUserId: user.id,
          })
          .catch((err) => logger.error({ err, commentId }, 'notifier failed (edit)'));
      }
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

  app.delete('/api/comments/:commentId', async (c) => {
    const commentId = c.req.param('commentId');

    const live = await ensureLiveDocumentForComment(commentId);
    if (!live.ok) return c.json({ error: 'not_found' }, 404);

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
