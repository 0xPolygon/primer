// Host side of page text (M6.3): which pids people may edit in the overlay.
//
// The bridge reports every stamped element's DOM text once, after the page's
// own scripts ran and before the host sets any text. Text a script drew or
// rewrote no longer equals the source text at the pid's span, so that pid is
// read-only: people edit only what the page shows as authored.

/** Whitespace-normalised text, the same rule as the server's `pageText`
 *  (apps/api/src/page/stamp.ts): each line's whitespace runs are one space and
 *  its ends are trimmed. */
export function normalizePageText(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/[ \t\r\f]+/g, ' ').trim())
    .join('\n');
}

/**
 * The pids people may edit: stamped pids the bridge reported with their
 * source text. Pids a script redrew, and pids missing from the page (the
 * sanitizer dropped their element, or a script removed it), are read-only.
 */
export function editablePids(
  stamped: Record<string, string>,
  reported: { pid: string; text: string }[],
): Set<string> {
  const editable = new Set<string>();
  const seen = new Set<string>();
  for (const { pid, text } of reported) {
    if (seen.has(pid)) {
      // A script cloned a stamped element: neither copy is safe to edit.
      editable.delete(pid);
      continue;
    }
    seen.add(pid);
    const source = stamped[pid];
    if (source !== undefined && normalizePageText(text) === normalizePageText(source)) editable.add(pid);
  }
  return editable;
}

/** ProseMirror JSON as y-prosemirror reads a fragment. */
type PmJson = { type: string; text?: string; attrs?: Record<string, unknown>; content?: PmJson[] };

/** A page text fragment's text, by the server's rule (page/text.ts docText):
 *  text blocks joined by `\n`, hard breaks as `\n`. */
export function fragmentText(json: PmJson): string {
  const blocks: string[] = [];
  const walk = (node: PmJson): void => {
    if (isTextblock(node)) {
      blocks.push((node.content ?? []).map((c) => (c.type === 'text' ? (c.text ?? '') : c.type === 'hardBreak' ? '\n' : '')).join(''));
      return;
    }
    for (const child of node.content ?? []) walk(child);
  };
  walk(json);
  return blocks.join('\n');
}

const TEXTBLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'diagram', 'mathBlock', 'tableParagraph', 'quote', 'bulletListItem', 'numberedListItem', 'checkListItem', 'toggleListItem']);
const isTextblock = (node: PmJson) => TEXTBLOCKS.has(node.type);

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The static HTML a `<primer-*>` block shows in the page (read-only; people
 * edit it in the overlay): built from its fragment as text only, so nothing
 * anyone wrote in the block becomes markup.
 */
export function embedHtml(json: PmJson): string {
  const out: string[] = [];
  const walk = (node: PmJson): void => {
    switch (node.type) {
      case 'table': {
        const rows = collect(node, 'tableRow').map(
          (row) =>
            '<tr>' +
            (row.content ?? [])
              .map((cell) => {
                const tag = cell.type === 'tableHeader' ? 'th' : 'td';
                return `<${tag}>${escapeHtml(fragmentText(cell)).replace(/\n/g, '<br>')}</${tag}>`;
              })
              .join('') +
            '</tr>',
        );
        out.push(`<table>${rows.join('')}</table>`);
        return;
      }
      case 'codeBlock':
        out.push(`<pre><code>${escapeHtml(fragmentText(node))}</code></pre>`);
        return;
      case 'diagram':
        out.push(`<pre class="mermaid">${escapeHtml(fragmentText(node))}</pre>`);
        return;
      case 'mathBlock':
        out.push(`<pre class="primer-math">${escapeHtml(fragmentText(node))}</pre>`);
        return;
      default:
        if (isTextblock(node)) {
          const text = fragmentText(node);
          if (text) out.push(`<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`);
          return;
        }
        for (const child of node.content ?? []) walk(child);
    }
  };
  walk(json);
  return out.join('');
}

function collect(node: PmJson, type: string): PmJson[] {
  const found: PmJson[] = [];
  const walk = (n: PmJson) => {
    if (n.type === type) found.push(n);
    else for (const c of n.content ?? []) walk(c);
  };
  walk(node);
  return found;
}
