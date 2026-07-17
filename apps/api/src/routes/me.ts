import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import type { MeResponse } from '@primer/shared';
import { isAdmin } from '../auth/admin.ts';

export function registerMeRoute(
  app: Hono<{ Variables: AppVariables }>,
  opts: { adminEmails: string[] },
): void {
  app.get('/api/me', (c) => {
    const u = c.get('user');
    const body: MeResponse = {
      id: u.id,
      email: u.email,
      displayName: u.displayName,
      isAdmin: isAdmin(u, opts.adminEmails),
    };
    return c.json(body, 200);
  });
}
