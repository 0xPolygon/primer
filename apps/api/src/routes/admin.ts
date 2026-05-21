import type { Hono } from 'hono';
import { count } from 'drizzle-orm';
import type { AppVariables } from '../app.ts';
import type { AdminStatsResponse } from '@primer/shared';
import { db } from '../db/client.ts';
import { users, documents, versions, threads, comments, documentViews } from '@primer/shared/schema';

export function registerAdminRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/admin/stats', async (c) => {
    const [
      usersTotal,
      documentsTotal,
      versionsTotal,
      threadsTotal,
      commentsTotal,
      viewsTotal,
    ] = await Promise.all([
      db.select({ c: count() }).from(users),
      db.select({ c: count() }).from(documents),
      db.select({ c: count() }).from(versions),
      db.select({ c: count() }).from(threads),
      db.select({ c: count() }).from(comments),
      db.select({ c: count() }).from(documentViews),
    ]);

    const body: AdminStatsResponse = {
      users:         { total: usersTotal[0].c,     last7d: 0 },
      documents:     { total: documentsTotal[0].c, last7d: 0 },
      versions:      { total: versionsTotal[0].c,  last7d: 0 },
      threads:       { total: threadsTotal[0].c,   last7d: 0 },
      comments:      { total: commentsTotal[0].c,  last7d: 0 },
      documentViews: { total: viewsTotal[0].c,     last7d: 0 },
    };
    return c.json(body, 200);
  });
}
