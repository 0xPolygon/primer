import type { MiddlewareHandler } from 'hono';
import type { AppVariables } from '../app.ts';

export const MOCK_USER: AppVariables['user'] = {
  id: 'mock-user-1',
  email: 'mock@polygon.technology',
  displayName: 'Mock User',
};

export const mockUserMiddleware: MiddlewareHandler<{ Variables: AppVariables }> = async (
  c,
  next
) => {
  c.set('user', MOCK_USER);
  await next();
};
