import { describe, it, expect } from 'vitest';
import { transformHtml } from './htmlPipeline.ts';
import { STORAGE_POLYFILL_JS } from './storagePolyfill.ts';

describe('transformHtml', () => {
  it('returns serialized HTML with dangerous content stripped, user script preserved, and companion script injected', () => {
    const input =
      '<html><body><h1>Report</h1><iframe src="x"></iframe>' +
      '<script>document.querySelector("h1").click();</script></body></html>';
    const out = transformHtml(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.html).toContain('<h1>Report</h1>');
    expect(out.html).not.toContain('<iframe');
    // User <script> is preserved — the iframe sandbox is the JS defense.
    expect(out.html).toContain('document.querySelector("h1").click();');
    // Companion script is injected by inject.ts after sanitization.
    expect(out.html).toContain('<script src="/companion/v1.js"');
    // Storage polyfill is injected at the top of <head>.
    expect(out.html).toContain(STORAGE_POLYFILL_JS);
    expect(out.html).toMatch(/<head><script>/);
  });

  it('injects a responsive viewport meta when the artifact lacks one', () => {
    const out = transformHtml('<html><head><title>Doc</title></head><body><p>hi</p></body></html>');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.html).toContain('name="viewport"');
    expect(out.html).toContain('content="width=device-width, initial-scale=1"');
  });

  it('does not add a second viewport meta when the artifact already declares one', () => {
    const input =
      '<html><head><meta name="viewport" content="width=1200"><title>Doc</title></head>' +
      '<body><p>hi</p></body></html>';
    const out = transformHtml(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const matches = out.html.match(/name="viewport"/g);
    expect(matches?.length).toBe(1);
    // The author's intentional viewport is preserved untouched.
    expect(out.html).toContain('content="width=1200"');
  });

  it('marks Primer-owned content with data-primer-theme="managed" when themeManaged', () => {
    const input =
      '<!doctype html><html data-theme="light"><head><meta charset="utf-8"></head>' +
      '<body><article class="primer-md"><p>hi</p></article></body></html>';
    const out = transformHtml(input, { themeManaged: true });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // The companion only forces the app theme onto artifacts carrying this
    // marker, so Primer-authored Markdown keeps auto-theming.
    expect(out.html).toMatch(/<html[^>]*data-primer-theme="managed"/);
    // The baked-in default theme survives alongside the marker.
    expect(out.html).toContain('data-theme="light"');
  });

  it('does not mark raw HTML artifacts (default — author owns theme)', () => {
    const input = '<html><body><h1>Report</h1></body></html>';
    const out = transformHtml(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Self-themed HTML manages its own data-theme; the companion must not
    // clobber it, so it carries no ownership marker.
    expect(out.html).not.toContain('data-primer-theme');
  });

  it('returns parse_failed when input is not parseable as HTML', () => {
    const out = transformHtml('');
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error).toBe('parse_failed');
  });

  it('preserves embedded <style> blocks and inline SVG end-to-end', () => {
    const input =
      '<!doctype html><html data-theme="light"><head><meta charset="utf-8">' +
      '<title>Doc</title><style>:root { --x: red; } .card { color: var(--x); }</style>' +
      '</head><body><div class="card">hi</div>' +
      '<svg viewBox="0 0 10 10"><defs>' +
      '<marker id="ah" markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">' +
      '<path d="M0,0 L7,3 L0,6 Z"/></marker></defs>' +
      '<line x1="0" y1="0" x2="10" y2="10" stroke="#000" marker-end="url(#ah)"/>' +
      '</svg></body></html>';
    const out = transformHtml(input);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.html).toContain('<style>');
    expect(out.html).toContain('--x: red');
    expect(out.html).toContain('<svg');
    expect(out.html).toContain('viewBox="0 0 10 10"');
    expect(out.html).toContain('markerWidth="9"');
    expect(out.html).toContain('refX="7"');
    expect(out.html).toContain('d="M0,0 L7,3 L0,6 Z"');
    expect(out.html).toContain('marker-end="url(#ah)"');
    expect(out.html).toContain('data-theme="light"');
    expect(out.html).toContain('<script src="/companion/v1.js"');
    expect(out.html).toContain(STORAGE_POLYFILL_JS);
  });
});
