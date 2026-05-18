import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { csrfMiddleware, CSRF_HEADER } from './csrf.ts';

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
});
