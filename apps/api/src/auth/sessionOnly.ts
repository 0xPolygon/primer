import type { MiddlewareHandler } from 'hono';
import type { AppVariables } from '../app.ts';

/**
 * Route guard for operations that must be performed by a human in a browser
 * session, never by an API token (PAT or OAuth bearer).
 *
 * Minting credentials and approving device logins are the obvious cases: a
 * bearer that can call them can turn itself into a fresh, longer-lived
 * credential — returned in the response body (POST /api/tokens) or handed to
 * whoever started a device login (POST /api/device/approve). Agents hold
 * bearers whose requests can be steered by untrusted content, so these
 * routes refuse bearer auth outright. Revoking a token stays bearer-callable:
 * it only ever reduces access (the local MCP server's logout relies on it).
 */
export const sessionOnly: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
  if (c.get('authMethod') === 'bearer') {
    return c.json(
      { error: 'session_required', message: 'This operation requires a signed-in browser session.' },
      403,
    );
  }
  return next();
};
