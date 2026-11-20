import { describe, expect, it } from 'vitest';
import { calloutKind, embedDocumentId, embedUrl, parseEmbedInput, primerSchema } from '../src/index.ts';

describe('callout, columns and embed blocks', () => {
  it('are in the schema, with columns as layout blocks', () => {
    const specs = primerSchema.blockSpecs;
    expect(Object.keys(specs)).toEqual(expect.arrayContaining(['callout', 'columnList', 'column', 'embed']));
    expect(specs.columnList.config.layoutOnly).toBe(true);
    expect(specs.column.config.layoutOnly).toBe(true);
    expect(specs.column.config.placeable).toBe('namedOnly');
    expect(specs.callout.config.content).toBe('inline');
    expect(specs.embed.config.content).toBe('none');
  });

  it('reads nothing but known kinds, http(s) links and UUIDs from block props', () => {
    expect(calloutKind('warning')).toBe('warning');
    expect(calloutKind('<script>')).toBe('note');
    expect(embedUrl('https://example.com/a?b=1')).toBe('https://example.com/a?b=1');
    for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'not a url', 42]) expect(embedUrl(bad)).toBe('');
    expect(embedDocumentId('0190A1B2-0000-7000-8000-000000000000')).toBe('0190a1b2-0000-7000-8000-000000000000');
    expect(embedDocumentId('../../etc/passwd')).toBe('');
  });

  it('a pasted link to one of our own documents embeds the document, any other link is a card', () => {
    const origin = 'https://primer.example';
    const id = '0190a1b2-0000-7000-8000-000000000000';
    expect(parseEmbedInput(`${origin}/d/${id}`, origin)).toEqual({ url: '', documentId: id });
    expect(parseEmbedInput(`${origin}/d/${id}/v/2`, origin)).toEqual({ url: '', documentId: id });
    expect(parseEmbedInput(`https://other.example/d/${id}`, origin)).toEqual({ url: `https://other.example/d/${id}`, documentId: '' });
    expect(parseEmbedInput('javascript:alert(1)', origin)).toBeNull();
    expect(parseEmbedInput('hello', origin)).toBeNull();
  });
});
