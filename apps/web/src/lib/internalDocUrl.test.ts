import { describe, it, expect } from 'vitest';
import { internalDocUrl } from './internalDocUrl.ts';

describe('internalDocUrl', () => {
  it('builds the canonical doc link when no version is given', () => {
    expect(internalDocUrl('https://primer.example.com', 'abc123')).toBe(
      'https://primer.example.com/d/abc123',
    );
  });

  it('builds a version-pinned link when a version number is given', () => {
    expect(internalDocUrl('https://primer.example.com', 'abc123', 3)).toBe(
      'https://primer.example.com/d/abc123/v/3',
    );
  });

  it('treats undefined version as canonical', () => {
    expect(internalDocUrl('https://primer.example.com', 'abc123', undefined)).toBe(
      'https://primer.example.com/d/abc123',
    );
  });
});
