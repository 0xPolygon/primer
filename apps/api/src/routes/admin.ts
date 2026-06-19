import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import type { AdminStatsResponse } from '@primer/shared';
import { buildTotals } from '../services/adminStats.ts';

export function registerAdminRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/admin/stats', async (c) => {
    const totals = await buildTotals();

    const body: AdminStatsResponse = {
      ...totals,
      rangeDays: 30,
      adoption: {
        createdPerDay: [],
        activeUsersPerDay: [],
        cumulativeUsers: [],
      },
      engagement: {
        topDocumentsByViewers: [],
        topCommenters: [],
        viewersPerDocHistogram: [],
      },
      operational: {
        storageBytesPerDay: [],
        threadsOpenedVsResolved: [],
        openThreadsAgingOver14d: { count: 0, sparkline: [] },
      },
    };
    return c.json(body, 200);
  });
}
