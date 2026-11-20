import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { docUpdates } from '../db/schema.ts';
import { exportHtml, exportMarkdown } from './export.ts';
import { serverEditor } from './editor.ts';
import { buildLiveDoc, importMarkdown } from './import.ts';
import { createLiveDoc, seedBlocks } from './live.testlib.ts';

const DOC_ID = '0190a1b2-0000-7000-8000-00000000000a';
const TARGET = '0190a1b2-0000-7000-8000-00000000000b';

const BLOCKS = [
  { id: 'call', type: 'callout', props: { kind: 'warning' }, content: 'Deploys freeze on Friday.' },
  {
    id: 'cols',
    type: 'columnList',
    children: [
      { id: 'left', type: 'column', children: [{ id: 'l1', type: 'paragraph', content: 'Left side' }] },
      { id: 'right', type: 'column', children: [{ id: 'r1', type: 'paragraph', content: 'Right side' }, { id: 'r2', type: 'heading', props: { level: 2 }, content: 'Below' }] },
    ],
  },
  { id: 'link', type: 'embed', props: { url: 'https://news.example/q3?a=1&b=2' } },
  { id: 'doc', type: 'embed', props: { documentId: TARGET } },
  { id: 'evil', type: 'embed', props: { url: 'javascript:alert(1)' } },
] as never[];

function docOf(blocks: never[]): Y.Doc {
  const doc = new Y.Doc();
  serverEditor().blocksToYXmlFragment(blocks, doc.getXmlFragment('document-store'));
  return doc;
}

describe('callout, column and embed blocks in exports', () => {
  it('Markdown: a callout is a GitHub alert, columns read in order, embeds are links', async () => {
    const md = await exportMarkdown(docOf(BLOCKS), DOC_ID);
    expect(md).toContain('> [!WARNING]');
    expect(md).toContain('> Deploys freeze on Friday.');
    expect(md.indexOf('Left side')).toBeLessThan(md.indexOf('Right side'));
    expect(md.indexOf('Right side')).toBeLessThan(md.indexOf('## Below'));
    expect(md).toContain('https://news.example/q3?a=1&b=2');
    expect(md).toContain(`[Embedded document](/d/${TARGET})`);
    expect(md).not.toContain('javascript:');
  });

  it('static HTML: callout kind and text, side-by-side columns, links only for embeds', async () => {
    const html = await exportHtml(docOf(BLOCKS), 'T');
    expect(html).toContain('data-primer-callout="warning"');
    expect(html).toContain('Deploys freeze on Friday.');
    // No editing controls in a static render.
    expect(html).not.toContain('<select');
    expect(html).not.toContain('primer-columns-add');
    expect(html).toMatch(/data-node-type="columnList"[\s\S]*data-node-type="column"[\s\S]*Left side[\s\S]*data-node-type="column"[\s\S]*Right side/);
    // Embeds carry a link and nothing fetched or resolved: no remote content, no document title.
    expect(html).toContain('<a href="https://news.example/q3?a=1&amp;b=2">');
    expect(html).toContain(`<a href="/d/${TARGET}">Embedded document</a>`);
    // The unsafe link is never an href (BlockNote's inert data-url attribute keeps the raw prop).
    expect(html).not.toMatch(/href="javascript:/);
    expect(html).not.toMatch(/<(img|iframe|script)\b[^>]*src=/);
  });
});

describe('GitHub alerts', () => {
  it('GitHub alert imports as a callout and exports verbatim', async () => {
    const source = [
      '# Release',
      '',
      '> [!WARNING]',
      '> Deploys freeze on **Friday**.',
      '',
      'After the freeze.',
      '',
      '> [!TIP]',
      '> Use the staging link.',
      '',
      '> [!NOTE]',
      '> First paragraph.',
      '>',
      '> Second paragraph.',
      '',
    ].join('\n');
    const imported = await importMarkdown(source);
    const callouts = imported.blocks.filter((b) => b.type === 'callout');
    expect(callouts.map((b) => b.props)).toEqual([{ kind: 'warning' }, { kind: 'success' }]);
    expect(JSON.stringify(callouts[0]!.content)).toContain('Friday');
    // A multi-paragraph alert is more than a callout's inline text holds: it stays a quote, as before.
    expect(imported.blocks.map((b) => b.type)).toEqual(['heading', 'callout', 'paragraph', 'callout', 'quote']);
    const doc = buildLiveDoc(imported, 'markdown', DOC_ID);
    expect(await exportMarkdown(doc, DOC_ID)).toBe(source);
  });

  it('an edited callout exports as an alert again', async () => {
    const imported = await importMarkdown('> [!IMPORTANT]\n> Read this first.\n');
    expect(imported.blocks[0]).toMatchObject({ type: 'callout', props: { kind: 'info' } });
    const md = await serverEditor().blocksToMarkdownLossy([{ ...imported.blocks[0]!, content: 'Read this first, please.' }] as never);
    expect(md).toContain('> [!IMPORTANT]');
    const again = await importMarkdown(md);
    expect(again.blocks[0]).toMatchObject({ type: 'callout', props: { kind: 'info' } });
  });
});

describe('layout blocks in the live document', () => {
  it('blocks inside columns are attributed with their column and column list', async () => {
    const id = await createLiveDoc();
    await seedBlocks(id, BLOCKS as never);
    const rows = await db.select({ touched: docUpdates.touched }).from(docUpdates).where(eq(docUpdates.documentId, id));
    const touched = new Set(rows.flatMap((r) => r.touched ?? []));
    for (const block of ['cols', 'left', 'right', 'l1', 'r2']) expect(touched.has(block), block).toBe(true);
  });
});
