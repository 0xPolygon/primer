import { v7 as uuidv7 } from 'uuid';
import type { CollaboratorRole } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documentCollaborators, documents, users } from '../db/schema.ts';

export const OWNER: AuthUser = { id: 'rec-owner', email: 'owner@p.t', displayName: 'Ada', kind: 'person', viaUserId: null };
export const VIEWER: AuthUser = { id: 'rec-viewer', email: 'viewer@p.t', displayName: 'Bea', kind: 'person', viaUserId: null };
export const READER: AuthUser = { id: 'rec-reader', email: 'reader@p.t', displayName: 'Cy', kind: 'person', viaUserId: null };
export const AGENT: AuthUser = { id: 'agent_rec', email: 'agent_rec@agents.primer', displayName: 'Claude', kind: 'agent', viaUserId: 'rec-owner' };

/** A private document owned by OWNER, VIEWER a responder, READER a commenter. */
export async function seedRecordsDoc(): Promise<string> {
  await db
    .insert(users)
    .values([OWNER, VIEWER, READER, AGENT].map((u) => ({ id: u.id, email: u.email, displayName: u.displayName, kind: u.kind, viaUserId: u.viaUserId })))
    .onConflictDoNothing();
  const id = uuidv7();
  await db.insert(documents).values({ id, title: 'Poll', uploaderId: OWNER.id, visibility: 'private' });
  const grant = (userId: string, role: CollaboratorRole) => ({ id: uuidv7(), documentId: id, userId, role, grantedBy: OWNER.id });
  await db.insert(documentCollaborators).values([grant(VIEWER.id, 'responder'), grant(READER.id, 'commenter')]);
  return id;
}
