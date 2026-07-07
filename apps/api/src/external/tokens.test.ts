import { describe, it, expect } from 'vitest';
import { generateShareToken, generateOtpCode, hashOtpCode, otpHashesEqual } from './tokens.ts';

describe('external tokens', () => {
  it('share tokens are 43-char base64url and unique', () => {
    const a = generateShareToken();
    const b = generateShareToken();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes base64url, no padding
    expect(a).not.toBe(b);
  });

  it('OTP codes are always exactly 6 digits', () => {
    for (let i = 0; i < 500; i++) {
      expect(generateOtpCode()).toMatch(/^\d{6}$/);
    }
  });

  it('hashOtpCode is a stable sha-256 hex', () => {
    expect(hashOtpCode('123456')).toBe(hashOtpCode('123456'));
    expect(hashOtpCode('123456')).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOtpCode('123456')).not.toBe(hashOtpCode('123457'));
  });

  it('otpHashesEqual compares correctly and rejects length mismatch', () => {
    const h = hashOtpCode('654321');
    expect(otpHashesEqual(h, hashOtpCode('654321'))).toBe(true);
    expect(otpHashesEqual(h, hashOtpCode('000000'))).toBe(false);
    expect(otpHashesEqual(h, 'abcd')).toBe(false);
  });
});
