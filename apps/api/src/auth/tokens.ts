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

export function generateUserCode(): string {
  const pick = () => USER_CODE_ALPHABET[randomBytes(1)[0] % USER_CODE_ALPHABET.length];
  const block = () => Array.from({ length: 4 }, pick).join('');
  return `${block()}-${block()}`;
}
