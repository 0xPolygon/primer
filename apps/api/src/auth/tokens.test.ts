import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  TOKEN_PREFIX,
  hashToken,
  generateToken,
  generateDeviceCode,
  generateUserCode,
} from './tokens.ts';

describe('hashToken', () => {
  it('returns the known SHA-256 hex of "abc"', () => {
    expect(hashToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'
    );
  });

  it('is deterministic across calls', () => {
    const a = hashToken('the quick brown fox');
    const b = hashToken('the quick brown fox');
    expect(a).toBe(b);
  });

  it('produces 64-char lowercase hex output', () => {
    const out = hashToken('arbitrary input value');
    expect(out).toHaveLength(64);
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches Node createHash output for a random input', () => {
    const input = 'primer_pat_some-random-payload';
    const expected = createHash('sha256').update(input, 'utf8').digest('hex');
    expect(hashToken(input)).toBe(expected);
  });
});

describe('generateToken', () => {
  it('starts with primer_pat_ prefix', () => {
    const t = generateToken();
    expect(t.token.startsWith(TOKEN_PREFIX)).toBe(true);
    expect(TOKEN_PREFIX).toBe('primer_pat_');
  });

  it('tokenHash matches hashToken(token)', () => {
    const t = generateToken();
    expect(t.tokenHash).toBe(hashToken(t.token));
  });

  it('tokenPrefix is exactly 8 chars and appears in the token after the static prefix', () => {
    const t = generateToken();
    expect(t.tokenPrefix).toHaveLength(8);
    const random = t.token.slice(TOKEN_PREFIX.length);
    expect(random.startsWith(t.tokenPrefix)).toBe(true);
    expect(t.token.includes(t.tokenPrefix)).toBe(true);
  });

  it('produces distinct tokens across many calls (entropy sanity)', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 16; i++) {
      tokens.add(generateToken().token);
    }
    expect(tokens.size).toBe(16);
  });
});

describe('generateDeviceCode', () => {
  it('produces a base64url string with no padding', () => {
    const d = generateDeviceCode();
    expect(d.deviceCode).toMatch(/^[A-Za-z0-9_-]+$/);
    // randomBytes(32) base64url-encoded → 43 chars, no padding.
    expect(d.deviceCode).toHaveLength(43);
    expect(d.deviceCode.includes('=')).toBe(false);
  });

  it('deviceCodeHash matches hashToken(deviceCode)', () => {
    const d = generateDeviceCode();
    expect(d.deviceCodeHash).toBe(hashToken(d.deviceCode));
  });

  it('produces distinct device codes across many calls', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 16; i++) {
      codes.add(generateDeviceCode().deviceCode);
    }
    expect(codes.size).toBe(16);
  });
});

describe('generateUserCode', () => {
  it('matches the XXXX-XXXX format with no ambiguous characters', () => {
    for (let i = 0; i < 50; i++) {
      const code = generateUserCode();
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });

  it('never contains 0, O, 1, or I across many samples', () => {
    const forbidden = ['0', 'O', '1', 'I'];
    for (let i = 0; i < 200; i++) {
      const code = generateUserCode();
      for (const ch of forbidden) {
        expect(code.includes(ch)).toBe(false);
      }
    }
  });

  it('produces a large number of distinct codes across 200 calls', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 200; i++) {
      codes.add(generateUserCode());
    }
    // With ~32^8 possible codes, 200 random draws should almost never collide.
    // Use a comfortable lower bound to allow vanishingly rare collisions.
    expect(codes.size).toBeGreaterThanOrEqual(190);
  });
});
