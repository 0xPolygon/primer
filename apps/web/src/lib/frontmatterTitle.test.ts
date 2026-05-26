import { describe, it, expect } from 'vitest';
import { extractFrontmatterTitle } from './frontmatterTitle.ts';

describe('extractFrontmatterTitle', () => {
  it('returns null when input has no frontmatter', () => {
    expect(extractFrontmatterTitle('# Just a heading\n')).toBeNull();
  });

  it('returns null when input does not start with ---', () => {
    expect(extractFrontmatterTitle('  ---\ntitle: x\n---\n')).toBeNull();
  });

  it('extracts a plain unquoted title', () => {
    const src = '---\ntitle: My Report\n---\n\n# body';
    expect(extractFrontmatterTitle(src)).toBe('My Report');
  });

  it('extracts a single-quoted title', () => {
    const src = "---\ntitle: 'My Report'\n---\n";
    expect(extractFrontmatterTitle(src)).toBe('My Report');
  });

  it('extracts a double-quoted title', () => {
    const src = '---\ntitle: "My Report"\n---\n';
    expect(extractFrontmatterTitle(src)).toBe('My Report');
  });

  it('preserves colons in unquoted values', () => {
    const src = '---\ntitle: Q3 Plan: revenue\n---\n';
    expect(extractFrontmatterTitle(src)).toBe('Q3 Plan: revenue');
  });

  it('returns null when there is no closing ---', () => {
    const src = '---\ntitle: x\n# body without delimiter';
    expect(extractFrontmatterTitle(src)).toBeNull();
  });

  it('returns null when title key is missing', () => {
    const src = '---\nauthor: someone\n---\n';
    expect(extractFrontmatterTitle(src)).toBeNull();
  });

  it('returns null when title is empty after trim', () => {
    const src = '---\ntitle:    \n---\n';
    expect(extractFrontmatterTitle(src)).toBeNull();
  });

  it('returns null when title looks numeric (we only handle strings)', () => {
    const src = '---\ntitle: 42\n---\n';
    // Numeric values get returned as the literal "42" — caller still treats
    // this as a string. That matches gray-matter's behavior closely enough
    // for prefill purposes.
    expect(extractFrontmatterTitle(src)).toBe('42');
  });

  it('handles other keys before title', () => {
    const src = '---\nauthor: a\ntitle: T\ntags: x\n---\n';
    expect(extractFrontmatterTitle(src)).toBe('T');
  });

  it('ignores lines after the closing ---', () => {
    const src = '---\ntitle: First\n---\ntitle: Second\n';
    expect(extractFrontmatterTitle(src)).toBe('First');
  });

  it('handles CRLF line endings', () => {
    const src = '---\r\ntitle: My Report\r\n---\r\n';
    expect(extractFrontmatterTitle(src)).toBe('My Report');
  });
});
