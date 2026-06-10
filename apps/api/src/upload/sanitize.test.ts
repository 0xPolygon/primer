import { describe, it, expect } from 'vitest';
import { sanitizeUploadedHtml } from './sanitize.ts';

describe('sanitizeUploadedHtml', () => {
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
    expect(out).not.toContain('<meta');
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
