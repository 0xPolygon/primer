import { describe, it, expect } from 'vitest';
import { validateUpload, MAX_BYTES } from './validate.ts';

const okFile = {
  filename: 'report.html',
  contentType: 'text/html',
  bytes: new Uint8Array(1024),
};

describe('validateUpload', () => {
  it('accepts a well-formed upload', () => {
    const r = validateUpload({ file: okFile, title: 'My Report', description: undefined });
    expect(r.ok).toBe(true);
  });

  it('rejects an oversize file', () => {
    const big = { ...okFile, bytes: new Uint8Array(MAX_BYTES + 1) };
    const r = validateUpload({ file: big, title: 't', description: undefined });
    expect(r).toEqual({ ok: false, error: 'too_large', message: expect.any(String) });
  });

  it('rejects non-.html filename', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'report.txt' },
      title: 't',
      description: undefined,
    });
    expect(r).toEqual({ ok: false, error: 'bad_extension', message: expect.any(String) });
  });

  it('accepts .HTML uppercase extension', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'REPORT.HTML' },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects an empty title (after trim)', () => {
    const r = validateUpload({ file: okFile, title: '   ', description: undefined });
    expect(r).toEqual({ ok: false, error: 'missing_title', message: expect.any(String) });
  });

  it('rejects when file is missing', () => {
    const r = validateUpload({ file: undefined, title: 't', description: undefined });
    expect(r).toEqual({ ok: false, error: 'missing_file', message: expect.any(String) });
  });

  it('rejects a bad content-type when one is provided', () => {
    const r = validateUpload({
      file: { ...okFile, contentType: 'application/pdf' },
      title: 't',
      description: undefined,
    });
    expect(r).toEqual({ ok: false, error: 'bad_content_type', message: expect.any(String) });
  });

  it('accepts missing content-type (browsers sometimes omit)', () => {
    const r = validateUpload({
      file: { ...okFile, contentType: undefined },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('caps title at 200 chars', () => {
    const r = validateUpload({ file: okFile, title: 'x'.repeat(201), description: undefined });
    expect(r).toEqual({ ok: false, error: 'validation_failed', message: expect.any(String) });
  });

  it('caps description at 2000 chars', () => {
    const r = validateUpload({ file: okFile, title: 't', description: 'x'.repeat(2001) });
    expect(r).toEqual({ ok: false, error: 'validation_failed', message: expect.any(String) });
  });

  it('accepts a .md filename', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'notes.md', contentType: 'text/markdown' },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a .markdown filename', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'notes.markdown', contentType: 'text/markdown' },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts a .MD uppercase extension', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'NOTES.MD', contentType: 'text/markdown' },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts text/x-markdown content type', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'n.md', contentType: 'text/x-markdown' },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('accepts missing content-type for .md', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'n.md', contentType: undefined },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects a content-type/extension mismatch (.md with text/html)', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'n.md', contentType: 'text/html' },
      title: 't',
      description: undefined,
    });
    expect(r).toEqual({ ok: false, error: 'bad_content_type', message: expect.any(String) });
  });

  it('rejects an unsupported extension with the updated message', () => {
    const r = validateUpload({
      file: { ...okFile, filename: 'report.txt' },
      title: 't',
      description: undefined,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toBe('bad_extension');
    expect(r.message).toContain('.html');
    expect(r.message).toContain('.md');
  });
});
