import type { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { handleMcpRequest, type McpTransportDeps } from './transport.ts';

export function registerMcpRoute(
  app: Hono<{ Variables: AppVariables }>,
  deps: McpTransportDeps,
): void {
  app.on('POST', '/mcp', async (c) => {
    // authMiddleware owns the 401 + WWW-Authenticate branch for /mcp. If we
    // reach this handler, the user is authenticated.
    return handleMcpRequest(c, deps);
  });
}
