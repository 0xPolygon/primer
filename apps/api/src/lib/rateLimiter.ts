/**
 * In-memory per-key rate limiter using a fixed-window counter. Suitable for a
 * single API instance; behind a horizontally-scaled deployment, replace with a
 * Redis-backed equivalent.
 *
 * `checkRateLimit('1.2.3.4', 5)` returns true for the first 5 calls within a
 * 60-second window for that key, and false thereafter until the window resets.
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Cap the number of tracked keys to prevent unbounded memory growth from a
// flood of unique IPs. When the cap is reached, the oldest entries (by
// reset time) are evicted.
const MAX_KEYS = 10_000;
const WINDOW_MS = 60_000;

function evictExpired(now: number): void {
  for (const [key, bucket] of buckets) {
    if (now > bucket.resetAt) buckets.delete(key);
  }
}

function evictOldestIfFull(): void {
  if (buckets.size < MAX_KEYS) return;
  let oldestKey: string | null = null;
  let oldestResetAt = Infinity;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt < oldestResetAt) {
      oldestResetAt = bucket.resetAt;
      oldestKey = key;
    }
  }
  if (oldestKey !== null) buckets.delete(oldestKey);
}

export function checkRateLimit(key: string, maxPerWindow: number): boolean {
  const now = Date.now();
  const existing = buckets.get(key);
  if (!existing || now > existing.resetAt) {
    evictExpired(now);
    evictOldestIfFull();
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (existing.count >= maxPerWindow) return false;
  existing.count++;
  return true;
}

/** Test helper: reset the limiter state. Not exported in public surface. */
export function _resetRateLimiterForTests(): void {
  buckets.clear();
}
