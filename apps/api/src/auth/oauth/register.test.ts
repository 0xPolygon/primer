import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { db } from '../../db/client.ts';
import { oauthClients } from '@primer/shared/schema';
import { registerOAuthRegistrationRoute } from './register.ts';

async function makeApp(): Promise<Hono> {
  const app = new Hono();
  registerOAuthRegistrationRoute(app);
  return app;
}

beforeEach(async () => {
  await db.delete(oauthClients);
});

describe('POST /oauth/register', () => {
  it('accepts a valid registration', async () => {
    const app = await makeApp();
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Claude',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.client_id).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(body.client_name).toBe('Claude');
    expect(body.token_endpoint_auth_method).toBe('none');
  });

  it('rejects an unlisted redirect_uri', async () => {
    const app = await makeApp();
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Rogue',
        redirect_uris: ['https://evil.example.com/cb'],
        grant_types: ['authorization_code', 'refresh_token'],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_redirect_uri');
  });

  it('rejects missing fields', async () => {
    const app = await makeApp();
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_client_metadata');
  });

  it('rejects a client requesting unsupported grant types', async () => {
    const app = await makeApp();
    const res = await app.request('/oauth/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'X',
        redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
        grant_types: ['client_credentials'],
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_client_metadata');
  });
});
