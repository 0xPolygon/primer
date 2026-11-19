import { eq, inArray, sql, type SQL } from 'drizzle-orm';
import type { CommentDTO, ThreadAnchor, ThreadDTO } from '@polygonlabs/primer-api-types';
import { db } from '../db/client.ts';
import { commentReactions, comments, threadPlacements, threads, users, versions } from '../db/schema.ts';
import { actorName, authorColumns } from './actors.ts';

/** Which threads to load: those placed on one version (with their anchor
 *  there), every thread of a document, the live threads of a document, or
 *  one thread. */
export type ThreadFilter =
  | { placedOn: string }
  | { documentId: string }
  | { liveOf: string }
  | { threadId: string };

interface ThreadRow {
  id: string;
  versionId: string | null;
  versionNumber: number | null;
  anchor: unknown;
  placementAnchor: unknown;
  orphanedAt: Date | null;
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
  authorKind: 'person' | 'agent';
  authorVia: string | null;
  body: string;
  mentions: string[];
  createdAt: Date;
  updatedAt: Date | null;
  deletedAt: Date | null;
}

/**
 * Threads with their comments and reactions as ThreadDTOs: the one reader
 * behind the REST thread routes and the MCP comment tools.
 */
export async function loadThreads(filter: ThreadFilter): Promise<ThreadDTO[]> {
  const columns = {
    id: threads.id,
    versionId: threads.versionId,
    versionNumber: versions.versionNumber,
    anchor: threads.anchor,
    orphanedAt: threads.orphanedAt,
    resolvedAt: threads.resolvedAt,
    resolvedBy: threads.resolvedBy,
    resolvedByDisplayName: actorName,
    createdAt: threads.createdAt,
  };
  let threadRows: ThreadRow[];
  if ('placedOn' in filter) {
    threadRows = (await db
      .select({ ...columns, placementAnchor: threadPlacements.anchor })
      .from(threadPlacements)
      .innerJoin(threads, eq(threads.id, threadPlacements.threadId))
      .leftJoin(versions, eq(versions.id, threads.versionId))
      .leftJoin(users, eq(users.id, threads.resolvedBy))
      .where(eq(threadPlacements.versionId, filter.placedOn))
      .orderBy(threads.createdAt)) as ThreadRow[];
  } else {
    const where: SQL =
      'documentId' in filter
        ? eq(threads.documentId, filter.documentId)
        : 'liveOf' in filter
          ? sql`${threads.documentId} = ${filter.liveOf} AND ${threads.versionId} IS NULL`
          : eq(threads.id, filter.threadId);
    threadRows = (await db
      .select({ ...columns, placementAnchor: threads.anchor })
      .from(threads)
      .leftJoin(versions, eq(versions.id, threads.versionId))
      .leftJoin(users, eq(users.id, threads.resolvedBy))
      .where(where)
      .orderBy(threads.createdAt)) as ThreadRow[];
  }
  if (threadRows.length === 0) return [];

  const commentRows = (await db
    .select({
      id: comments.id,
      threadId: comments.threadId,
      authorId: comments.authorId,
      ...authorColumns,
      body: comments.body,
      mentions: comments.mentions,
      createdAt: comments.createdAt,
      updatedAt: comments.updatedAt,
      deletedAt: comments.deletedAt,
    })
    .from(comments)
    .innerJoin(users, eq(users.id, comments.authorId))
    .where(inArray(comments.threadId, threadRows.map((t) => t.id)))
    .orderBy(comments.createdAt)) as CommentRow[];

  const reactions = await loadReactions(commentRows.map((c) => c.id));
  const byThread = new Map<string, CommentDTO[]>();
  for (const row of commentRows) {
    const list = byThread.get(row.threadId) ?? [];
    list.push(commentToDTO(row, reactions.get(row.id) ?? []));
    byThread.set(row.threadId, list);
  }

  return threadRows.map((t) => ({
    id: t.id,
    versionId: t.versionId,
    versionNumber: t.versionNumber,
    anchor: (t.placementAnchor ?? t.anchor) as ThreadAnchor,
    contextChanged: t.placementAnchor === null,
    orphaned: t.orphanedAt !== null,
    resolvedAt: t.resolvedAt?.toISOString() ?? null,
    resolvedBy: t.resolvedBy,
    resolvedByDisplayName: t.resolvedByDisplayName,
    createdAt: t.createdAt.toISOString(),
    comments: byThread.get(t.id) ?? [],
  }));
}

export async function loadThread(threadId: string): Promise<ThreadDTO | null> {
  const [dto] = await loadThreads({ threadId });
  return dto ?? null;
}

async function loadReactions(commentIds: string[]): Promise<Map<string, CommentDTO['reactions']>> {
  const out = new Map<string, CommentDTO['reactions']>();
  if (commentIds.length === 0) return out;
  const rows = await db
    .select({ commentId: commentReactions.commentId, userId: commentReactions.userId, emoji: commentReactions.emoji })
    .from(commentReactions)
    .where(inArray(commentReactions.commentId, commentIds))
    .orderBy(commentReactions.createdAt);
  for (const row of rows) {
    const list = out.get(row.commentId) ?? [];
    const entry = list.find((r) => r.emoji === row.emoji);
    if (entry) entry.userIds.push(row.userId);
    else list.push({ emoji: row.emoji, userIds: [row.userId] });
    out.set(row.commentId, list);
  }
  return out;
}

export function commentToDTO(row: CommentRow, reactions: CommentDTO['reactions'] = []): CommentDTO {
  return {
    id: row.id,
    threadId: row.threadId,
    authorId: row.authorId,
    authorDisplayName: row.authorDisplayName,
    authorKind: row.authorKind,
    authorVia: row.authorVia,
    body: row.deletedAt !== null ? '' : row.body,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    mentions: row.mentions,
    reactions,
  };
}
