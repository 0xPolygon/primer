import type { MiddlewareHandler } from 'hono';
import type { AppVariables } from '../app.ts';
import type { UserResolver } from '../auth/resolver.ts';

const PUBLIC_PATHS = new Set(['/api/health', '/auth/login', '/auth/callback']);

function isApiPath(path: string): boolean {
  return path.startsWith('/api/');
}

export function authMiddleware(
  resolver: UserResolver
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const path = c.req.path;
    if (PUBLIC_PATHS.has(path)) return next();

    const user = await resolver(c);
    if (user) {
      c.set('user', user);
      return next();
    }

    if (isApiPath(path) || path.startsWith('/auth/')) {
      return c.json({ error: 'unauthenticated' }, 401);
    }
    const returnTo = encodeURIComponent(path);
    return c.redirect(`/auth/login?return_to=${returnTo}`, 302);
  };
}
