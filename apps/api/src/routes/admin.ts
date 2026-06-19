import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import type { AdminStatsResponse } from '@primer/shared';
import {
  buildTotals,
  buildAdoption,
  buildEngagement,
  buildOperational,
} from '../services/adminStats.ts';

export function registerAdminRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/admin/stats', async (c) => {
    const [totals, adoption, engagement, operational] = await Promise.all([
      buildTotals(),
      buildAdoption(),
      buildEngagement(),
      buildOperational(),
    ]);

    const body: AdminStatsResponse = {
      ...totals,
      rangeDays: 30,
      adoption,
      engagement,
      operational,
    };
    return c.json(body, 200);
  });
}
