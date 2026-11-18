import { describe, it, expect } from 'vitest';
import { markdownToHtml } from './markdown.ts';
import { MARKDOWN_STYLESHEET } from './markdownStylesheet.ts';

describe('markdownToHtml', () => {
  it('returns a full HTML document with body content and stylesheet', () => {
    const r = markdownToHtml('# Hello\n\nWorld.');
    expect(r.html.startsWith('<!doctype html>')).toBe(true);
    expect(r.html).toContain(MARKDOWN_STYLESHEET);
    expect(r.html).toContain('<h1>Hello</h1>');
    expect(r.html).toContain('<p>World.</p>');
    expect(r.html).toContain('data-theme="light"');
    expect(r.html).toContain('class="primer-md"');
  });

  it('renders GFM tables', () => {
    const md = '| A | B |\n|---|---|\n| 1 | 2 |\n';
    const r = markdownToHtml(md);
    expect(r.html).toContain('<table>');
    expect(r.html).toContain('<th>A</th>');
    expect(r.html).toContain('<td>1</td>');
  });

  it('renders GFM strikethrough', () => {
    const r = markdownToHtml('hello ~~world~~');
    expect(r.html).toContain('<s>world</s>');
  });

  it('renders task list checkboxes', () => {
    const r = markdownToHtml('- [ ] todo\n- [x] done\n');
    expect(r.html).toContain('type="checkbox"');
    expect(r.html).toContain('checked');
    expect(r.html).toContain('contains-task-list');
  });

  it('autolinks bare URLs', () => {
    const r = markdownToHtml('See https://example.com for details.');
    expect(r.html).toContain('<a href="https://example.com">https://example.com</a>');
  });

  it('renders fenced code blocks', () => {
    const r = markdownToHtml('```\nconst x = 1;\n```\n');
    expect(r.html).toContain('<pre>');
    expect(r.html).toContain('const x = 1;');
  });

  it('escapes raw HTML in the source (html: false enforced)', () => {
    const r = markdownToHtml('Hello <script>alert(1)</script>\n');
    expect(r.html).not.toContain('<script>alert(1)</script>');
    expect(r.html).toContain('&lt;script&gt;');
  });

  it('strips frontmatter from output and extracts title', () => {
    const md = '---\ntitle: My Report\n---\n\n# Body\n';
    const r = markdownToHtml(md);
    expect(r.frontmatterTitle).toBe('My Report');
    expect(r.html).not.toContain('title: My Report');
    expect(r.html).not.toContain('---');
    expect(r.html).toContain('<h1>Body</h1>');
  });

  it('returns frontmatterTitle null when no frontmatter present', () => {
    const r = markdownToHtml('# Just a heading\n');
    expect(r.frontmatterTitle).toBeNull();
  });

  it('returns frontmatterTitle null when title is missing from frontmatter', () => {
    const r = markdownToHtml('---\nauthor: someone\n---\n\n# Hi\n');
    expect(r.frontmatterTitle).toBeNull();
  });

  it('returns frontmatterTitle null when title is not a string', () => {
    const r = markdownToHtml('---\ntitle: 42\n---\n\n# Hi\n');
    expect(r.frontmatterTitle).toBeNull();
  });

  it('reports empty body when input is whitespace-only', () => {
    const r = markdownToHtml('   \n\n  ');
    expect(r.bodyIsEmpty).toBe(true);
  });

  it('reports empty body when only frontmatter is present', () => {
    const r = markdownToHtml('---\ntitle: x\n---\n');
    expect(r.bodyIsEmpty).toBe(true);
  });

  it('does not report empty body for a real document', () => {
    const r = markdownToHtml('Hello.');
    expect(r.bodyIsEmpty).toBe(false);
  });

  it('does not execute a `---js` frontmatter block (gray-matter JS engine disabled)', () => {
    const marker = `__primer_rce_marker_${Date.now()}`;
    const malicious = [
      '---js',
      `(globalThis.${marker} = "executed", { title: "owned" })`,
      '---',
      '# Body',
    ].join('\n');

    const r = markdownToHtml(malicious);

    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    delete (globalThis as Record<string, unknown>)[marker];
    // The block is inert data, not a title, and the body still renders.
    expect(r.frontmatterTitle).toBeNull();
    expect(r.html).toContain('<h1>Body</h1>');
  });

  it('does not execute a `---javascript` frontmatter block', () => {
    const marker = `__primer_rce_marker_js_${Date.now()}`;
    const malicious = [
      '---javascript',
      `(globalThis.${marker} = "executed", {})`,
      '---',
      '# Body',
    ].join('\n');

    markdownToHtml(malicious);

    expect((globalThis as Record<string, unknown>)[marker]).toBeUndefined();
    delete (globalThis as Record<string, unknown>)[marker];
  });

  it('still parses `---json` frontmatter', () => {
    const r = markdownToHtml('---json\n{"title":"From JSON"}\n---\n\n# Body\n');
    expect(r.frontmatterTitle).toBe('From JSON');
    expect(r.html).toContain('<h1>Body</h1>');
  });
});
