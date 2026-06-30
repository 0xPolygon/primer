import { parse, serialize } from 'parse5';
import type { UploadErrorCode } from '@primer/shared/api';
import { sanitizeUploadedHtml } from './sanitize.ts';
import { injectCompanionScript, injectStoragePolyfill } from './inject.ts';

export type TransformResult =
  | { ok: true; html: string }
  | { ok: false; error: UploadErrorCode; message: string };

export function transformHtml(input: string): TransformResult {
  if (input.trim().length === 0) {
    return { ok: false, error: 'parse_failed', message: 'Empty document.' };
  }

  const sanitized = sanitizeUploadedHtml(input);

  let doc;
  try {
    doc = parse(sanitized);
  } catch (err) {
    return {
      ok: false,
      error: 'parse_failed',
      message: `HTML parse failed after sanitization: ${(err as Error).message}`,
    };
  }

  injectStoragePolyfill(doc);
  injectCompanionScript(doc);

  return { ok: true, html: serialize(doc) };
}
