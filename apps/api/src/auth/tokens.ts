import { randomBytes, createHash } from 'node:crypto';

export const TOKEN_PREFIX = 'primer_pat_';
const USER_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface GeneratedToken { token: string; tokenHash: string; tokenPrefix: string; }
export function generateToken(): GeneratedToken {
  const random = randomBytes(32).toString('base64url');
  const token = `${TOKEN_PREFIX}${random}`;
  return { token, tokenHash: hashToken(token), tokenPrefix: random.slice(0, 8) };
}

export interface GeneratedDeviceCode { deviceCode: string; deviceCodeHash: string; }
export function generateDeviceCode(): GeneratedDeviceCode {
  const deviceCode = randomBytes(32).toString('base64url');
  return { deviceCode, deviceCodeHash: hashToken(deviceCode) };
}

// Rejection-sampling threshold: the largest multiple of the alphabet length
// that fits in a byte. Bytes >= this value are rejected and resampled, so the
// modulo always operates on a uniformly distributed range. With the current
// 32-char alphabet this equals 256 and no byte is ever rejected — but writing
// it this way keeps the function unbiased if the alphabet ever changes length,
// and satisfies CodeQL's js/biased-cryptographic-random check.
const USER_CODE_BYTE_LIMIT =
  Math.floor(256 / USER_CODE_ALPHABET.length) * USER_CODE_ALPHABET.length;

function pickAlphabetChar(): string {
  // Loop until we draw a byte in the unbiased range. Expected iterations < 2.
  while (true) {
    const byte = randomBytes(1)[0];
    if (byte < USER_CODE_BYTE_LIMIT) {
      return USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length];
    }
  }
}

export function generateUserCode(): string {
  const block = () => Array.from({ length: 4 }, pickAlphabetChar).join('');
  return `${block()}-${block()}`;
}
