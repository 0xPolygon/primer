export interface PrimerUrlParsed {
  documentId: string;
  versionNumber?: number;
}

export function parsePrimerUrl(input: string): PrimerUrlParsed | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  const parts = url.pathname.split('/').filter((s) => s.length > 0);
  if (parts.length < 2) return null;
  if (parts[0] !== 'd') return null;

  const documentId = parts[1];
  if (documentId.length === 0) return null;

  // /d/<id>
  if (parts.length === 2) return { documentId };

  // /d/<id>/v/<versionNumber>
  if (parts.length >= 4 && parts[2] === 'v') {
    const n = Number(parts[3]);
    if (!Number.isInteger(n) || n < 1) return null;
    return { documentId, versionNumber: n };
  }

  // /d/<id>/compare/... — drop compare segments
  if (parts[2] === 'compare') return { documentId };

  return null;
}
