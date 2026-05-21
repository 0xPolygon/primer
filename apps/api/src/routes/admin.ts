import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import type { AdminStatsResponse } from '@primer/shared';

export function registerAdminRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/admin/stats', async (c) => {
    const body: AdminStatsResponse = {
      users:         { total: 0, last7d: 0 },
      documents:     { total: 0, last7d: 0 },
      versions:      { total: 0, last7d: 0 },
      threads:       { total: 0, last7d: 0 },
      comments:      { total: 0, last7d: 0 },
      documentViews: { total: 0, last7d: 0 },
    };
    return c.json(body, 200);
  });
}
