import { describe, it, expect } from 'vitest';
import { canEditDoc } from './docCapabilities';

describe('canEditDoc', () => {
  it('allows owner and editor', () => {
    expect(canEditDoc('owner')).toBe(true);
    expect(canEditDoc('editor')).toBe(true);
  });

  it('denies commenter and stranger', () => {
    expect(canEditDoc('commenter')).toBe(false);
    expect(canEditDoc('stranger')).toBe(false);
  });

  it('denies when the role is not loaded yet', () => {
    expect(canEditDoc(undefined)).toBe(false);
  });
});
