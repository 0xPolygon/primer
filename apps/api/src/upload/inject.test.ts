import { describe, it, expect } from 'vitest';
import { parse, serialize } from 'parse5';
import { injectCompanionScript } from './inject.ts';

function inject(html: string): string {
  const doc = parse(html);
  injectCompanionScript(doc);
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
