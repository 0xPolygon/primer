import { describe, it, expect } from 'vitest';
import { isPlausibleEmail, isCompleteCode, contentUrl } from './shareViewer.ts';

describe('shareViewer helpers', () => {
  it('validates plausible emails', () => {
    expect(isPlausibleEmail('a@b.co')).toBe(true);
    expect(isPlausibleEmail('')).toBe(false);
    expect(isPlausibleEmail('nope')).toBe(false);
    expect(isPlausibleEmail('x'.repeat(321) + '@b.co')).toBe(false);
  });
  it('accepts exactly 6 digits as a complete code', () => {
    expect(isCompleteCode('123456')).toBe(true);
    expect(isCompleteCode('12345')).toBe(false);
    expect(isCompleteCode('12345a')).toBe(false);
  });
  it('builds the content URL', () => {
    expect(contentUrl('tok123')).toBe('/api/share/tok123/content');
  });
});
