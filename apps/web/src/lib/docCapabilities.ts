import type { ViewerRole } from '@polygonlabs/primer-api-types';

/** Pure function: can the viewer edit the document (add versions, edit
 *  title/description)? Mirrors canEdit in apps/api/src/lib/permissions.ts.
 *  `undefined` covers detail data not yet loaded. */
export function canEditDoc(myRole: ViewerRole | undefined): boolean {
  return myRole === 'owner' || myRole === 'editor';
}

/** Pure function: can the viewer write document events (so the page may
 *  submit in their name)? Mirrors canWriteEvents in
 *  apps/api/src/lib/events.ts: owner, editor and responder. A commenter, or
 *  an org reader with no collaborator row ('stranger'), can read the page but
 *  not respond through it. `undefined` covers detail data not yet loaded. */
export function canSubmitEventsDoc(myRole: ViewerRole | undefined): boolean {
  return myRole === 'owner' || myRole === 'editor' || myRole === 'responder';
}
