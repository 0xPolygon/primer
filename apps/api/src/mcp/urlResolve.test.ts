import { describe, it, expect } from 'vitest';
import { parsePrimerUrl } from './urlResolve.ts';

describe('parsePrimerUrl', () => {
  it('parses a plain document URL', () => {
    expect(parsePrimerUrl('https://primer-polygon.up.railway.app/d/abc-123')).toEqual({
      documentId: 'abc-123',
    });
  });

  it('parses a versioned document URL', () => {
    expect(parsePrimerUrl('https://primer-polygon.up.railway.app/d/abc-123/v/4')).toEqual({
      documentId: 'abc-123',
      versionNumber: 4,
    });
  });

  it('drops trailing compare segments', () => {
    expect(parsePrimerUrl('https://primer-polygon.up.railway.app/d/abc-123/compare/1/2')).toEqual({
      documentId: 'abc-123',
    });
  });

  it('accepts localhost dev URLs', () => {
    expect(parsePrimerUrl('http://localhost:5173/d/xyz')).toEqual({ documentId: 'xyz' });
  });

  it('rejects non-Primer paths', () => {
    expect(parsePrimerUrl('https://primer-polygon.up.railway.app/settings')).toBeNull();
  });

  it('rejects malformed input', () => {
    expect(parsePrimerUrl('not a url')).toBeNull();
    expect(parsePrimerUrl('')).toBeNull();
    expect(parsePrimerUrl('https://primer-polygon.up.railway.app/')).toBeNull();
  });

  it('rejects non-numeric version numbers', () => {
    expect(parsePrimerUrl('https://primer-polygon.up.railway.app/d/abc/v/foo')).toBeNull();
  });
});
