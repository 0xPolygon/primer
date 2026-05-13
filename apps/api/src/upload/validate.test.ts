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
});
