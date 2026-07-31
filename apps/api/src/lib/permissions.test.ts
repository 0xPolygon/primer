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

import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import { documents, users, documentCollaborators } from '../db/schema.ts';
import { loadCollaboratorRole, loadCollaboratorRoles } from './permissions.ts';

async function seedUser(id: string): Promise<void> {
  await db
    .insert(users)
    .values({ id, email: `${id}@x.test`, displayName: id })
    .onConflictDoNothing();
}

async function seedDoc(ownerId: string): Promise<string> {
  const docId = uuidv7();
  await db.insert(documents).values({
    id: docId,
    title: 't',
    description: null,
    uploaderId: ownerId,
  });
  return docId;
}

describe('loadCollaboratorRole', () => {
  it('returns null when no row exists', async () => {
    await seedUser('perm-owner');
    await seedUser('perm-other');
    const docId = await seedDoc('perm-owner');
    const role = await loadCollaboratorRole(docId, 'perm-other');
    expect(role).toBeNull();
  });

  it('returns the stored role when a row exists', async () => {
    await seedUser('perm-owner');
    await seedUser('perm-editor');
    const docId = await seedDoc('perm-owner');
    await db.insert(documentCollaborators).values({
      id: uuidv7(),
      documentId: docId,
      userId: 'perm-editor',
      role: 'editor',
      grantedBy: 'perm-owner',
    });
    const role = await loadCollaboratorRole(docId, 'perm-editor');
    expect(role).toBe('editor');
  });
});

describe('loadCollaboratorRoles (bulk)', () => {
  it('returns a map keyed by documentId for docs the user collaborates on', async () => {
    await seedUser('perm-owner');
    await seedUser('perm-both');
    const docA = await seedDoc('perm-owner');
    const docB = await seedDoc('perm-owner');
    const docC = await seedDoc('perm-owner');
    await db.insert(documentCollaborators).values([
      { id: uuidv7(), documentId: docA, userId: 'perm-both', role: 'editor', grantedBy: 'perm-owner' },
      { id: uuidv7(), documentId: docB, userId: 'perm-both', role: 'commenter', grantedBy: 'perm-owner' },
    ]);
    const roles = await loadCollaboratorRoles([docA, docB, docC], 'perm-both');
    expect(roles.get(docA)).toBe('editor');
    expect(roles.get(docB)).toBe('commenter');
    expect(roles.has(docC)).toBe(false);
  });

  it('returns an empty map when the id list is empty', async () => {
    const roles = await loadCollaboratorRoles([], 'perm-owner');
    expect(roles.size).toBe(0);
  });
});
