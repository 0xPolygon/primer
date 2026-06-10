import { describe, it, expect } from 'vitest';
import { extractCanonicalDocId } from './docIdParam.ts';

describe('extractCanonicalDocId', () => {
  it('returns the docId unchanged when it is already a clean UUID', () => {
    expect(extractCanonicalDocId('019eade4-bd0d-735a-a2e4-88c08b00b33e')).toBe(
      '019eade4-bd0d-735a-a2e4-88c08b00b33e',
    );
  });

  it('strips Google Calendar tracking suffix appended with &', () => {
    const raw =
      '019eade4-bd0d-735a-a2e4-88c08b00b33e&sa=D&source=calendar&ust=1781527513270243&usg=AOvVaw3fEQuK4b9ACWrrd-1B09P3';
    expect(extractCanonicalDocId(raw)).toBe('019eade4-bd0d-735a-a2e4-88c08b00b33e');
  });

  it('strips a Gmail-style tracking suffix', () => {
    const raw = '019eade4-bd0d-735a-a2e4-88c08b00b33e?utm_source=gmail';
    expect(extractCanonicalDocId(raw)).toBe('019eade4-bd0d-735a-a2e4-88c08b00b33e');
  });

  it('is case-insensitive over hex chars', () => {
    expect(extractCanonicalDocId('019EADE4-BD0D-735A-A2E4-88C08B00B33E')).toBe(
      '019EADE4-BD0D-735A-A2E4-88C08B00B33E',
    );
  });

  it('returns null when the input does not begin with a UUID', () => {
    expect(extractCanonicalDocId('not-a-uuid')).toBeNull();
    expect(extractCanonicalDocId('')).toBeNull();
    expect(extractCanonicalDocId('019eade4')).toBeNull();
  });
});
