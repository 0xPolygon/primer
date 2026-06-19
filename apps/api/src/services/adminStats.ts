import { count, isNull, gt, and, sql } from 'drizzle-orm';
import type {
  AdminStatsBucket,
} from '@primer/shared';
import { db as defaultDb, type Db } from '../db/client.ts';
import {
  users,
  documents,
  versions,
  threads,
  comments,
  documentViews,
} from '@primer/shared/schema';

export interface AdminTotals {
  users: AdminStatsBucket;
  documents: AdminStatsBucket;
  versions: AdminStatsBucket;
  threads: AdminStatsBucket;
  comments: AdminStatsBucket;
  documentViews: AdminStatsBucket;
}

export async function buildTotals(db: Db = defaultDb): Promise<AdminTotals> {
  const since = sql<Date>`now() - interval '7 days'`;

  const [
    usersTotal,     usersLast,
    documentsTotal, documentsLast,
    versionsTotal,  versionsLast,
    threadsTotal,   threadsLast,
    commentsTotal,  commentsLast,
    viewsTotal,     viewsLast,
  ] = await Promise.all([
    db.select({ c: count() }).from(users),
    db.select({ c: count() }).from(users).where(gt(users.createdAt, since)),

    db.select({ c: count() }).from(documents).where(isNull(documents.deletedAt)),
    db.select({ c: count() }).from(documents)
      .where(and(isNull(documents.deletedAt), gt(documents.createdAt, since))),

    db.select({ c: count() }).from(versions),
    db.select({ c: count() }).from(versions).where(gt(versions.createdAt, since)),

    db.select({ c: count() }).from(threads),
    db.select({ c: count() }).from(threads).where(gt(threads.createdAt, since)),

    db.select({ c: count() }).from(comments).where(isNull(comments.deletedAt)),
    db.select({ c: count() }).from(comments)
      .where(and(isNull(comments.deletedAt), gt(comments.createdAt, since))),

    db.select({ c: count() }).from(documentViews),
    db.select({ c: count() }).from(documentViews).where(gt(documentViews.viewedAt, since)),
  ]);

  return {
    users:         { total: usersTotal[0].c,     last7d: usersLast[0].c },
    documents:     { total: documentsTotal[0].c, last7d: documentsLast[0].c },
    versions:      { total: versionsTotal[0].c,  last7d: versionsLast[0].c },
    threads:       { total: threadsTotal[0].c,   last7d: threadsLast[0].c },
    comments:      { total: commentsTotal[0].c,  last7d: commentsLast[0].c },
    documentViews: { total: viewsTotal[0].c,     last7d: viewsLast[0].c },
  };
}
