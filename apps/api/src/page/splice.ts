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

/** Replaces each span (non-overlapping) with its html, highest offset first. */
export function spliceSpans(source: string, replacements: { span: [number, number]; html: string }[]): string {
  let out = source;
  for (const r of [...replacements].sort((a, b) => b.span[0] - a.span[0])) {
    out = out.slice(0, r.span[0]) + r.html + out.slice(r.span[1]);
  }
  return out;
}

/** `texts` maps pid to current text; pids it lacks keep their bytes. */
export function splicePage(stamped: string, texts: Map<string, string>, pids: PidInfo[] = readPids(stamped)): string {
  return spliceSpans(
    stamped,
    pids.filter((p) => texts.has(p.pid) && texts.get(p.pid) !== p.text).map((p) => ({ span: p.span, html: escapeText(texts.get(p.pid)!) })),
  );
}
