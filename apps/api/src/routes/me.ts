import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import type { UserDTO } from '@primer/shared';

export function registerMeRoute(app: Hono<{ Variables: AppVariables }>): void {
  app.get('/api/me', (c) => {
    const u = c.get('user');
    const body: UserDTO = { id: u.id, email: u.email, displayName: u.displayName };
    return c.json(body, 200);
  });
}
