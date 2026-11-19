import type { PagePolicy, RecordsSnapshot } from '@polygonlabs/primer-api-types';

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

/** The element a checkpoint's page reads its frozen records from (v1.js). */
export const FROZEN_RECORDS_ID = 'primer-records-frozen';

/**
 * A checkpoint's page served with its frozen records (`records.json`), for a
 * page that opted in to records: shares and checkpoint views answer the page's
 * record reads from these, in the page (companion v1.js), never from live
 * records, and refuse writes. Only shared records are ever frozen. The JSON
 * sits in an inert `application/json` script at the top of <head>, with `<`
 * escaped so no text in it can close the element.
 */
export function withFrozenRecords(html: string, snapshot: RecordsSnapshot | null): string {
  if (snapshot === null || !readsRecords(html)) return html;
  const json = JSON.stringify(snapshot).replace(/</g, '\\u003c');
  const tag = `<script type="application/json" id="${FROZEN_RECORDS_ID}">${json}</script>`;
  const head = /<head\b[^>]*>/i.exec(html);
  return head ? html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length) : tag + html;
}
