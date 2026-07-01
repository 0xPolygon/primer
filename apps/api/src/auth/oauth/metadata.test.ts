import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { registerOAuthMetadataRoutes } from './metadata.ts';

const ISSUER = 'https://primer.example.com';

function makeApp(): Hono {
  const app = new Hono();
  registerOAuthMetadataRoutes(app, { issuer: ISSUER });
  return app;
}

describe('GET /.well-known/oauth-authorization-server', () => {
  it('advertises the required endpoints', async () => {
    const app = makeApp();
    const res = await app.request('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.issuer).toBe(ISSUER);
    expect(body.authorization_endpoint).toBe(`${ISSUER}/oauth/authorize`);
    expect(body.token_endpoint).toBe(`${ISSUER}/oauth/token`);
    expect(body.registration_endpoint).toBe(`${ISSUER}/oauth/register`);
    expect(body.revocation_endpoint).toBe(`${ISSUER}/oauth/revoke`);
    expect(body.response_types_supported).toContain('code');
    expect(body.grant_types_supported).toEqual(
      expect.arrayContaining(['authorization_code', 'refresh_token']),
    );
    expect(body.code_challenge_methods_supported).toEqual(['S256']);
    expect(body.token_endpoint_auth_methods_supported).toEqual(['none']);
    expect(body.scopes_supported).toContain('primer');
  });
});

describe('GET /.well-known/oauth-protected-resource', () => {
  it('advertises the resource and its authorization server', async () => {
    const app = makeApp();
    const res = await app.request('/.well-known/oauth-protected-resource');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resource).toBe(`${ISSUER}/mcp`);
    expect(body.authorization_servers).toEqual([ISSUER]);
    expect(body.bearer_methods_supported).toEqual(['header']);
    expect(body.scopes_supported).toContain('primer');
  });
});
