import { describe, it, expect } from 'vitest';
import { sanitizeUploadedHtml } from './sanitize.ts';

describe('sanitizeUploadedHtml — dangerous content', () => {
  it('removes <iframe>', () => {
    const out = sanitizeUploadedHtml('<p>hi</p><iframe src="x"></iframe>');
    expect(out).toContain('<p>hi</p>');
    expect(out).not.toContain('<iframe');
  });

  it('removes <meta http-equiv="refresh">', () => {
    const out = sanitizeUploadedHtml(
      '<html><head><meta http-equiv="refresh" content="0;url=evil"></head><body>ok</body></html>'
    );
    expect(out).not.toContain('http-equiv');
  });

  it('matches http-equiv case-insensitively', () => {
    const out = sanitizeUploadedHtml(
      '<html><head><meta HTTP-EQUIV="Refresh" content="0;url=evil"></head><body>ok</body></html>'
    );
    expect(out.toLowerCase()).not.toContain('http-equiv');
  });

  it('strips <script>, <form>, inline event handlers, <object>, <embed>, javascript: URIs', () => {
    const input = `<html><body>
      <script>alert(1)</script>
      <form action="/x" onsubmit="return false"><input name="a"></form>
      <div onclick="boom()">click</div>
      <object data="x"></object>
      <embed src="x">
      <a href="javascript:alert(1)">x</a>
      <img src="x" onerror="alert(1)">
    </body></html>`;
    const out = sanitizeUploadedHtml(input);
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<form');
    expect(out).not.toContain('onsubmit');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('<object');
    expect(out).not.toContain('<embed');
    expect(out).not.toContain('onerror');
    expect(out).not.toMatch(/javascript:/i);
  });

  it('preserves safe content: headings, paragraphs, links, images', () => {
    const input = `<h1>Title</h1>
      <p>Body with <strong>emphasis</strong>.</p>
      <a href="https://example.com">link</a>
      <img src="https://example.com/x.png" alt="x">
      <ul><li>one</li><li>two</li></ul>`;
    const out = sanitizeUploadedHtml(input);
    expect(out).toContain('<h1>Title</h1>');
    expect(out).toContain('<strong>emphasis</strong>');
    expect(out).toContain('href="https://example.com"');
    expect(out).toContain('src="https://example.com/x.png"');
    expect(out).toContain('alt="x"');
    expect(out).toContain('<li>one</li>');
  });
});

describe('sanitizeUploadedHtml — embedded <style> blocks', () => {
  it('preserves <style> blocks and their CSS rules', () => {
    const css =
      ':root { --bg: #fff; }\n.card { background: var(--bg); padding: 12px; }';
    const out = sanitizeUploadedHtml(`<style>${css}</style><div class="card">hi</div>`);
    expect(out).toContain('<style>');
    expect(out).toContain('--bg: #fff');
    expect(out).toContain('.card { background: var(--bg)');
  });

  it('preserves a <style> block that lives inside <head>', () => {
    const input =
      '<html><head><style>body { color: red; }</style></head><body><p>hi</p></body></html>';
    const out = sanitizeUploadedHtml(input);
    expect(out).toContain('body { color: red; }');
  });

  it('strips dangerous CSS: expression()', () => {
    const out = sanitizeUploadedHtml(
      '<style>.x { width: expression(alert(1)); color: red; }</style>'
    );
    expect(out).not.toMatch(/expression\s*\(/i);
    expect(out).toContain('color: red');
  });

  it('strips dangerous CSS: url(javascript:...)', () => {
    const out = sanitizeUploadedHtml(
      '<style>.x { background: url(javascript:alert(1)); }</style>'
    );
    expect(out).not.toMatch(/javascript:/i);
  });

  it('strips dangerous CSS: behavior and -moz-binding', () => {
    const out = sanitizeUploadedHtml(
      '<style>.x { behavior: url(#evil); -moz-binding: url(evil.xml); color: red; }</style>'
    );
    expect(out).not.toMatch(/behavior\s*:/i);
    expect(out).not.toMatch(/-moz-binding/i);
    expect(out).toContain('color: red');
  });

  it('strips @import directives from <style>', () => {
    const out = sanitizeUploadedHtml(
      '<style>@import url("https://evil.example/x.css"); .x { color: red; }</style>'
    );
    expect(out).not.toMatch(/@import/i);
    expect(out).toContain('color: red');
  });
});

describe('sanitizeUploadedHtml — inline SVG', () => {
  it('preserves <svg> with structural children', () => {
    const input =
      '<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">' +
      '<g><rect x="0" y="0" width="50" height="50" fill="#670de5"/>' +
      '<line x1="0" y1="0" x2="100" y2="100" stroke="#000" stroke-width="2"/>' +
      '<text x="10" y="20" font-family="monospace" font-size="12" text-anchor="middle">hi</text>' +
      '</g></svg>';
    const out = sanitizeUploadedHtml(input);
    expect(out).toContain('<svg');
    expect(out).toContain('<rect');
    expect(out).toContain('<line');
    expect(out).toContain('<text');
    expect(out).toContain('viewBox="0 0 100 100"');
  });

  it('preserves marker-end / marker-mid / marker-start references on lines and paths', () => {
    const input =
      '<svg viewBox="0 0 10 10"><defs><marker id="ah"><path d="M0,0 L7,3 L0,6 Z"/></marker></defs>' +
      '<line x1="0" y1="0" x2="10" y2="10" marker-end="url(#ah)" marker-start="url(#ah)" marker-mid="url(#ah)"/></svg>';
    const out = sanitizeUploadedHtml(input);
    expect(out).toContain('marker-end="url(#ah)"');
    expect(out).toContain('marker-start="url(#ah)"');
    expect(out).toContain('marker-mid="url(#ah)"');
  });

  it('preserves <path d="..."> and mixed-case SVG element names', () => {
    const input =
      '<svg viewBox="0 0 10 10"><defs>' +
      '<linearGradient id="g"><stop offset="0%" stop-color="#000"/></linearGradient>' +
      '<marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">' +
      '<path d="M0,0 L7,3 L0,6 Z" fill="#670de5"/>' +
      '</marker></defs></svg>';
    const out = sanitizeUploadedHtml(input);
    expect(out).toContain('linearGradient');
    expect(out).toContain('markerWidth="9"');
    expect(out).toContain('refX="7"');
    expect(out).toContain('orient="auto"');
    expect(out).toContain('<path');
    expect(out).toContain('d="M0,0 L7,3 L0,6 Z"');
  });

  it('strips <script> inside SVG', () => {
    const out = sanitizeUploadedHtml(
      '<svg><script>alert(1)</script><rect width="10" height="10"/></svg>'
    );
    expect(out).not.toContain('<script');
    expect(out).toContain('<rect');
  });

  it('strips event handlers on SVG elements', () => {
    const out = sanitizeUploadedHtml(
      '<svg><rect onclick="alert(1)" width="10" height="10"/></svg>'
    );
    expect(out).not.toContain('onclick');
    expect(out).toContain('<rect');
  });

  it('drops <foreignObject> (known XSS vector)', () => {
    const out = sanitizeUploadedHtml(
      '<svg><foreignObject><div>hi</div></foreignObject></svg>'
    );
    expect(out).not.toContain('<foreignObject');
  });
});

describe('sanitizeUploadedHtml — document structure preservation', () => {
  it('preserves data-* attributes on elements', () => {
    const out = sanitizeUploadedHtml('<div data-theme="light" data-foo="bar">x</div>');
    expect(out).toContain('data-theme="light"');
    expect(out).toContain('data-foo="bar"');
  });

  it('preserves <html> data-theme and <head> with charset meta', () => {
    const input =
      '<!doctype html><html data-theme="light" lang="en"><head>' +
      '<meta charset="utf-8"><title>Doc</title><style>p{color:red}</style>' +
      '</head><body><p>hi</p></body></html>';
    const out = sanitizeUploadedHtml(input);
    expect(out).toContain('data-theme="light"');
    expect(out).toContain('<title>Doc</title>');
    expect(out).toContain('p{color:red}');
  });
});
