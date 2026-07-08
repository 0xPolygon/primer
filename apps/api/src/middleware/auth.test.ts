import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import type { AppVariables } from '../app.ts';
import { authMiddleware } from './auth.ts';
import { MOCK_USER, type UserResolver } from '../auth/resolver.ts';

function makeApp(resolver: UserResolver) {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', authMiddleware(resolver));
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/data', (c) => c.json({ user: c.get('user').id }));
  app.get('/d/123', (c) => c.text(`page for ${c.get('user').id}`));
  return app;
}

describe('authMiddleware', () => {
  it('always allows GET /api/health, no user required', async () => {
    const app = makeApp(async () => null);
    const res = await app.request('/api/health');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('returns 401 JSON when no user on /api/*', async () => {
    const app = makeApp(async () => null);
    const res = await app.request('/api/data');
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toBe('unauthenticated');
  });

  it('returns 302 to /auth/login on a page route when no user', async () => {
    const app = makeApp(async () => null);
    const res = await app.request('/d/123');
    expect(res.status).toBe(302);
    const location = res.headers.get('location');
    expect(location).toBe('/auth/login?return_to=%2Fd%2F123');
  });

  it('sets c.var.user when resolver returns a user', async () => {
    const app = makeApp(async () => MOCK_USER);
    const res = await app.request('/api/data');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ user: 'mock-user-1' });
  });

  it('bypasses /auth/login and /auth/callback for unauthenticated users', async () => {
    const app = makeApp(async () => null);
    app.get('/auth/login', (c) => c.text('login start'));
    app.get('/auth/callback', (c) => c.text('callback'));
    expect((await app.request('/auth/login')).status).toBe(200);
    expect((await app.request('/auth/callback')).status).toBe(200);
  });

  it('requires auth on POST /auth/logout', async () => {
    const app = makeApp(async () => null);
    app.post('/auth/logout', (c) => c.text('ok'));
    const res = await app.request('/auth/logout', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('bypasses /companion/* for unauthenticated requests (sandboxed iframes have no cookies)', async () => {
    const app = makeApp(async () => null);
    app.get('/companion/v1.js', (c) => c.text('// companion'));
    const res = await app.request('/companion/v1.js');
    expect(res.status).toBe(200);
  });

  it('bypasses /assets/* and /favicon.svg for unauthenticated requests (SPA bundle on /share pages)', async () => {
    const app = makeApp(async () => null);
    app.get('/assets/index-abc123.js', (c) => c.text('// bundle'));
    app.get('/favicon.svg', (c) => c.text('<svg/>'));
    // Regression: these previously 302'd to /auth/login, which redirected the
    // browser's subresource requests to Okta and died on CORS for external
    // viewers loading /share/:token in production.
    expect((await app.request('/assets/index-abc123.js')).status).toBe(200);
    expect((await app.request('/favicon.svg')).status).toBe(200);
  });

  it('does not loosen sibling paths like /assetsfoo or /faviconx', async () => {
    const app = makeApp(async () => null);
    expect((await app.request('/assetsfoo/x.js')).status).toBe(302);
    expect((await app.request('/favicon.svg.bak')).status).toBe(302);
  });
});
