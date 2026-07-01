import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { handleMcpRequest, type McpTransportDeps } from './transport.ts';

export function registerMcpRoute(
  app: Hono<{ Variables: AppVariables }>,
  deps: McpTransportDeps & { issuer: string },
): void {
  app.on('POST', '/mcp', async (c) => {
    // The auth middleware runs first. When the user isn't set, respond with
    // 401 + WWW-Authenticate metadata so Claude Web knows where to refresh.
    if (!c.get('user')) {
      const resourceMetadata = `${deps.issuer}/.well-known/oauth-protected-resource`;
      c.header(
        'www-authenticate',
        `Bearer resource_metadata="${resourceMetadata}"`,
      );
      return c.json({ error: 'unauthenticated' }, 401);
    }
    return handleMcpRequest(c, deps);
  });
}
