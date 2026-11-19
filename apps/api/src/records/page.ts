import type { PagePolicy } from '@polygonlabs/primer-api-types';

// A page reads records only if it opts in, in its <head>:
//   <meta name="primer-records" content="read">
// The opt-in is read from the stored page itself whenever the page is served
// or described (versionContent.ts), so the CSP a page runs under and the host's
// decision to bind records to it always come from the same bytes.
const META_RE = /<meta\b[^>]*>/gi;

export function readsRecords(html: string): boolean {
  const end = html.search(/<\/head\s*>/i);
  const head = end === -1 ? html : html.slice(0, end);
  for (const tag of head.match(META_RE) ?? []) {
    const name = /\bname\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    const content = /\bcontent\s*=\s*["']?([^"'\s>]+)/i.exec(tag)?.[1];
    if (name?.toLowerCase() === 'primer-records' && content?.toLowerCase() === 'read') return true;
  }
  return false;
}

export function pagePolicyOf(html: string): PagePolicy {
  return readsRecords(html) ? 'records' : 'standard';
}
