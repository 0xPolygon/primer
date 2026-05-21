import type { Hono } from 'hono';
import { count, isNull, gt, and, sql } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import type { AdminStatsResponse } from '@primer/shared';
import { db } from '../db/client.ts';
import { users, documents, versions, threads, comments, documentViews } from '@primer/shared/schema';

export function registerAdminRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/admin/stats', async (c) => {
    const since = sql<Date>`now() - interval '7 days'`;

    const [
      usersTotal,
      usersLast,
      documentsTotal,
      documentsLast,
      versionsTotal,
      versionsLast,
      threadsTotal,
      threadsLast,
      commentsTotal,
      commentsLast,
      viewsTotal,
      viewsLast,
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

    const body: AdminStatsResponse = {
      users:         { total: usersTotal[0].c,     last7d: usersLast[0].c },
      documents:     { total: documentsTotal[0].c, last7d: documentsLast[0].c },
      versions:      { total: versionsTotal[0].c,  last7d: versionsLast[0].c },
      threads:       { total: threadsTotal[0].c,   last7d: threadsLast[0].c },
      comments:      { total: commentsTotal[0].c,  last7d: commentsLast[0].c },
      documentViews: { total: viewsTotal[0].c,     last7d: viewsLast[0].c },
    };
    return c.json(body, 200);
  });
}
