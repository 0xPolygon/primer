// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { extractText } from './extractText.ts';

describe('extractText', () => {
  it('returns an empty string for empty input', () => {
    expect(extractText('')).toBe('');
  });

  it('returns plain text unchanged (trimmed)', () => {
    expect(extractText('<p>Hello world.</p>')).toBe('Hello world.');
  });

  it('puts each paragraph on its own line', () => {
    const html = '<p>First.</p><p>Second.</p>';
    expect(extractText(html)).toBe('First.\nSecond.');
  });

  it('emits one line per list item', () => {
    const html = '<ul><li>One</li><li>Two</li><li>Three</li></ul>';
    expect(extractText(html)).toBe('One\nTwo\nThree');
  });

  it('emits one line per table row', () => {
    const html = '<table><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table>';
    expect(extractText(html)).toBe('AB\nCD');
  });

  it('preserves internal newlines in pre/code blocks', () => {
    const html = '<pre><code>line one\nline two\nline three</code></pre>';
    expect(extractText(html)).toBe('line one\nline two\nline three');
  });

  it('keeps inline code inline', () => {
    expect(extractText('<p>use <code>foo()</code> here</p>')).toBe('use foo() here');
  });

  it('treats <br> as a newline', () => {
    expect(extractText('<p>one<br>two</p>')).toBe('one\ntwo');
  });

  it('emits newlines for heading boundaries', () => {
    const html = '<h1>Title</h1><p>Body.</p>';
    expect(extractText(html)).toBe('Title\nBody.');
  });

  it('drops <script> content entirely', () => {
    const html = '<p>before</p><script>alert("x")</script><p>after</p>';
    expect(extractText(html)).toBe('before\nafter');
  });

  it('drops <style> content entirely', () => {
    const html = '<p>before</p><style>p{color:red}</style><p>after</p>';
    expect(extractText(html)).toBe('before\nafter');
  });

  it('replaces an inline <svg> with [diagram]', () => {
    const html = '<p>before</p><svg><g><text>label</text></g></svg><p>after</p>';
    expect(extractText(html)).toBe('before\n[diagram]\nafter');
  });

  it('replaces a Mermaid-style wrapped <svg> with [diagram]', () => {
    const html = '<div class="primer-mermaid"><svg viewBox="0 0 100 100"><path d="…"/></svg></div>';
    expect(extractText(html)).toBe('[diagram]');
  });

  it('collapses three or more blank lines to two', () => {
    const html = '<p>A</p><p></p><p></p><p></p><p>B</p>';
    expect(extractText(html)).toBe('A\n\nB');
  });

  it('trims leading and trailing whitespace', () => {
    expect(extractText('   <p>x</p>   ')).toBe('x');
  });

  it('handles deeply nested div soup without losing structure', () => {
    const html = '<div><div><div><p>One</p></div></div></div><div><p>Two</p></div>';
    expect(extractText(html)).toBe('One\nTwo');
  });
});
