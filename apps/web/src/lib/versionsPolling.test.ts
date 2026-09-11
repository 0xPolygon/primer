import { describe, it, expect } from 'vitest';
import { versionsRefetchInterval, becameVisible, VERSIONS_POLL_INTERVAL_MS } from './versionsPolling.ts';

describe('versionsRefetchInterval', () => {
  it('polls at the fixed interval while visible', () => {
    expect(versionsRefetchInterval(false)).toBe(VERSIONS_POLL_INTERVAL_MS);
  });

  it('backs off entirely while hidden', () => {
    expect(versionsRefetchInterval(true)).toBe(false);
  });
});

describe('becameVisible', () => {
  it('is true on the hidden → visible transition', () => {
    expect(becameVisible(true, false)).toBe(true);
  });

  it('is false when already visible', () => {
    expect(becameVisible(false, false)).toBe(false);
  });

  it('is false on the visible → hidden transition', () => {
    expect(becameVisible(false, true)).toBe(false);
  });

  it('is false when staying hidden', () => {
    expect(becameVisible(true, true)).toBe(false);
  });
});
