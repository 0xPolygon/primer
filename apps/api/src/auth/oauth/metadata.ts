import type { Hono } from 'hono';

export interface OAuthMetadataOptions {
  issuer: string; // e.g. https://primer-polygon.up.railway.app
}

export function registerOAuthMetadataRoutes(app: Hono, opts: OAuthMetadataOptions): void {
  const { issuer } = opts;

  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer,
      authorization_endpoint: `${issuer}/oauth/authorize`,
      token_endpoint: `${issuer}/oauth/token`,
      registration_endpoint: `${issuer}/oauth/register`,
      revocation_endpoint: `${issuer}/oauth/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['primer'],
    }),
  );

  app.get('/.well-known/oauth-protected-resource', (c) =>
    c.json({
      resource: `${issuer}/mcp`,
      authorization_servers: [issuer],
      bearer_methods_supported: ['header'],
      scopes_supported: ['primer'],
    }),
  );
}
