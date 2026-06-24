import { describe, it, expect } from 'vitest';
import type { VersionSummaryDTO } from '@primer/shared';
import {
  parseViewParam,
  resolveCompareParams,
  pickDefaultFromVersion,
} from './compareParams.ts';

function v(versionNumber: number): VersionSummaryDTO {
  return {
    id: `id-${versionNumber}`,
    versionNumber,
    versionNote: null,
    sizeBytes: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}

// Versions list as the API returns it: descending by versionNumber.
const VERSIONS = [v(5), v(4), v(3), v(2), v(1)];

describe('parseViewParam', () => {
  it('defaults to split when null', () => {
    expect(parseViewParam(null)).toBe('split');
  });
  it('defaults to split when empty', () => {
    expect(parseViewParam('')).toBe('split');
  });
  it('accepts split', () => {
    expect(parseViewParam('split')).toBe('split');
  });
  it('accepts unified', () => {
    expect(parseViewParam('unified')).toBe('unified');
  });
  it('falls back to split for unknown values', () => {
    expect(parseViewParam('foo')).toBe('split');
  });
});

describe('resolveCompareParams', () => {
  it('is invalid when fromV is missing', () => {
    expect(resolveCompareParams(VERSIONS, undefined, '3')).toEqual({ kind: 'invalid' });
  });
  it('is invalid when toV is missing', () => {
    expect(resolveCompareParams(VERSIONS, '3', undefined)).toEqual({ kind: 'invalid' });
  });
  it('is invalid when fromV is not a positive integer', () => {
    expect(resolveCompareParams(VERSIONS, 'abc', '3')).toEqual({ kind: 'invalid' });
    expect(resolveCompareParams(VERSIONS, '0', '3')).toEqual({ kind: 'invalid' });
    expect(resolveCompareParams(VERSIONS, '-1', '3')).toEqual({ kind: 'invalid' });
    expect(resolveCompareParams(VERSIONS, '1.5', '3')).toEqual({ kind: 'invalid' });
  });
  it('is invalid when toV is not a positive integer', () => {
    expect(resolveCompareParams(VERSIONS, '3', 'abc')).toEqual({ kind: 'invalid' });
    expect(resolveCompareParams(VERSIONS, '3', '0')).toEqual({ kind: 'invalid' });
    expect(resolveCompareParams(VERSIONS, '3', '-1')).toEqual({ kind: 'invalid' });
    expect(resolveCompareParams(VERSIONS, '3', '1.5')).toEqual({ kind: 'invalid' });
  });
  it('returns not-found when fromV does not exist', () => {
    expect(resolveCompareParams(VERSIONS, '99', '3')).toEqual({ kind: 'not-found', missing: 99 });
  });
  it('returns not-found when toV does not exist', () => {
    expect(resolveCompareParams(VERSIONS, '3', '99')).toEqual({ kind: 'not-found', missing: 99 });
  });
  it('returns identical when both numbers equal', () => {
    const result = resolveCompareParams(VERSIONS, '3', '3');
    expect(result.kind).toBe('identical');
    if (result.kind === 'identical') {
      expect(result.version.versionNumber).toBe(3);
    }
  });
  it('returns ok with the resolved versions when from < to', () => {
    const result = resolveCompareParams(VERSIONS, '2', '4');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.from.versionNumber).toBe(2);
      expect(result.to.versionNumber).toBe(4);
    }
  });
  it('returns ok and does not enforce chronology when from > to', () => {
    const result = resolveCompareParams(VERSIONS, '5', '2');
    expect(result.kind).toBe('ok');
    if (result.kind === 'ok') {
      expect(result.from.versionNumber).toBe(5);
      expect(result.to.versionNumber).toBe(2);
    }
  });
});

describe('pickDefaultFromVersion', () => {
  it('returns the version just below the target', () => {
    const def = pickDefaultFromVersion(VERSIONS, 5);
    expect(def?.versionNumber).toBe(4);
  });
  it('returns null when target is the lowest version', () => {
    const def = pickDefaultFromVersion(VERSIONS, 1);
    expect(def).toBeNull();
  });
  it('returns null when target is unknown', () => {
    expect(pickDefaultFromVersion(VERSIONS, 99)).toBeNull();
  });
  it('returns null when the list is empty', () => {
    expect(pickDefaultFromVersion([], 1)).toBeNull();
  });
});
