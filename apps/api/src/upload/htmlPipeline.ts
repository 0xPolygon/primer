import { parse, serialize } from 'parse5';
import type { UploadErrorCode } from '@primer/shared/api';
import { sanitizeUploadedHtml } from './sanitize.ts';
import { injectCompanionScript } from './inject.ts';

export type TransformResult =
  | { ok: true; html: string }
  | { ok: false; error: UploadErrorCode; message: string };

export function transformHtml(input: string): TransformResult {
  if (input.trim().length === 0) {
    return { ok: false, error: 'parse_failed', message: 'Empty document.' };
  }

  // First parse for structural validation: the upload pipeline requires a
  // recognisable HTML document with an <html> root.
  let initialDoc;
  try {
    initialDoc = parse(input);
  } catch (err) {
    return {
      ok: false,
      error: 'parse_failed',
      message: `HTML parse failed: ${(err as Error).message}`,
    };
  }

  const htmlRoot = initialDoc.childNodes.find(
    (n) => (n as { tagName?: string }).tagName === 'html'
  );
  if (!htmlRoot) {
    return { ok: false, error: 'parse_failed', message: 'No <html> root after parse.' };
  }

  // Run the sanitizer against the raw input. sanitize-html drops <html>,
  // <head>, and <body> wrappers and returns the inner body content. Re-wrap
  // so the companion-injection step (which finds <body>) keeps working.
  const sanitizedBody = sanitizeUploadedHtml(input);
  const wrapped = `<!DOCTYPE html><html><head></head><body>${sanitizedBody}</body></html>`;

  let doc;
  try {
    doc = parse(wrapped);
  } catch (err) {
    return {
      ok: false,
      error: 'parse_failed',
      message: `HTML parse failed after sanitization: ${(err as Error).message}`,
    };
  }

  injectCompanionScript(doc);

  return { ok: true, html: serialize(doc) };
}
