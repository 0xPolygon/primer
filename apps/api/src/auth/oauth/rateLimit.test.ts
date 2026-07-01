import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import { makeRateLimiter, oauthRateLimitMiddleware } from './rateLimit.ts';

describe('makeRateLimiter', () => {
  afterEach(() => vi.useRealTimers());

  it('allows requests within capacity', () => {
    const check = makeRateLimiter({ capacity: 3, refillPerSecond: 0 });
    expect(check('a').allowed).toBe(true);
    expect(check('a').allowed).toBe(true);
    expect(check('a').allowed).toBe(true);
    expect(check('a').allowed).toBe(false);
  });

  it('isolates buckets by key', () => {
    const check = makeRateLimiter({ capacity: 1, refillPerSecond: 0 });
    expect(check('a').allowed).toBe(true);
    expect(check('a').allowed).toBe(false);
    expect(check('b').allowed).toBe(true);
  });

  it('refills over time', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const check = makeRateLimiter({ capacity: 2, refillPerSecond: 1 });
    expect(check('a').allowed).toBe(true);
    expect(check('a').allowed).toBe(true);
    expect(check('a').allowed).toBe(false);
    vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
    expect(check('a').allowed).toBe(true);
  });

  it('reports retryAfterSeconds when denied', () => {
    const check = makeRateLimiter({ capacity: 1, refillPerSecond: 0.5 });
    check('a'); // consume
    const denied = check('a');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe('oauthRateLimitMiddleware', () => {
  it('returns 429 with Retry-After when the bucket is empty', async () => {
    const app = new Hono();
    app.use('*', oauthRateLimitMiddleware({ capacity: 1, refillPerSecond: 0 }));
    app.get('/x', (c) => c.text('ok'));

    const first = await app.request('/x', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(first.status).toBe(200);

    const second = await app.request('/x', { headers: { 'x-forwarded-for': '1.2.3.4' } });
    expect(second.status).toBe(429);
    expect(second.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});
