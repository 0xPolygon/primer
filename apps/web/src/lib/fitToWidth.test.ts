import { describe, it, expect } from 'vitest';
import {
  FIT_SCALE_FLOOR,
  computeFitScale,
  fitIframeStyle,
  hasResidualOverflow,
  nextFitState,
} from './fitToWidth.ts';

describe('nextFitState', () => {
  it('stays null for reports that fit the container within tolerance', () => {
    expect(nextFitState(null, 395, 390)).toBeNull(); // 390*1.02 = 397.8
  });

  it('starts tracking on the first overflowing report', () => {
    expect(nextFitState(null, 800, 390)).toEqual({ contentWidth: 800 });
  });

  it('grows only — a smaller report never shrinks the layout width', () => {
    expect(nextFitState({ contentWidth: 800 }, 600, 390)).toEqual({ contentWidth: 800 });
    expect(nextFitState({ contentWidth: 800 }, 1000, 390)).toEqual({ contentWidth: 1000 });
  });

  it('ignores degenerate reports', () => {
    expect(nextFitState(null, 0, 390)).toBeNull();
    expect(nextFitState(null, -10, 390)).toBeNull();
    expect(nextFitState(null, Number.NaN, 390)).toBeNull();
    expect(nextFitState({ contentWidth: 800 }, Number.NaN, 390)).toEqual({ contentWidth: 800 });
  });

  it('tracks overflow even when containerWidth is unknown (0)', () => {
    // Before the wrapper is measured we still record the report; the scale
    // computation guards on containerWidth separately.
    expect(nextFitState(null, 800, 0)).toEqual({ contentWidth: 800 });
  });
});

describe('computeFitScale', () => {
  it('is 1 with no fit state or unknown container', () => {
    expect(computeFitScale(null, 390)).toBe(1);
    expect(computeFitScale({ contentWidth: 800 }, 0)).toBe(1);
  });

  it('is 1 when the container now fits the content (e.g. after rotation)', () => {
    expect(computeFitScale({ contentWidth: 800 }, 844)).toBe(1);
  });

  it('scales proportionally between the floor and 1', () => {
    expect(computeFitScale({ contentWidth: 600 }, 390)).toBeCloseTo(0.65, 10);
  });

  it('floors at 0.5 for degenerate ultra-wide content', () => {
    expect(computeFitScale({ contentWidth: 3000 }, 390)).toBe(FIT_SCALE_FLOOR);
  });
});

describe('fitIframeStyle', () => {
  it('renders a natural 100% box at scale 1', () => {
    expect(fitIframeStyle(1, null)).toEqual({ width: '100%', height: '100%' });
    expect(fitIframeStyle(1, { contentWidth: 800 })).toEqual({ width: '100%', height: '100%' });
  });

  it('widens the layout box and scales it back down when scaled', () => {
    expect(fitIframeStyle(0.65, { contentWidth: 600 })).toEqual({
      width: '600px',
      height: `${100 / 0.65}%`,
      transform: 'scale(0.65)',
      transformOrigin: 'top left',
    });
  });
});

describe('hasResidualOverflow', () => {
  it('is false at 1:1 or when the floored scale still fits', () => {
    expect(hasResidualOverflow(1, null, 390)).toBe(false);
    expect(hasResidualOverflow(0.65, { contentWidth: 600 }, 390)).toBe(false); // 600*0.65 = 390
  });

  it('is true when even the floor cannot fit the content', () => {
    expect(hasResidualOverflow(0.5, { contentWidth: 3000 }, 390)).toBe(true); // 1500 > 390
  });
});
