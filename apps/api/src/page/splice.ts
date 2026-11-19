// Splice-back (M6.2): people's page text, written into the stamped source at
// each pid's span. On demand only (export, checkpoint, agent reads). A pid
// whose text equals its stamped text keeps its bytes, so an untouched page is
// the stamped source byte for byte.
import { readPids, type PidInfo } from './stamp.ts';

export function escapeText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\n/g, '<br>');
}

/** Replaces each span (non-overlapping) with its html, in one pass. */
export function spliceSpans(source: string, replacements: { span: [number, number]; html: string }[]): string {
  const parts: string[] = [];
  let at = 0;
  for (const r of [...replacements].sort((a, b) => a.span[0] - b.span[0])) {
    parts.push(source.slice(at, r.span[0]), r.html);
    at = r.span[1];
  }
  parts.push(source.slice(at));
  return parts.join('');
}

/** `texts` maps pid to current text; pids it lacks keep their bytes. */
export function splicePage(stamped: string, texts: Map<string, string>, pids: PidInfo[] = readPids(stamped)): string {
  return spliceSpans(
    stamped,
    pids.filter((p) => texts.has(p.pid) && texts.get(p.pid) !== p.text).map((p) => ({ span: p.span, html: escapeText(texts.get(p.pid)!) })),
  );
}
