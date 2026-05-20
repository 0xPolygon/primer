import { describe, it, expect } from 'vitest';
import { validateAndCleanMentions, MAX_MENTIONS } from './mentions.ts';

const KNOWN_USERS = new Set(['mock-user-1', 'mock-user-2', 'mock-user-3']);
const ACTOR = 'mock-user-1';

describe('validateAndCleanMentions', () => {
  it('returns ok=true with the deduplicated, self-removed array for a valid input', () => {
    const r = validateAndCleanMentions(
      ['mock-user-2', 'mock-user-3', 'mock-user-2', 'mock-user-1'],
      ACTOR,
      KNOWN_USERS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.mentions.sort()).toEqual(['mock-user-2', 'mock-user-3']);
    }
  });

  it('returns ok=true with [] for an undefined input', () => {
    const r = validateAndCleanMentions(undefined, ACTOR, KNOWN_USERS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mentions).toEqual([]);
  });

  it('returns ok=true with [] for an empty array', () => {
    const r = validateAndCleanMentions([], ACTOR, KNOWN_USERS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mentions).toEqual([]);
  });

  it('returns 400 invalid_mention when any id is unknown', () => {
    const r = validateAndCleanMentions(['mock-user-2', 'ghost'], ACTOR, KNOWN_USERS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_mention');
  });

  it('returns 400 too_many_mentions when the input exceeds the cap', () => {
    const big = Array.from({ length: MAX_MENTIONS + 1 }, (_, i) => `mock-user-${i + 100}`);
    const r = validateAndCleanMentions(big, ACTOR, KNOWN_USERS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('too_many_mentions');
  });

  it('returns 400 invalid_mention when input is not an array', () => {
    const r = validateAndCleanMentions('not-an-array' as unknown as string[], ACTOR, KNOWN_USERS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('invalid_mention');
  });

  it('removes the actor silently (no error) even if mentioned', () => {
    const r = validateAndCleanMentions(['mock-user-1'], ACTOR, KNOWN_USERS);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.mentions).toEqual([]);
  });
});
