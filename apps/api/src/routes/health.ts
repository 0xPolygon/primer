import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { sql } from '../db/client.ts';
import { logger } from '../logger.ts';

const READY_TIMEOUT_MS = 2_000;

export type DatabaseCheck = () => Promise<void>;

async function checkDatabase(): Promise<void> {
  await sql`select 1`;
}

// /api/health is cheap liveness: the process is up. /api/ready is readiness:
// it can reach the database. On Railway, health alone kept reporting ok after
// the DB password was rotated and every real request was failing.
export function registerHealthRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: { checkDatabase?: DatabaseCheck } = {},
): void {
  const check = deps.checkDatabase ?? checkDatabase;

  app.get('/api/health', (c) => c.json({ ok: true }));

  app.get('/api/ready', async (c) => {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        check(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('database check timed out')), READY_TIMEOUT_MS);
        }),
      ]);
      return c.json({ ok: true });
    } catch (err) {
      logger.warn({ err }, 'readiness check failed');
      return c.json({ ok: false, error: 'database_unavailable' }, 503);
    } finally {
      clearTimeout(timer);
    }
  });
}
