import type { ThreadDTO } from '@polygonlabs/primer-api-types';
import { formatThreadsAsMarkdown } from './exportComments.ts';

export const NOTEBOOKLM_URL = 'https://notebooklm.google.com/';

/**
 * Convert a version's HTML into Markdown that NotebookLM can ingest as a
 * "Copied text" or uploaded .md source.
 *
 * Unlike extractText (built for line-level diffing), this keeps the
 * structure a reader — or a podcast script — leans on: headings become
 * `#` lines (shifted down one level, since the source already carries the
 * document title as its H1), lists keep bullets and nesting, tables become
 * pipe rows, and code stays fenced. <script>/<style> are dropped, so text
 * an artifact only draws at runtime (charts, JS-built tables) is not
 * captured. Inline <svg> collapses to `[diagram]`, keeping its <title> or
 * aria-label when it has one.
 */
export function htmlToSourceMarkdown(html: string): string {
  if (html.trim() === '') return '';
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out: string[] = [];
  walk(doc.body, out, { listDepth: 0, inItem: false });
  return tidy(out.join(''));
}

// Indentation for nested list items is emitted as this sentinel so the
// per-line trim in tidy() doesn't eat it; it becomes two spaces at the end.
const INDENT = '\u0001';
const FENCE = '```';

const DROP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD']);
const PARAGRAPH_TAGS = new Set([
  'P',
  'BLOCKQUOTE',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'MAIN',
  'ASIDE',
  'NAV',
  'FIGURE',
  'DETAILS',
  'DL',
]);
const LINE_TAGS = new Set(['DIV', 'FIGCAPTION', 'SUMMARY', 'DT', 'DD', 'CAPTION']);

interface WalkState {
  listDepth: number;
  inItem: boolean;
}

function walk(node: Node, out: string[], state: WalkState): void {
  if (node.nodeType === Node.TEXT_NODE) {
    out.push((node.textContent ?? '').replace(/\s+/g, ' '));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;
  const el = node as Element;
  const tag = el.tagName.toUpperCase();

  if (DROP_TAGS.has(tag)) return;

  const heading = /^H([1-6])$/.exec(tag);
  if (heading) {
    const level = Math.min(Number(heading[1]) + 1, 6);
    const text = inlineText(el);
    if (text) out.push(`\n\n${'#'.repeat(level)} ${text}\n\n`);
    return;
  }

  switch (tag) {
    case 'SVG': {
      const label =
        el.getAttribute('aria-label')?.trim() ||
        el.querySelector('title')?.textContent?.trim() ||
        '';
      out.push(label ? `\n[diagram: ${label}]\n` : '\n[diagram]\n');
      return;
    }
    case 'IMG': {
      const alt = el.getAttribute('alt')?.trim();
      if (alt) out.push(`[image: ${alt}]`);
      return;
    }
    case 'BR':
      out.push('\n');
      return;
    case 'HR':
      out.push('\n\n---\n\n');
      return;
    case 'PRE':
      out.push(`\n\n${FENCE}\n${(el.textContent ?? '').replace(/\n+$/, '')}\n${FENCE}\n\n`);
      return;
    case 'TABLE':
      out.push(`\n\n${tableToMarkdown(el)}\n\n`);
      return;
    case 'LI': {
      const ordered = el.parentElement?.tagName.toUpperCase() === 'OL';
      const marker = ordered ? `${listIndex(el)}.` : '-';
      out.push(`\n${INDENT.repeat(Math.max(state.listDepth - 1, 0))}${marker} `);
      const itemState = { ...state, inItem: true };
      for (const child of Array.from(el.childNodes)) walk(child, out, itemState);
      return;
    }
  }

  const isList = tag === 'UL' || tag === 'OL';
  if (isList) {
    // Each item opens its own line; a nested list continues its parent
    // item, so only a top-level list gets paragraph spacing around it.
    const spacing = state.listDepth > 0 ? '' : '\n\n';
    out.push(spacing);
    const listState = { listDepth: state.listDepth + 1, inItem: false };
    for (const child of Array.from(el.childNodes)) walk(child, out, listState);
    out.push(spacing);
    return;
  }

  // Inside a list item, block wrappers (the <p> of a "loose" Markdown list)
  // stay on the item's line so the marker isn't left on its own.
  const blockBreak = PARAGRAPH_TAGS.has(tag) ? '\n\n' : LINE_TAGS.has(tag) ? '\n' : '';
  const boundary = blockBreak && state.inItem ? ' ' : blockBreak;
  out.push(boundary);
  for (const child of Array.from(el.childNodes)) walk(child, out, state);
  out.push(boundary);
}

function inlineText(el: Element): string {
  return (el.textContent ?? '').replace(/\s+/g, ' ').trim();
}

function listIndex(li: Element): number {
  const start = Number(li.parentElement?.getAttribute('start') ?? '1') || 1;
  let i = 0;
  for (let sib = li.previousElementSibling; sib; sib = sib.previousElementSibling) {
    if (sib.tagName.toUpperCase() === 'LI') i++;
  }
  return start + i;
}

function tableToMarkdown(table: Element): string {
  const rows = Array.from(table.querySelectorAll('tr')).filter(
    // Skip rows that belong to a nested table; it's flattened into its cell.
    (tr) => tr.closest('table') === table,
  );
  const grid = rows
    .map((tr) =>
      Array.from(tr.children)
        .filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
        // Escape backslashes first so a literal "\|" can't cancel the pipe escape.
        .map((c) => inlineText(c).replace(/\\/g, '\\\\').replace(/\|/g, '\\|')),
    )
    .filter((cells) => cells.length > 0);
  if (grid.length === 0) return '';
  const width = Math.max(...grid.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array<string>(width - r.length).fill('')];
  const lines = grid.map((r) => `| ${pad(r).join(' | ')} |`);
  lines.splice(1, 0, `|${' --- |'.repeat(width)}`);
  return lines.join('\n');
}

/** Trim each line and squeeze repeated spaces (outside code fences),
 *  restore list indentation, and collapse runs of blank lines to one. */
function tidy(raw: string): string {
  let inFence = false;
  const lines = raw.split('\n').map((line) => {
    if (line.trim() === FENCE) {
      inFence = !inFence;
      return FENCE;
    }
    if (inFence) return line;
    return line.trim().replace(/ {2,}/g, ' ').replace(new RegExp(INDENT, 'g'), '  ');
  });
  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export interface NotebookLmSourceInput {
  title: string;
  description: string | null;
  url: string;
  versionNumber: number;
  html: string;
  /** Threads to append as reviewer discussion; empty or omitted skips the section. */
  threads?: ThreadDTO[];
  now?: Date;
}

/** Assemble the full source: title, description, provenance line, the
 *  document body, and (optionally) its comment threads. */
export function buildNotebookLmSource({
  title,
  description,
  url,
  versionNumber,
  html,
  threads = [],
  now = new Date(),
}: NotebookLmSourceInput): string {
  const parts: string[] = [`# ${title}`];
  if (description?.trim()) parts.push(description.trim());
  parts.push(`Source: ${url} (version ${versionNumber}, exported ${now.toISOString().slice(0, 10)})`);
  const body = htmlToSourceMarkdown(html);
  if (body) parts.push('---', body);
  if (countLiveComments(threads) > 0) {
    parts.push('---', formatThreadsAsMarkdown({ title }, { versionNumber }, threads, now).trim());
  }
  return `${parts.join('\n\n')}\n`;
}

/** Comments that would appear in the export (tombstones excluded). */
export function countLiveComments(threads: ThreadDTO[]): number {
  return threads.reduce(
    (acc, t) => acc + t.comments.filter((c) => c.deletedAt === null).length,
    0,
  );
}

export function countWords(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}
