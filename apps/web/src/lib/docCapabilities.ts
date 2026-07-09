import type { ViewerRole } from '@primer/shared/api';

/** Pure function: can the viewer edit the document (add versions, edit
 *  title/description)? Mirrors canEdit in apps/api/src/lib/permissions.ts.
 *  `undefined` covers detail data not yet loaded. */
export function canEditDoc(myRole: ViewerRole | undefined): boolean {
  return myRole === 'owner' || myRole === 'editor';
}
