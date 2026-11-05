import { describe, it, expect } from 'vitest';
import { formatSharedWith, roleOptions } from './share.ts';

describe('formatSharedWith', () => {
  const me = { userId: 'me', displayName: 'Me' };
  const alice = { userId: 'a', displayName: 'Alice' };
  const bob = { userId: 'b', displayName: 'Bob' };
  const carol = { userId: 'c', displayName: 'Carol' };
  const dave = { userId: 'd', displayName: 'Dave' };

  it('returns null when the current user is not among collaborators', () => {
    expect(formatSharedWith([alice, bob], 'me')).toBeNull();
  });

  it('renders a single co-collaborator', () => {
    expect(formatSharedWith([me, alice], 'me')).toBe('Shared with Alice');
  });

  it('renders two co-collaborators with an "and" join', () => {
    expect(formatSharedWith([me, alice, bob], 'me')).toBe('Shared with Alice and Bob');
  });

  it('renders three co-collaborators as "A, B and 1 other"', () => {
    expect(formatSharedWith([me, alice, bob, carol], 'me')).toBe('Shared with Alice, Bob and 1 other');
  });

  it('renders four co-collaborators as "A, B and 2 others"', () => {
    expect(formatSharedWith([me, alice, bob, carol, dave], 'me')).toBe('Shared with Alice, Bob and 2 others');
  });
});

describe('roleOptions', () => {
  it('under private visibility, all three roles are enabled in ladder order', () => {
    const opts = roleOptions('private');
    expect(opts.map((o) => o.value)).toEqual(['commenter', 'responder', 'editor']);
    expect(opts.every((o) => !o.disabled)).toBe(true);
  });

  it('under org visibility, roles are listed in ladder order', () => {
    expect(roleOptions('org').map((o) => o.value)).toEqual(['commenter', 'responder', 'editor']);
  });

  it('responder is enabled under both visibilities and carries a tooltip', () => {
    for (const visibility of ['org', 'private'] as const) {
      const responder = roleOptions(visibility).find((o) => o.value === 'responder');
      expect(responder?.disabled).toBe(false);
      expect(responder?.tooltip).toContain('respond');
    }
  });

  it('under org visibility, commenter is disabled with a tooltip', () => {
    const opts = roleOptions('org');
    const commenter = opts.find((o) => o.value === 'commenter')!;
    expect(commenter.disabled).toBe(true);
    expect(commenter.tooltip).toContain('private');
    const editor = opts.find((o) => o.value === 'editor')!;
    expect(editor.disabled).toBe(false);
  });
});
