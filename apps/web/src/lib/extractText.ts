/**
 * Convert rendered HTML to deterministic plaintext for diffing.
 *
 * Block-level boundaries emit trailing newlines so each paragraph, list
 * item, table row, heading, etc. appears on its own line. <script> and
 * <style> are dropped. <svg> (and descendants) collapses to `[diagram]`
 * — diffing SVG markup is noise.
 */
const BLOCK_TAGS = new Set([
  'P',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'TR',
  'PRE',
  'BLOCKQUOTE',
  'HR',
]);

const DROP_TAGS = new Set(['SCRIPT', 'STYLE']);

export function extractText(html: string): string {
  if (html === '') return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  walk(doc.body, out);
  const joined = out.join('');
  // Collapse 3+ consecutive newlines into exactly 2 (one blank line).
  const collapsed = joined.replace(/\n{3,}/g, '\n\n');
  return collapsed.trim();
}

function walk(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push(node.textContent ?? '');
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const tag = el.tagName.toUpperCase();

  if (DROP_TAGS.has(tag)) return;

  if (tag === 'SVG') {
    out.push('[diagram]\n');
    return;
  }

  if (tag === 'BR') {
    out.push('\n');
    return;
  }

  if (tag === 'PRE') {
    // Preserve internal whitespace verbatim, then a single trailing newline.
    out.push(el.textContent ?? '');
    out.push('\n');
    return;
  }

  for (const child of Array.from(el.childNodes)) {
    walk(child, out);
  }

  if (BLOCK_TAGS.has(tag)) {
    out.push('\n');
  }
}
