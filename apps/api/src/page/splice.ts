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

/** `texts` maps pid to current text; pids it lacks keep their bytes. */
export function splicePage(stamped: string, texts: Map<string, string>, pids: PidInfo[] = readPids(stamped)): string {
  const changed = pids
    .filter((p) => texts.has(p.pid) && texts.get(p.pid) !== p.text)
    .sort((a, b) => b.span[0] - a.span[0]);
  let out = stamped;
  for (const p of changed) out = out.slice(0, p.span[0]) + escapeText(texts.get(p.pid)!) + out.slice(p.span[1]);
  return out;
}
