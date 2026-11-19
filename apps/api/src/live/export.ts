import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as Y from 'yjs';
import { readBlocks, serverEditor, type PrimerBlock } from './editor.ts';
import { MAIN_TAB, tabFragmentName, tabsOf, type Tab } from './reach.ts';
import { sourcePreview } from './import.ts';
import { groupVersion, pmDocOf, trustedMeta, trustedSources } from './sources.ts';

/**
 * The document as Markdown (M2b.2): untouched groups are their source lines,
 * byte for byte; only changed or new blocks are serialised. An untouched
 * document exports exactly the uploaded file. Tabs after `main` follow in
 * order, each under a `# <title>` heading.
 */
export async function exportMarkdown(doc: Y.Doc, documentId: string): Promise<string> {
  const tabs: string[] = [];
  for (const tab of tabsOf(doc)) {
    const parts = planTab(doc, documentId, tab.id);
    tabs.push(assemble(parts, await Promise.all(parts.map((p) => (p.kind === 'run' ? markdownOf(p.run) : null)))));
  }
  return joinTabs(tabsOf(doc), tabs, (title) => `# ${title}`);
}

/** The document as plain text, by the same rule; tabs follow under their title. */
export function exportText(doc: Y.Doc, documentId: string): string {
  const tabs = tabsOf(doc).map((tab) => {
    const parts = planTab(doc, documentId, tab.id);
    return assemble(parts, parts.map((p) => (p.kind === 'run' ? p.run.map(plainText).join('\n\n') : null)));
  });
  return joinTabs(tabsOf(doc), tabs, (title) => title);
}

/** Main's text, then each later tab under its heading, a blank line between. */
function joinTabs(tabs: Tab[], texts: string[], heading: (title: string) => string): string {
  let out = texts[0] ?? '';
  tabs.slice(1).forEach((tab, k) => {
    if (out.length > 0) out = out.replace(/\n*$/, '\n\n');
    const body = texts[k + 1]!.replace(/\n+$/, '');
    out += heading(oneLine(tab.title) || 'Untitled') + '\n' + (body ? `\n${body}\n` : '');
  });
  return out;
}

function oneLine(title: string): string {
  return title.replace(/\s+/g, ' ').trim();
}

/**
 * The static rendering (C11 `static.html`): BlockNote's full HTML inside its
 * own container, with its stylesheet inlined. Source blocks show a preview
 * rendered again from their Markdown (the stored preview is editor-writable).
 * Tabs after `main` follow under their titles. Shares, previews, print and
 * email all use this.
 */
export async function exportHtml(doc: Y.Doc, title = ''): Promise<string> {
  let body = '';
  for (const tab of tabsOf(doc)) {
    if (tab.id !== MAIN_TAB) body += `<h1 class="primer-tab-title">${escapeHtml(oneLine(tab.title) || 'Untitled')}</h1>`;
    body += await htmlOf(readBlocks(doc, tab.id));
  }
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<title>${escapeHtml(title)}</title><style>${blocknoteCss()}</style></head>` +
    `<body><div class="bn-root bn-container"><div class="bn-default-styles">${body}</div></div></body></html>`
  );
}

type Part =
  | { kind: 'head' | 'group'; text: string }
  | { kind: 'run'; run: PrimerBlock[]; gap: string };

/**
 * Walks a tab's top-level blocks in order. A block that starts a source group
 * whose blocks are all still there, contiguous and unchanged (and whose
 * reference definitions are too) emits the group's slice and gap, provided
 * the server signed the entry at import for this document. Anything
 * else is a run to serialise, up to the next group start, keeping the
 * original gap after it when the run starts a group.
 */
function planTab(doc: Y.Doc, documentId: string, tabId: string): Part[] {
  const blocks = readBlocks(doc, tabId);
  const pm = pmDocOf(doc.getXmlFragment(tabFragmentName(tabId)));
  const sources = trustedSources(doc, documentId);
  const index = new Map(blocks.map((b, i) => [b.id, i]));

  const intact = (key: string): boolean => {
    const entry = sources.get(key)!;
    const at = index.get(key);
    if (at === undefined) return false;
    if (!entry.groupIds.every((id, k) => blocks[at + k]?.id === id)) return false;
    return groupVersion(pm, entry.groupIds) === entry.version;
  };
  const intactKeys = new Set([...sources.keys()].filter(intact));
  const definers = new Map<string, string[]>();
  for (const [key, entry] of sources) for (const label of entry.defines) definers.set(label, [...(definers.get(label) ?? []), key]);
  const verbatim = (key: string): boolean =>
    intactKeys.has(key) && sources.get(key)!.refs.every((label) => (definers.get(label) ?? []).every((k) => intactKeys.has(k)));

  const parts: Part[] = [];
  if (tabId === MAIN_TAB) {
    const meta = trustedMeta(doc, documentId);
    parts.push({ kind: 'head', text: meta.frontMatter + meta.lead });
  }
  for (let i = 0; i < blocks.length; ) {
    const key = blocks[i]!.id;
    const entry = sources.get(key);
    if (entry && verbatim(key)) {
      parts.push({ kind: 'group', text: entry.slice + entry.gap });
      i += entry.groupIds.length;
      continue;
    }
    let j = i + 1;
    while (j < blocks.length && !sources.has(blocks[j]!.id)) j++;
    parts.push({ kind: 'run', run: blocks.slice(i, j), gap: entry?.gap ?? (j === blocks.length ? '' : '\n') });
    i = j;
  }
  return parts;
}

/** Joins the parts; `texts[k]` is the serialisation of run `k`. */
function assemble(parts: Part[], texts: (string | null)[]): string {
  let out = '';
  let afterGroup = false;
  parts.forEach((part, k) => {
    if (part.kind !== 'run') {
      out += part.text;
      afterGroup ||= part.kind === 'group';
      return;
    }
    const text = texts[k]!.replace(/\n+$/, '');
    if (text.trim().length === 0) return; // an empty block (an editor's trailing paragraph) adds nothing
    // A changed group starts a paragraph of its own.
    if (afterGroup) out += out.endsWith('\n\n') ? '' : out.endsWith('\n') ? '\n' : '\n\n';
    out += text + '\n' + part.gap;
    afterGroup = true;
  });
  return out;
}

/** Changed blocks as Markdown. Source blocks are their (edited) Markdown. */
async function markdownOf(blocks: PrimerBlock[]): Promise<string> {
  const out: string[] = [];
  for (const segment of segments(blocks)) {
    out.push(
      isSource(segment[0]!)
        ? segment.map((b) => String((b.props as { markdown: string }).markdown).replace(/\n+$/, '')).join('\n\n')
        : (await serverEditor().blocksToMarkdownLossy(segment as never)).replace(/\n+$/, ''),
    );
  }
  return out.filter((s) => s.length > 0).join('\n\n');
}

async function htmlOf(blocks: PrimerBlock[]): Promise<string> {
  const out: string[] = [];
  for (const segment of segments(blocks)) {
    out.push(
      isSource(segment[0]!)
        ? segment.map((b) => `<div class="primer-source">${sourcePreview(String((b.props as { markdown: string }).markdown))}</div>`).join('')
        : await serverEditor().blocksToFullHTML(segment as never),
    );
  }
  return out.join('');
}

/** Runs of consecutive blocks that are all `source` blocks or all not. */
function segments(blocks: PrimerBlock[]): PrimerBlock[][] {
  const out: PrimerBlock[][] = [];
  for (const block of blocks) {
    const last = out[out.length - 1];
    if (last && isSource(last[0]!) === isSource(block)) last.push(block);
    else out.push([block]);
  }
  return out;
}

function isSource(block: PrimerBlock): boolean {
  return block.type === 'source';
}

/** A block's text, hard breaks as newlines, children indented below it. */
export function plainText(block: PrimerBlock): string {
  const inline = (content: unknown): string => {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) {
      const table = content as { type?: string; rows?: { cells: unknown[] }[] } | undefined;
      if (table?.type === 'tableContent') {
        return (table.rows ?? [])
          .map((row) => row.cells.map((c) => inline(typeof c === 'object' && c && 'content' in c ? (c as { content: unknown }).content : c)).join('\t'))
          .join('\n');
      }
      return '';
    }
    return (content as { type: string; text?: string; content?: unknown }[])
      .map((n) => (n.type === 'text' ? (n.text ?? '') : n.type === 'link' ? inline(n.content) : ''))
      .join('');
  };
  const own = isSource(block) ? String((block.props as { markdown: string }).markdown).replace(/\n+$/, '') : inline(block.content);
  const children = (block.children as PrimerBlock[]).map(plainText).filter((t) => t.length > 0);
  return [own, ...children].filter((t) => t.length > 0).join('\n');
}

let css: string | null = null;
function blocknoteCss(): string {
  css ??= readFileSync(createRequire(import.meta.url).resolve('@blocknote/core/style.css'), 'utf8');
  return css;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
