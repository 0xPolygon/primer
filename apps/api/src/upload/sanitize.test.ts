import { describe, it, expect } from 'vitest';
import { parse, serialize } from 'parse5';
import { stripDisallowedElements } from './sanitize.ts';

function round(html: string): string {
  const doc = parse(html);
  stripDisallowedElements(doc);
  return serialize(doc);
}

describe('stripDisallowedElements', () => {
  it('removes nested <iframe>', () => {
    const out = round('<html><body><p>hi</p><iframe src="x"></iframe></body></html>');
    expect(out).toContain('<p>hi</p>');
    expect(out).not.toContain('<iframe');
  });

  it('removes <meta http-equiv="refresh">', () => {
    const out = round(
      '<html><head><meta http-equiv="refresh" content="0;url=evil"></head><body>ok</body></html>'
    );
    expect(out).not.toContain('http-equiv');
  });

  it('matches http-equiv case-insensitively', () => {
    const out = round(
      '<html><head><meta HTTP-EQUIV="Refresh" content="0;url=evil"></head><body>ok</body></html>'
    );
    expect(out.toLowerCase()).not.toContain('http-equiv');
  });

  it('preserves <script>, <form>, inline event handlers, <canvas>, and SVG', () => {
    const input = `<html><body>
      <script>alert(1)</script>
      <form action="/x" onsubmit="return false"><input name="a"></form>
      <div onclick="boom()">click</div>
      <canvas id="c"></canvas>
      <svg><g><rect /></g></svg>
    </body></html>`;
    const out = round(input);
    expect(out).toContain('<script>alert(1)</script>');
    expect(out).toContain('<form');
    expect(out).toContain('onsubmit');
    expect(out).toContain('onclick');
    expect(out).toContain('<canvas');
    expect(out).toContain('<svg');
    expect(out).toContain('<rect');
  });

  it('removes only meta tags whose http-equiv is refresh, not other meta tags', () => {
    const out = round(
      '<html><head><meta charset="utf-8"><meta http-equiv="refresh" content="0"></head><body></body></html>'
    );
    expect(out).toContain('charset');
    expect(out).not.toMatch(/http-equiv\s*=\s*["']?refresh/i);
  });
});
