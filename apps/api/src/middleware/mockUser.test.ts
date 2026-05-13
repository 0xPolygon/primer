import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { mockUserMiddleware, MOCK_USER } from './mockUser.ts';
import type { AppVariables } from '../app.ts';

describe('mockUserMiddleware', () => {
  it('sets the mock user on the request context', async () => {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use('*', mockUserMiddleware);
    app.get('/whoami', (c) => c.json(c.get('user')));

    const res = await app.request('/whoami');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MOCK_USER);
  });
});
