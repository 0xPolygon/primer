import { describe, it, expect } from 'vitest';
import { parseCookie, serializeCookie } from './cookies.ts';

describe('parseCookie', () => {
  it('returns the value for a present cookie', () => {
    expect(parseCookie('primer_sid=abc123', 'primer_sid')).toBe('abc123');
  });

  it('handles multiple cookies', () => {
    expect(
      parseCookie('foo=bar; primer_sid=xyz; baz=qux', 'primer_sid')
    ).toBe('xyz');
  });

  it('returns null when cookie missing', () => {
    expect(parseCookie('foo=bar', 'primer_sid')).toBeNull();
  });

  it('returns null on null/empty input', () => {
    expect(parseCookie(null, 'primer_sid')).toBeNull();
    expect(parseCookie('', 'primer_sid')).toBeNull();
  });

  it('decodes URI-encoded values', () => {
    expect(parseCookie('x=%2Fpath', 'x')).toBe('/path');
  });
});

describe('serializeCookie', () => {
  it('builds a basic cookie', () => {
    const s = serializeCookie('primer_sid', 'abc', {
      maxAge: 3600,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
    expect(s).toContain('primer_sid=abc');
    expect(s).toContain('Max-Age=3600');
    expect(s).toContain('HttpOnly');
    expect(s).toContain('Secure');
    expect(s).toContain('SameSite=Lax');
    expect(s).toContain('Path=/');
  });

  it('builds a deletion cookie when maxAge=0', () => {
    const s = serializeCookie('primer_sid', '', { maxAge: 0, path: '/' });
    expect(s).toContain('primer_sid=');
    expect(s).toContain('Max-Age=0');
  });

  it('omits Secure when secure=false', () => {
    const s = serializeCookie('x', 'v', { httpOnly: true, sameSite: 'lax', path: '/' });
    expect(s).not.toContain('Secure');
  });

  it('URI-encodes the value', () => {
    expect(serializeCookie('x', '/path', { path: '/' })).toContain('x=%2Fpath');
  });
});
