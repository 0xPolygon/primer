import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import type { MeResponse } from '@polygonlabs/primer-api-types';
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
      isAdmin: u.kind === 'person' && isAdmin(u, opts.adminEmails),
      kind: u.kind,
      viaUserId: u.viaUserId,
    };
    return c.json(body, 200);
  });
}
