import { describe, it, expect } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import {
  hashHex,
  generateAuthCode,
  generateAccessToken,
  generateRefreshToken,
  generateClientId,
  verifyPkceS256,
  ACCESS_TOKEN_PREFIX,
  REFRESH_TOKEN_PREFIX,
} from './tokens.ts';

describe('hashHex', () => {
  it('returns sha256 hex of the input', () => {
    expect(hashHex('hello')).toBe(createHash('sha256').update('hello', 'utf8').digest('hex'));
  });
});

describe('generateAuthCode', () => {
  it('returns raw code with matching sha256 hash', () => {
    const { code, codeHash } = generateAuthCode();
    expect(code.length).toBeGreaterThan(20);
    expect(codeHash).toBe(hashHex(code));
  });

  it('is unique across draws', () => {
    const a = generateAuthCode();
    const b = generateAuthCode();
    expect(a.code).not.toBe(b.code);
  });
});

describe('generateAccessToken', () => {
  it('carries the primer_oat_ prefix and matching hash', () => {
    const { token, tokenHash } = generateAccessToken();
    expect(token.startsWith(ACCESS_TOKEN_PREFIX)).toBe(true);
    expect(tokenHash).toBe(hashHex(token));
  });
});

describe('generateRefreshToken', () => {
  it('carries the primer_ort_ prefix and matching hash', () => {
    const { token, tokenHash } = generateRefreshToken();
    expect(token.startsWith(REFRESH_TOKEN_PREFIX)).toBe(true);
    expect(tokenHash).toBe(hashHex(token));
  });
});

describe('generateClientId', () => {
  it('returns a 32+ char base64url string', () => {
    const id = generateClientId();
    expect(id.length).toBeGreaterThanOrEqual(32);
    expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('verifyPkceS256', () => {
  it('returns true when SHA256(verifier) base64url-encoded matches the challenge', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
    expect(verifyPkceS256(challenge, verifier)).toBe(true);
  });

  it('returns false on a mismatch', () => {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update('different', 'utf8').digest('base64url');
    expect(verifyPkceS256(challenge, verifier)).toBe(false);
  });

  it('uses constant-time comparison (both inputs same length, one bit off)', () => {
    // Not truly testable at unit level, but exercise the equal-length path so
    // an accidental === rewrite would still return false.
    const verifier = 'a'.repeat(43);
    const challenge = 'b'.repeat(43);
    expect(verifyPkceS256(challenge, verifier)).toBe(false);
  });
});
