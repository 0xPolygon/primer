import { describe, it, expect } from 'vitest';
import {
  linearScale,
  niceTicks,
  formatTickDate,
  formatBytes,
  clamp,
} from './chartGeom.ts';

describe('linearScale', () => {
  it('maps domain endpoints to range endpoints', () => {
    const s = linearScale([0, 10], [0, 100]);
    expect(s(0)).toBe(0);
    expect(s(10)).toBe(100);
    expect(s(5)).toBe(50);
  });

  it('handles inverted ranges (e.g. y-axis going top-to-bottom)', () => {
    const s = linearScale([0, 100], [200, 0]);
    expect(s(0)).toBe(200);
    expect(s(100)).toBe(0);
    expect(s(50)).toBe(100);
  });

  it('returns the range midpoint for a zero-width domain', () => {
    const s = linearScale([5, 5], [0, 100]);
    expect(s(5)).toBe(50);
  });
});

describe('niceTicks', () => {
  it('returns the requested count of evenly-spaced ticks', () => {
    expect(niceTicks(0, 100, 5)).toEqual([0, 25, 50, 75, 100]);
  });

  it('handles flat ranges by collapsing to a single tick at the value', () => {
    expect(niceTicks(7, 7, 5)).toEqual([7]);
  });
});

describe('formatTickDate', () => {
  it('renders YYYY-MM-DD as "Mon D"', () => {
    expect(formatTickDate('2026-06-19')).toBe('Jun 19');
    expect(formatTickDate('2026-01-03')).toBe('Jan 3');
  });
});

describe('formatBytes', () => {
  it('uses B/KB/MB/GB with one decimal', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(900)).toBe('900 B');
    expect(formatBytes(1_500)).toBe('1.5 KB');
    expect(formatBytes(2_500_000)).toBe('2.5 MB');
    expect(formatBytes(3_700_000_000)).toBe('3.7 GB');
  });
});

describe('clamp', () => {
  it('clamps to the given range', () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});
