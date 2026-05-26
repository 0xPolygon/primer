import { describe, it, expect } from 'vitest';
import { resolveSnap, type SnapDef } from './BottomSheet.snap';

const SNAPS: SnapDef[] = [
  { name: 'handle', height: 48 },
  { name: 'peek', height: 300 },
  { name: 'expanded', height: 700 },
];

describe('resolveSnap', () => {
  it('snaps to nearest when velocity is below threshold', () => {
    expect(resolveSnap({ currentHeight: 60, velocity: 0, snaps: SNAPS })).toBe('handle');
    expect(resolveSnap({ currentHeight: 180, velocity: 0, snaps: SNAPS })).toBe('peek');
    expect(resolveSnap({ currentHeight: 600, velocity: 0, snaps: SNAPS })).toBe('expanded');
  });

  it('snaps to next-smaller when velocity is strongly downward', () => {
    // velocity > threshold = sheet shrinking
    expect(resolveSnap({ currentHeight: 500, velocity: 2, snaps: SNAPS })).toBe('peek');
    expect(resolveSnap({ currentHeight: 200, velocity: 2, snaps: SNAPS })).toBe('handle');
  });

  it('snaps to next-larger when velocity is strongly upward', () => {
    // velocity < -threshold = sheet growing
    expect(resolveSnap({ currentHeight: 200, velocity: -2, snaps: SNAPS })).toBe('peek');
    expect(resolveSnap({ currentHeight: 400, velocity: -2, snaps: SNAPS })).toBe('expanded');
  });

  it('clamps to the smallest snap when shrinking past handle', () => {
    expect(resolveSnap({ currentHeight: 40, velocity: 2, snaps: SNAPS })).toBe('handle');
  });

  it('clamps to the largest snap when growing past expanded', () => {
    expect(resolveSnap({ currentHeight: 800, velocity: -2, snaps: SNAPS })).toBe('expanded');
  });

  it('respects a custom velocityThreshold', () => {
    // velocity 0.3 < default 0.5, but > custom 0.1 — treat as shrinking.
    expect(
      resolveSnap({ currentHeight: 500, velocity: 0.3, snaps: SNAPS, velocityThreshold: 0.1 }),
    ).toBe('peek');
  });

  it('handles snaps passed in arbitrary order', () => {
    const shuffled: SnapDef[] = [
      { name: 'expanded', height: 700 },
      { name: 'handle', height: 48 },
      { name: 'peek', height: 300 },
    ];
    expect(resolveSnap({ currentHeight: 60, velocity: 0, snaps: shuffled })).toBe('handle');
  });
});
