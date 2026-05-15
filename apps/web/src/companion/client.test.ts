import { describe, it, expect } from 'vitest';
import { isSafeExternalUrl } from './client.ts';

describe('isSafeExternalUrl', () => {
  it('accepts well-formed https URLs', () => {
    expect(isSafeExternalUrl('https://example.com')).toBe(true);
    expect(isSafeExternalUrl('https://example.com/path?q=1#frag')).toBe(true);
  });

  it('rejects http URLs', () => {
    expect(isSafeExternalUrl('http://example.com')).toBe(false);
  });

  it('rejects javascript: URLs', () => {
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isSafeExternalUrl('data:text/html,<script>alert(1)</script>')).toBe(false);
  });

  it('rejects relative URLs', () => {
    expect(isSafeExternalUrl('/relative/path')).toBe(false);
    expect(isSafeExternalUrl('relative')).toBe(false);
  });

  it('rejects malformed strings', () => {
    expect(isSafeExternalUrl('not a url')).toBe(false);
    expect(isSafeExternalUrl('')).toBe(false);
  });

  it('rejects file: URLs', () => {
    expect(isSafeExternalUrl('file:///etc/passwd')).toBe(false);
  });
});
