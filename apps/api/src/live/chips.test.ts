import { parse } from 'parse5';
import { describe, expect, it } from 'vitest';
import { exportHtml, exportMarkdown, exportText } from './export.ts';
import { renderStatic } from './bundle.ts';
import { createLiveDoc, seedBlocks, withLiveDoc } from './live.testlib.ts';

const ID = '0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
const mention = { type: 'mention', props: { userId: ID, name: 'Ada Lovelace' } };
const date = { type: 'date', props: { date: '2026-11-19' } };
const dropdown = { type: 'dropdown', props: { options: JSON.stringify(['Todo', 'Doing', 'Done']), value: 'Doing' } };

async function chipDoc(): Promise<string> {
  const id = await createLiveDoc();
  await seedBlocks(id, [
    { id: 'p1', type: 'paragraph', content: [{ type: 'text', text: 'Owner ', styles: {} }, mention, { type: 'text', text: ' due ', styles: {} }, date] },
    {
      id: 't1',
      type: 'table',
      content: {
        type: 'tableContent',
        rows: [
          { cells: [[{ type: 'text', text: 'Status', styles: {} }], [{ type: 'text', text: 'When', styles: {} }]] },
          { cells: [[dropdown], [date]] },
        ],
      },
    },
  ] as never);
  return id;
}

describe('inline chips', () => {
  it('a chip in a paragraph and in a table cell survives Markdown, text and the static page', async () => {
    const id = await chipDoc();
    const md = await withLiveDoc(id, (doc) => exportMarkdown(doc, id));
    expect(md).toContain('Owner @Ada Lovelace due 2026-11-19');
    expect(md).toMatch(/\|\s*Doing\s*\|\s*2026-11-19\s*\|/);

    const text = await withLiveDoc(id, (doc) => exportText(doc, id));
    expect(text).toContain('Owner @Ada Lovelace due 2026-11-19');
    expect(text).toContain('Doing\t2026-11-19');

    const { served } = await withLiveDoc(id, (doc) => renderStatic(doc, 'Chips'));
    expect(served).toContain('@Ada Lovelace');
    expect(served).toContain('2026-11-19');
    expect(served).toContain('Doing');
    // Static pages show a chip's text; the editing controls belong to the editor.
    expect(served).not.toMatch(/<(input|select)\b/);
    const html = await withLiveDoc(id, (doc) => exportHtml(doc, 'Chips'));
    expect(html).not.toMatch(/<(input|select)\b/);
  });

  it('a chip carries no email and a forged user id is shown as text, never looked up', async () => {
    const id = await createLiveDoc();
    await seedBlocks(id, [
      { id: 'p1', type: 'paragraph', content: [{ type: 'mention', props: { userId: '../../etc/passwd" onmouseover="x', name: '<img src=x onerror=alert(1)>' } }] },
    ] as never);
    const { served } = await withLiveDoc(id, (doc) => renderStatic(doc, 'Chips'));
    // The forged values are attribute text and chip text; no element or handler comes out of them.
    const elements: { tagName: string; attrs: { name: string }[] }[] = [];
    const walk = (n: { childNodes?: unknown[]; tagName?: string; attrs?: { name: string }[] }) => {
      if (n.tagName) elements.push({ tagName: n.tagName, attrs: n.attrs ?? [] });
      for (const child of (n.childNodes ?? []) as (typeof n)[]) walk(child);
    };
    walk(parse(served));
    expect(elements.some((e) => e.tagName === 'img')).toBe(false);
    expect(elements.some((e) => e.attrs.some((a) => a.name.startsWith('on')))).toBe(false);
    expect(served).toContain('@&lt;img');
  });
});
