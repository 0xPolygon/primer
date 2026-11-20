import { describe, it, expect } from 'vitest';
import {
  canRead,
  canComment,
  canEdit,
  canManage,
  type EffectiveRole,
} from './permissions.ts';
import { canWriteEvents } from './events.ts';

describe('canRead', () => {
  it('everyone reads under org visibility', () => {
    for (const r of ['owner', 'editor', 'responder', 'commenter', 'stranger'] as EffectiveRole[]) {
      expect(canRead('org', r)).toBe(true);
    }
  });
  it('only owner + collabs read under private visibility', () => {
    expect(canRead('private', 'owner')).toBe(true);
    expect(canRead('private', 'editor')).toBe(true);
    expect(canRead('private', 'responder')).toBe(true);
    expect(canRead('private', 'commenter')).toBe(true);
    expect(canRead('private', 'stranger')).toBe(false);
  });
});

describe('canComment', () => {
  it('everyone comments under org visibility', () => {
    for (const r of ['owner', 'editor', 'responder', 'commenter', 'stranger'] as EffectiveRole[]) {
      expect(canComment('org', r)).toBe(true);
    }
  });
  it('only owner + collabs comment under private visibility', () => {
    expect(canComment('private', 'owner')).toBe(true);
    expect(canComment('private', 'editor')).toBe(true);
    expect(canComment('private', 'responder')).toBe(true);
    expect(canComment('private', 'commenter')).toBe(true);
    expect(canComment('private', 'stranger')).toBe(false);
  });
});

describe('canEdit', () => {
  it('owner and editor can edit; responder, commenter and stranger cannot', () => {
    expect(canEdit('owner')).toBe(true);
    expect(canEdit('editor')).toBe(true);
    expect(canEdit('responder')).toBe(false);
    expect(canEdit('commenter')).toBe(false);
    expect(canEdit('stranger')).toBe(false);
  });
});

describe('canManage', () => {
  it('only owner can manage', () => {
    expect(canManage('owner')).toBe(true);
    expect(canManage('editor')).toBe(false);
    expect(canManage('responder')).toBe(false);
    expect(canManage('commenter')).toBe(false);
    expect(canManage('stranger')).toBe(false);
  });
});

describe('canWriteEvents', () => {
  it('owner, editor and responder may write events', () => {
    expect(canWriteEvents('owner')).toBe(true);
    expect(canWriteEvents('editor')).toBe(true);
    expect(canWriteEvents('responder')).toBe(true);
  });
  it('commenter and stranger may not write events', () => {
    expect(canWriteEvents('commenter')).toBe(false);
    expect(canWriteEvents('stranger')).toBe(false);
  });
});

import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import { documents, users, documentCollaborators } from '../db/schema.ts';
import { loadEffectiveRole } from './permissions.ts';

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

const person = (id: string) => ({ id, email: `${id}@x.test`, displayName: id, kind: 'person' as const, viaUserId: null });

describe('loadEffectiveRole', () => {
  it('owner, collaborator roles, stranger', async () => {
    await seedUser('perm-owner');
    await seedUser('perm-editor');
    await seedUser('perm-other');
    const docId = await seedDoc('perm-owner');
    await db.insert(documentCollaborators).values({
      id: uuidv7(),
      documentId: docId,
      userId: 'perm-editor',
      role: 'editor',
      grantedBy: 'perm-owner',
    });
    const doc = { id: docId, uploaderId: 'perm-owner', visibility: 'org' as const };
    expect(await loadEffectiveRole(doc, person('perm-owner'))).toBe('owner');
    expect(await loadEffectiveRole(doc, person('perm-editor'))).toBe('editor');
    expect(await loadEffectiveRole(doc, person('perm-other'))).toBe('stranger');
  });
});
