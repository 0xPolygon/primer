import { describe, it, expect } from 'vitest';
import { parse, serialize } from 'parse5';
import { injectCompanionScript, injectStoragePolyfill } from './inject.ts';
import { STORAGE_POLYFILL_JS } from './storagePolyfill.ts';

function inject(html: string): string {
  const doc = parse(html);
  injectCompanionScript(doc);
  return serialize(doc);
}

function injectPolyfill(html: string): string {
  const doc = parse(html);
  injectStoragePolyfill(doc);
  return serialize(doc);
}

describe('injectCompanionScript', () => {
  it('adds the script tag as the last child of <body>', () => {
    const out = inject('<html><body><p>hi</p></body></html>');
    expect(out).toMatch(
      /<p>hi<\/p><script src="\/companion\/v1\.js" defer=""><\/script><\/body>/
    );
  });

  it('works when source has no explicit <body> (parse5 normalizes)', () => {
    const out = inject('<p>standalone</p>');
    expect(out).toContain('<body>');
    expect(out).toContain('<script src="/companion/v1.js"');
  });

  it('adds exactly one script tag even when called once', () => {
    const out = inject('<html><body></body></html>');
    const matches = out.match(/<script src="\/companion\/v1\.js"/g);
    expect(matches?.length).toBe(1);
  });
});

describe('injectStoragePolyfill', () => {
  it('inserts an inline <script> as the first child of <head>', () => {
    const out = injectPolyfill(
      '<html><head><title>T</title></head><body></body></html>'
    );
    // <head> opens, then immediately our inline <script> (no src/defer/async)
    expect(out).toMatch(/<head><script>/);
    // The <title> still follows, after our script.
    expect(out).toMatch(/<\/script><title>T<\/title>/);
  });

  it('embeds the polyfill source verbatim in the script body', () => {
    const out = injectPolyfill('<html><head></head><body></body></html>');
    expect(out).toContain(STORAGE_POLYFILL_JS);
  });

  it('emits the script without src, defer, or async attributes', () => {
    const out = injectPolyfill('<html><head></head><body></body></html>');
    // Match the polyfill script element (the only one with non-empty body).
    const match = out.match(/<head>(<script[^>]*>)/);
    expect(match).not.toBeNull();
    const openTag = match![1];
    expect(openTag).toBe('<script>');
    expect(openTag).not.toContain('src=');
    expect(openTag).not.toContain('defer');
    expect(openTag).not.toContain('async');
  });

  it('works when source has no explicit <head> (parse5 normalizes)', () => {
    const out = injectPolyfill('<p>standalone</p>');
    expect(out).toContain('<head>');
    expect(out).toContain(STORAGE_POLYFILL_JS);
    // Polyfill belongs in <head>, not <body>.
    expect(out).toMatch(/<head><script>[\s\S]*<\/script><\/head>/);
  });

  it('throws if the document tree has no <head>', () => {
    // parse5 always normalizes a <head>, so synthesize a head-less tree by
    // hand to confirm the guard fires. We construct a minimal doc with an
    // <html> that has no <head> child.
    const doc = parse('<html><body></body></html>');
    const html = doc.childNodes.find(
      (n) => (n as { tagName?: string }).tagName === 'html'
    ) as { childNodes: { tagName?: string }[] } | undefined;
    if (html) {
      html.childNodes = html.childNodes.filter((n) => n.tagName !== 'head');
    }
    expect(() =>
      injectStoragePolyfill(doc as Parameters<typeof injectStoragePolyfill>[0])
    ).toThrow(/no <head>/);
  });
});

describe('injection composition', () => {
  it('produces head-polyfill + body-companion exactly once each', () => {
    const doc = parse('<html><head></head><body><p>hi</p></body></html>');
    injectStoragePolyfill(doc);
    injectCompanionScript(doc);
    const out = serialize(doc);
    // Polyfill is the FIRST child of <head>.
    expect(out).toMatch(/<head><script>/);
    expect(out).toContain(STORAGE_POLYFILL_JS);
    // Companion is the LAST child of <body>.
    expect(out).toMatch(
      /<p>hi<\/p><script src="\/companion\/v1\.js" defer=""><\/script><\/body>/
    );
    // Exactly one of each.
    expect(out.match(/<script src="\/companion\/v1\.js"/g)?.length).toBe(1);
    expect(
      out.match(new RegExp(STORAGE_POLYFILL_JS.split('\n')[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))?.length,
    ).toBe(1);
  });
});
