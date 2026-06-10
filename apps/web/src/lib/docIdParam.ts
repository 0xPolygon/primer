/**
 * Extract the leading UUID from a `:docId` path param. External link
 * rewriters (Google Calendar, Gmail) sometimes append tracking like
 * `&sa=D&source=calendar&ust=…` directly to the path when the original URL
 * has no `?`. React Router then treats the whole tail as `docId`. This
 * trims it back to the canonical UUID so the document still loads.
 */
const UUID_PREFIX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export function extractCanonicalDocId(raw: string): string | null {
  const m = UUID_PREFIX.exec(raw);
  return m ? m[0] : null;
}
