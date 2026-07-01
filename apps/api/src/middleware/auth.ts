import type { MiddlewareHandler } from 'hono';
import type { AppVariables } from '../app.ts';
import type { UserResolver } from '../auth/resolver.ts';

export const PUBLIC_PATHS = new Set([
  '/api/health',
  '/auth/login',
  '/auth/callback',
  '/api/device/authorize',
  '/api/device/token',
  '/oauth/register',
  '/oauth/authorize',
  '/oauth/consent',
  '/oauth/token',
  '/oauth/revoke',
]);

function isApiPath(path: string): boolean {
  return path.startsWith('/api/');
}

// The companion script is loaded as a subresource by the sandboxed artifact
// iframe (`sandbox="allow-scripts allow-forms allow-modals allow-downloads"`,
// no allow-same-origin).
// Sandboxed iframes make subresource requests as cross-site, which strips
// SameSite=Lax cookies — so the companion fetch arrives without a session.
// The script is static, identical for every viewer, and contains no secrets
// (text-anchoring + selection-capture protocol), so it's safe to serve
// without auth.
function isPublicCompanionAsset(path: string): boolean {
  return path.startsWith('/companion/');
}

function isPublicWellKnown(path: string): boolean {
  return path.startsWith('/.well-known/oauth-');
}

export function authMiddleware(
  resolver: UserResolver
): MiddlewareHandler<{ Variables: AppVariables }> {
  return async (c, next) => {
    const path = c.req.path;
    if (PUBLIC_PATHS.has(path) || isPublicCompanionAsset(path) || isPublicWellKnown(path)) return next();

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
