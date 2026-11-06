import { describe, it, expect } from 'vitest';
import { canEditDoc, canSubmitEventsDoc } from './docCapabilities';

describe('canEditDoc', () => {
  it('allows owner and editor', () => {
    expect(canEditDoc('owner')).toBe(true);
    expect(canEditDoc('editor')).toBe(true);
  });

  it('denies commenter, responder and stranger', () => {
    expect(canEditDoc('commenter')).toBe(false);
    expect(canEditDoc('responder')).toBe(false);
    expect(canEditDoc('stranger')).toBe(false);
  });

  it('denies when the role is not loaded yet', () => {
    expect(canEditDoc(undefined)).toBe(false);
  });
});

describe('canSubmitEventsDoc', () => {
  it('allows owner, editor and responder', () => {
    expect(canSubmitEventsDoc('owner')).toBe(true);
    expect(canSubmitEventsDoc('editor')).toBe(true);
    expect(canSubmitEventsDoc('responder')).toBe(true);
  });

  it('denies commenter and stranger (an org reader with no collaborator row)', () => {
    expect(canSubmitEventsDoc('commenter')).toBe(false);
    expect(canSubmitEventsDoc('stranger')).toBe(false);
  });

  it('denies when the role is not loaded yet', () => {
    expect(canSubmitEventsDoc(undefined)).toBe(false);
  });
});
