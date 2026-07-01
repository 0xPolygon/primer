import type { Hono } from 'hono';
import { createClient, isRedirectUriAllowed } from './clients.ts';

const ALLOWED_GRANT_TYPES = new Set(['authorization_code', 'refresh_token']);

export function registerOAuthRegistrationRoute(app: Hono): void {
  app.post('/oauth/register', async (c) => {
    let body: Record<string, unknown> = {};
    try {
      const raw = await c.req.json();
      if (raw && typeof raw === 'object') body = raw as Record<string, unknown>;
    } catch {
      return c.json({ error: 'invalid_client_metadata', error_description: 'body must be JSON' }, 400);
    }

    const clientName = typeof body.client_name === 'string' ? body.client_name.trim() : '';
    const redirectUris = Array.isArray(body.redirect_uris)
      ? body.redirect_uris.filter((s): s is string => typeof s === 'string')
      : [];
    const grantTypes = Array.isArray(body.grant_types)
      ? body.grant_types.filter((s): s is string => typeof s === 'string')
      : ['authorization_code', 'refresh_token'];

    if (clientName.length === 0 || redirectUris.length === 0) {
      return c.json({ error: 'invalid_client_metadata', error_description: 'client_name and redirect_uris required' }, 400);
    }
    for (const uri of redirectUris) {
      if (!isRedirectUriAllowed(uri)) {
        return c.json({ error: 'invalid_redirect_uri', error_description: `redirect_uri not allowed: ${uri}` }, 400);
      }
    }
    for (const gt of grantTypes) {
      if (!ALLOWED_GRANT_TYPES.has(gt)) {
        return c.json({ error: 'invalid_client_metadata', error_description: `grant_type not supported: ${gt}` }, 400);
      }
    }

    const client = await createClient({ clientName, redirectUris, grantTypes });

    const createdAtTime = typeof client.createdAt === 'string'
      ? new Date(client.createdAt).getTime()
      : client.createdAt.getTime();

    return c.json(
      {
        client_id: client.clientId,
        client_name: client.clientName,
        redirect_uris: client.redirectUris,
        grant_types: client.grantTypes,
        token_endpoint_auth_method: client.tokenEndpointAuthMethod,
        client_id_issued_at: Math.floor(createdAtTime / 1000),
      },
      201,
    );
  });
}
