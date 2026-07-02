import { describe, it, expect } from 'vitest';
import {
  effectiveRole,
  canRead,
  canComment,
  canEdit,
  canManage,
  type Visibility,
  type CollaboratorRole,
  type EffectiveRole,
} from './permissions.ts';

describe('effectiveRole', () => {
  const doc = { uploaderId: 'owner-1', visibility: 'org' as Visibility };

  it('returns "owner" when userId matches uploaderId', () => {
    expect(effectiveRole(doc, 'owner-1', null)).toBe('owner');
    expect(effectiveRole(doc, 'owner-1', 'editor')).toBe('owner'); // owner beats collab
  });
  it('returns "editor" when user is editor collab and not owner', () => {
    expect(effectiveRole(doc, 'someone-else', 'editor')).toBe('editor');
  });
  it('returns "commenter" when user is commenter collab and not owner', () => {
    expect(effectiveRole(doc, 'someone-else', 'commenter')).toBe('commenter');
  });
  it('returns "stranger" when no collab row and not owner', () => {
    expect(effectiveRole(doc, 'someone-else', null)).toBe('stranger');
  });
});

describe('canRead', () => {
  it('everyone reads under org visibility', () => {
    for (const r of ['owner', 'editor', 'commenter', 'stranger'] as EffectiveRole[]) {
      expect(canRead('org', r)).toBe(true);
    }
  });
  it('only owner + collabs read under private visibility', () => {
    expect(canRead('private', 'owner')).toBe(true);
    expect(canRead('private', 'editor')).toBe(true);
    expect(canRead('private', 'commenter')).toBe(true);
    expect(canRead('private', 'stranger')).toBe(false);
  });
});

describe('canComment', () => {
  it('everyone comments under org visibility', () => {
    for (const r of ['owner', 'editor', 'commenter', 'stranger'] as EffectiveRole[]) {
      expect(canComment('org', r)).toBe(true);
    }
  });
  it('only owner + collabs comment under private visibility', () => {
    expect(canComment('private', 'owner')).toBe(true);
    expect(canComment('private', 'editor')).toBe(true);
    expect(canComment('private', 'commenter')).toBe(true);
    expect(canComment('private', 'stranger')).toBe(false);
  });
});

describe('canEdit', () => {
  it('owner and editor can edit; commenter and stranger cannot', () => {
    expect(canEdit('owner')).toBe(true);
    expect(canEdit('editor')).toBe(true);
    expect(canEdit('commenter')).toBe(false);
    expect(canEdit('stranger')).toBe(false);
  });
});

describe('canManage', () => {
  it('only owner can manage', () => {
    expect(canManage('owner')).toBe(true);
    expect(canManage('editor')).toBe(false);
    expect(canManage('commenter')).toBe(false);
    expect(canManage('stranger')).toBe(false);
  });
});
