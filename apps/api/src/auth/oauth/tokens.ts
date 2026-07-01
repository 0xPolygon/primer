import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export const ACCESS_TOKEN_PREFIX = 'primer_oat_';
export const REFRESH_TOKEN_PREFIX = 'primer_ort_';

export function hashHex(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

export function generateAuthCode(): { code: string; codeHash: string } {
  const code = randomBytes(32).toString('base64url');
  return { code, codeHash: hashHex(code) };
}

export function generateAccessToken(): { token: string; tokenHash: string } {
  const random = randomBytes(32).toString('base64url');
  const token = `${ACCESS_TOKEN_PREFIX}${random}`;
  return { token, tokenHash: hashHex(token) };
}

export function generateRefreshToken(): { token: string; tokenHash: string } {
  const random = randomBytes(32).toString('base64url');
  const token = `${REFRESH_TOKEN_PREFIX}${random}`;
  return { token, tokenHash: hashHex(token) };
}

export function generateClientId(): string {
  return randomBytes(24).toString('base64url'); // 32-char output
}

/**
 * RFC 7636 S256: challenge === base64url(SHA256(verifier)). Constant-time
 * compare to avoid a leaking-by-timing branch on the byte-by-byte match.
 */
export function verifyPkceS256(challenge: string, verifier: string): boolean {
  const expected = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(challenge, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
