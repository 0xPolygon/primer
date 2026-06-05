import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { csrfMiddleware, CSRF_HEADER } from './csrf.ts';
import type { AppVariables } from '../app.ts';

function makeApp() {
  const app = new Hono();
  app.use('*', csrfMiddleware);
  app.get('/api/data', (c) => c.text('ok'));
  app.post('/api/data', (c) => c.text('posted'));
  app.patch('/api/data', (c) => c.text('patched'));
  app.delete('/api/data', (c) => c.text('deleted'));
  app.post('/auth/logout', (c) => c.text('logged out'));
  app.get('/auth/login', (c) => c.text('login'));
  return app;
}

// Variant that allows setting authMethod from a test header so we can
// exercise the bearer-exemption branch without standing up the full auth
// middleware.
function makeAppWithAuthMethod() {
  const app = new Hono<{ Variables: AppVariables }>();
  app.use('*', async (c, next) => {
    const m = c.req.header('x-test-auth-method');
    if (m === 'bearer' || m === 'cookie' || m === 'mock') {
      c.set('authMethod', m);
    }
    await next();
  });
  app.use('*', csrfMiddleware);
  app.post('/api/data', (c) => c.text('posted'));
  app.patch('/api/data', (c) => c.text('patched'));
  app.delete('/api/data', (c) => c.text('deleted'));
  app.get('/api/data', (c) => c.text('ok'));
  app.post('/api/device/authorize', (c) => c.text('authorized'));
  app.post('/api/device/token', (c) => c.text('token'));
  app.post('/auth/login', (c) => c.text('login posted'));
  app.post('/api/health', (c) => c.text('health'));
  app.post('/auth/callback', (c) => c.text('callback'));
  return app;
}

describe('csrfMiddleware', () => {
  it('allows GET without header', async () => {
    const res = await makeApp().request('/api/data');
    expect(res.status).toBe(200);
  });

  it('allows POST with header', async () => {
    const res = await makeApp().request('/api/data', {
      method: 'POST',
      headers: { [CSRF_HEADER]: '1' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects POST without header (403)', async () => {
    const res = await makeApp().request('/api/data', { method: 'POST' });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('csrf');
  });

  it('rejects PATCH and DELETE without header', async () => {
    const a = makeApp();
    expect((await a.request('/api/data', { method: 'PATCH' })).status).toBe(403);
    expect((await a.request('/api/data', { method: 'DELETE' })).status).toBe(403);
  });

  it('rejects POST /auth/logout without header', async () => {
    const res = await makeApp().request('/auth/logout', { method: 'POST' });
    expect(res.status).toBe(403);
  });

  it('allows GET /auth/login without header', async () => {
    const res = await makeApp().request('/auth/login');
    expect(res.status).toBe(200);
  });

  it('allows POST with authMethod=bearer without CSRF header', async () => {
    const res = await makeAppWithAuthMethod().request('/api/data', {
      method: 'POST',
      headers: { 'x-test-auth-method': 'bearer' },
    });
    expect(res.status).toBe(200);
  });

  it('rejects POST with authMethod=cookie without CSRF header (no bearer override widening)', async () => {
    const res = await makeAppWithAuthMethod().request('/api/data', {
      method: 'POST',
      headers: { 'x-test-auth-method': 'cookie' },
    });
    expect(res.status).toBe(403);
  });

  it('rejects POST with no authMethod set without CSRF header (existing behavior preserved)', async () => {
    const res = await makeAppWithAuthMethod().request('/api/data', {
      method: 'POST',
    });
    expect(res.status).toBe(403);
  });

  it('allows POST /api/device/authorize without CSRF header (public path)', async () => {
    const res = await makeAppWithAuthMethod().request('/api/device/authorize', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
  });

  it('allows POST /api/device/token without CSRF header (public path)', async () => {
    const res = await makeAppWithAuthMethod().request('/api/device/token', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
  });

  it('allows POST /auth/login without CSRF header (public path regression)', async () => {
    const res = await makeAppWithAuthMethod().request('/auth/login', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
  });

  it('allows POST /api/health without CSRF header (public path)', async () => {
    const res = await makeAppWithAuthMethod().request('/api/health', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
  });

  it('allows POST /auth/callback without CSRF header (public path)', async () => {
    const res = await makeAppWithAuthMethod().request('/auth/callback', {
      method: 'POST',
    });
    expect(res.status).toBe(200);
  });

  it('allows GET to any path without CSRF header (sanity: method guard still wins)', async () => {
    const res = await makeAppWithAuthMethod().request('/api/data');
    expect(res.status).toBe(200);
  });
});
