import { describe, it, expect } from 'vitest';
import { reconcileMentions } from './reconcileMentions.ts';

const USERS = [
  { id: 'u1', displayName: 'Alice Tester', email: 'a@p.t' },
  { id: 'u2', displayName: 'Bob Builder', email: 'b@p.t' },
  { id: 'u3', displayName: 'Carol O\'Brien', email: 'c@p.t' },
];

describe('reconcileMentions', () => {
  it('keeps an id whose display name appears in the body', () => {
    expect(reconcileMentions('hey @Alice Tester look', new Set(['u1', 'u2']), USERS)).toEqual(['u1']);
  });

  it('drops an id whose display name no longer appears in the body', () => {
    expect(reconcileMentions('hey look', new Set(['u1', 'u2']), USERS)).toEqual([]);
  });

  it('returns [] when set is empty', () => {
    expect(reconcileMentions('@Alice Tester', new Set(), USERS)).toEqual([]);
  });

  it('handles names with regex special characters', () => {
    expect(reconcileMentions('@Carol O\'Brien hi', new Set(['u3']), USERS)).toEqual(['u3']);
  });

  it('does not duplicate ids when name appears multiple times', () => {
    expect(reconcileMentions('@Alice Tester and @Alice Tester', new Set(['u1']), USERS)).toEqual(['u1']);
  });

  it('ignores ids whose user is missing from the users list', () => {
    expect(reconcileMentions('@Alice Tester', new Set(['u1', 'u-ghost']), USERS)).toEqual(['u1']);
  });
});
