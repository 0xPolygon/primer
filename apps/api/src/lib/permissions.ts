export type Visibility = 'org' | 'private';
export type CollaboratorRole = 'commenter' | 'editor';
export type EffectiveRole = 'owner' | 'editor' | 'commenter' | 'stranger';

export function effectiveRole(
  doc: { uploaderId: string; visibility: Visibility },
  userId: string,
  collabRole: CollaboratorRole | null,
): EffectiveRole {
  if (doc.uploaderId === userId) return 'owner';
  if (collabRole === 'editor') return 'editor';
  if (collabRole === 'commenter') return 'commenter';
  return 'stranger';
}

export function canRead(visibility: Visibility, role: EffectiveRole): boolean {
  if (visibility === 'org') return true;
  return role !== 'stranger';
}

export function canComment(visibility: Visibility, role: EffectiveRole): boolean {
  // Same as canRead: reading implies the ability to comment.
  return canRead(visibility, role);
}

export function canEdit(role: EffectiveRole): boolean {
  return role === 'owner' || role === 'editor';
}

export function canManage(role: EffectiveRole): boolean {
  return role === 'owner';
}

import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { documentCollaborators } from '@primer/shared/schema';

export async function loadCollaboratorRole(
  docId: string,
  userId: string,
): Promise<CollaboratorRole | null> {
  const [row] = await db
    .select({ role: documentCollaborators.role })
    .from(documentCollaborators)
    .where(
      and(
        eq(documentCollaborators.documentId, docId),
        eq(documentCollaborators.userId, userId),
      ),
    )
    .limit(1);
  return (row?.role as CollaboratorRole | undefined) ?? null;
}

export async function loadCollaboratorRoles(
  docIds: string[],
  userId: string,
): Promise<Map<string, CollaboratorRole>> {
  const out = new Map<string, CollaboratorRole>();
  if (docIds.length === 0) return out;
  const rows = await db
    .select({
      documentId: documentCollaborators.documentId,
      role: documentCollaborators.role,
    })
    .from(documentCollaborators)
    .where(
      and(
        eq(documentCollaborators.userId, userId),
        inArray(documentCollaborators.documentId, docIds),
      ),
    );
  for (const r of rows) out.set(r.documentId, r.role as CollaboratorRole);
  return out;
}
