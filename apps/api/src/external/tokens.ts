import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';

/** 256-bit URL token for /share/:shareToken. Not the doc UUID by design. */
export function generateShareToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * 6-digit OTP. `crypto.randomInt` is cryptographically secure and unbiased
 * (rejection sampling internally), so no manual modulo handling is needed.
 */
export function generateOtpCode(): string {
  return randomInt(0, 1_000_000).toString().padStart(6, '0');
}

export function hashOtpCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

/** Constant-time comparison of two sha-256 hex digests. */
export function otpHashesEqual(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, 'hex');
  const b = Buffer.from(bHex, 'hex');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
