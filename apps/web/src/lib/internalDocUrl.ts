/** Builds the internal (org-authenticated) link for a document, pinned to a
 * specific version when one is being viewed. */
export function internalDocUrl(origin: string, docId: string, versionNumber?: number): string {
  const base = `${origin}/d/${docId}`;
  return versionNumber === undefined ? base : `${base}/v/${versionNumber}`;
}
