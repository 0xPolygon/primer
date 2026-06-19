import { describe, it, expect } from 'vitest';
import { utcDateString, buildDateSpine, leftJoinDailyCounts } from './adminStats.ts';

describe('utcDateString', () => {
  it('formats a UTC Date as YYYY-MM-DD', () => {
    expect(utcDateString(new Date(Date.UTC(2026, 5, 19)))).toBe('2026-06-19');
    expect(utcDateString(new Date(Date.UTC(2025, 0, 1)))).toBe('2025-01-01');
  });

  it('uses UTC, not local time, near midnight', () => {
    // 23:30 UTC on 2026-06-19 is the *same day* in UTC regardless of local TZ.
    expect(utcDateString(new Date(Date.UTC(2026, 5, 19, 23, 30)))).toBe('2026-06-19');
  });
});

describe('buildDateSpine', () => {
  it('returns exactly N days, oldest first, ending at the given date', () => {
    const end = new Date(Date.UTC(2026, 5, 19));
    const spine = buildDateSpine(end, 30);
    expect(spine).toHaveLength(30);
    expect(spine[0]).toBe('2026-05-21');
    expect(spine[29]).toBe('2026-06-19');
  });

  it('handles month boundaries', () => {
    const end = new Date(Date.UTC(2026, 2, 3));   // 2026-03-03
    const spine = buildDateSpine(end, 5);
    expect(spine).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02', '2026-03-03']);
  });
});

describe('leftJoinDailyCounts', () => {
  it('returns 0 for spine dates absent from counts', () => {
    const spine = ['2026-06-01', '2026-06-02', '2026-06-03'];
    const counts = new Map([['2026-06-02', 5]]);
    expect(leftJoinDailyCounts(spine, counts)).toEqual([
      { date: '2026-06-01', value: 0 },
      { date: '2026-06-02', value: 5 },
      { date: '2026-06-03', value: 0 },
    ]);
  });

  it('ignores counts not in the spine', () => {
    const spine = ['2026-06-01'];
    const counts = new Map([['2026-06-01', 1], ['2026-05-31', 99]]);
    expect(leftJoinDailyCounts(spine, counts)).toEqual([
      { date: '2026-06-01', value: 1 },
    ]);
  });
});
