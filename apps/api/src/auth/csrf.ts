import type { MiddlewareHandler } from 'hono';

export const CSRF_HEADER = 'x-primer-csrf';

const MUTATING_METHODS = new Set(['POST', 'PATCH', 'PUT', 'DELETE']);

// CSRF PROTECTION NOTE:
// This middleware uses the "custom request header" technique: any request
// carrying `x-primer-csrf: 1` is considered non-CSRF. Browsers block
// cross-origin scripts from sending custom headers on credentialed requests,
// so a third-party origin cannot forge this header against our cookie-auth'd
// API.
//
// This is ONLY secure because Primer has NO permissive CORS policy. If you
// later add `Access-Control-Allow-Origin: *` (or any wildcard CORS with
// credentials), this protection collapses — cross-origin scripts could send
// the header and forge any state-changing request. Before adding CORS,
// upgrade this to the Double Submit Cookie pattern (random per-session
// secret, not a static '1').
export const csrfMiddleware: MiddlewareHandler = async (c, next) => {
  if (!MUTATING_METHODS.has(c.req.method)) return next();
  if (c.req.header(CSRF_HEADER) === '1') return next();
  return c.json({ error: 'csrf', message: 'Missing X-Primer-Csrf header' }, 403);
};
