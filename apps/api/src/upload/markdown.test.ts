import { describe, it, expect } from 'vitest';
import { splitFrontMatter } from './markdown.ts';

describe('splitFrontMatter', () => {
  it('keeps the raw front matter, parses its data and returns the body', () => {
    const r = splitFrontMatter('---\ntitle: My Report\n---\n\n# Body\n');
    expect(r.frontMatter).toBe('---\ntitle: My Report\n---\n');
    expect(r.data).toEqual({ title: 'My Report' });
    expect(r.body).toBe('\n# Body\n');
  });

  it('has no front matter when none is present', () => {
    expect(splitFrontMatter('# Just a heading\n')).toEqual({ frontMatter: '', data: {}, body: '# Just a heading\n' });
  });

  it('does not execute a `---js` frontmatter block (gray-matter JS engine disabled)', () => {
    const marker = `__primer_rce_marker_${Date.now()}`;
    const malicious = ['---js', `(globalThis.${marker} = "executed", { title: "owned" })`, '---', '# Body'].join('\n');
    const r = splitFrontMatter(malicious);
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    delete (globalThis as Record<string, unknown>)[marker];
    // The block is inert data, and the body is still there.
    expect(r.data).toEqual({});
    expect(r.body).toContain('# Body');
  });

  it('does not execute a `---javascript` frontmatter block', () => {
    const marker = `__primer_rce_marker_js_${Date.now()}`;
    splitFrontMatter(['---javascript', `(globalThis.${marker} = "executed", {})`, '---', '# Body'].join('\n'));
    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    delete (globalThis as Record<string, unknown>)[marker];
  });

  it('still parses `---json` frontmatter', () => {
    expect(splitFrontMatter('---json\n{"title":"From JSON"}\n---\n\n# Body\n').data).toEqual({ title: 'From JSON' });
  });
});
