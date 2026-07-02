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
