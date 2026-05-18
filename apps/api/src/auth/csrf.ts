import type { MiddlewareHandler } from 'hono';

export const CSRF_HEADER = 'x-primer-csrf';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

export const csrfMiddleware: MiddlewareHandler = async (c, next) => {
  if (!MUTATING_METHODS.has(c.req.method)) return next();
  if (c.req.header(CSRF_HEADER) === '1') return next();
  return c.json({ error: 'csrf', message: 'Missing X-Primer-Csrf header' }, 403);
};
