import type { MiddlewareHandler } from 'hono';

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export interface RateLimitConfig {
  capacity: number;
  refillPerSecond: number;
}

export function makeRateLimiter(cfg: RateLimitConfig) {
  const buckets = new Map<string, Bucket>();

  return function check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = Date.now();
    const bucket = buckets.get(key) ?? { tokens: cfg.capacity, updatedAt: now };

    // Refill.
    const elapsedSec = (now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(cfg.capacity, bucket.tokens + elapsedSec * cfg.refillPerSecond);
    bucket.updatedAt = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      buckets.set(key, bucket);
      return { allowed: true, retryAfterSeconds: 0 };
    }

    buckets.set(key, bucket);
    const deficit = 1 - bucket.tokens;
    const retryAfterSeconds = cfg.refillPerSecond > 0
      ? Math.ceil(deficit / cfg.refillPerSecond)
      : Number.POSITIVE_INFINITY;
    return { allowed: false, retryAfterSeconds };
  };
}

function extractIp(header: string | undefined | null): string {
  if (!header) return 'unknown';
  const parts = header.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  return parts.length > 0 ? parts[parts.length - 1] : 'unknown';
}

export function oauthRateLimitMiddleware(cfg: RateLimitConfig): MiddlewareHandler {
  const check = makeRateLimiter(cfg);
  return async (c, next) => {
    const ip = extractIp(c.req.header('x-forwarded-for'));
    const key = `${ip}:${c.req.path}`;
    const { allowed, retryAfterSeconds } = check(key);
    if (allowed) return next();
    const retry = Number.isFinite(retryAfterSeconds) ? String(Math.max(1, retryAfterSeconds)) : '60';
    return c.json({ error: 'rate_limited' }, 429, { 'retry-after': retry });
  };
}
