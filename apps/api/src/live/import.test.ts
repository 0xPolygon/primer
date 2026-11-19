import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildLiveDoc, importMarkdown, importText, type ImportedBlock } from './import.ts';
import { exportMarkdown, plainText } from './export.ts';
import { readBlocks } from './editor.ts';

const fixtures = new URL('./__fixtures__/', import.meta.url);
const fixture = (name: string) => readFileSync(new URL(name, fixtures), 'utf8');
const markdownFixtures = readdirSync(fixtures).filter((f) => f.endsWith('.md'));

const flatten = (blocks: ImportedBlock[]): ImportedBlock[] => blocks.flatMap((b) => [b, ...flatten(b.children)]);
const types = (blocks: ImportedBlock[]) => flatten(blocks).map((b) => b.type);

describe('importMarkdown', () => {
  it('no text is dropped from real-world samples', async () => {
    for (const name of markdownFixtures) {
      const source = fixture(name);
      const imported = await importMarkdown(source);
      const doc = buildLiveDoc(imported, 'markdown', 'doc-1');
      // Everything the editor holds, as Markdown and as source text.
      const held = (await exportMarkdown(doc, 'doc-1')) + readBlocks(doc, 'main').map(plainText).join('\n');
      const words = source.replace(/^---[\s\S]*?\n---\n/, '').match(/[A-Za-z0-9]{3,}/g) ?? [];
      const missing = words.filter((w) => !held.includes(w));
      expect(missing, name).toEqual([]);
    }
  });

  it('raw HTML and footnotes become source blocks with a rendered preview', async () => {
    const { blocks } = await importMarkdown(fixture('html-and-footnotes.md'));
    const sources = blocks.filter((b) => b.type === 'source');
    const markdown = sources.map((b) => b.props!.markdown as string);
    expect(markdown.some((m) => m.includes('[^1]'))).toBe(true);
    expect(markdown.some((m) => m.startsWith('<details>'))).toBe(true);
    expect(markdown.some((m) => m.includes('<kbd>'))).toBe(true);
    const details = sources.find((b) => (b.props!.markdown as string).startsWith('<details>'))!;
    expect(details.props!.previewHtml).toContain('<summary>Click to expand</summary>');
    // Previews never carry scripts.
    for (const b of sources) expect(b.props!.previewHtml).not.toMatch(/<script/i);
    // The heading is still a stock block.
    expect(blocks[0]!.type).toBe('heading');
  });

  it('front matter is parsed into metadata and kept raw', async () => {
    const source = fixture('adr.md');
    const imported = await importMarkdown(source);
    expect(imported.metadata).toMatchObject({ title: 'ADR 7: One apply pipeline', status: 'accepted', tags: ['live', 'pipeline'] });
    expect(imported.frontMatter.startsWith('---\ntitle:')).toBe(true);
    expect(source.startsWith(imported.frontMatter)).toBe(true);
    expect(imported.blocks[0]).toMatchObject({ type: 'heading' });
  });

  it('tables, task lists and code fences map to stock blocks', async () => {
    const adr = types((await importMarkdown(fixture('adr.md'))).blocks);
    expect(adr).toContain('table');
    expect(adr).toContain('codeBlock');
    const notes = await importMarkdown(fixture('notes-gfm.md'));
    const checks = flatten(notes.blocks).filter((b) => b.type === 'checkListItem');
    expect(checks.map((b) => b.props!.checked)).toEqual([true, false, false, true, false]);
    const code = flatten((await importMarkdown(fixture('readme.md'))).blocks).find((b) => b.type === 'codeBlock')!;
    expect(code.props!.language).toBe('sh');
    expect(types(notes.blocks)).toContain('image');
    expect(types(notes.blocks)).toContain('quote');
  });
});

describe('importText', () => {
  it('each paragraph is a paragraph block with its line breaks', () => {
    const { blocks } = importText(fixture('plain.txt'));
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'paragraph', 'paragraph']);
    expect(blocks[1]!.content).toBe('Second paragraph   with  spaces.\n  Indented line.');
  });
});
