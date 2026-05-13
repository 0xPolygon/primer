import { parse, serialize } from 'parse5';
import type { UploadErrorCode } from '@primer/shared/api';
import { stripDisallowedElements } from './sanitize.ts';
import { injectCompanionScript } from './inject.ts';

export type TransformResult =
  | { ok: true; html: string }
  | { ok: false; error: UploadErrorCode; message: string };

export function transformHtml(input: string): TransformResult {
  if (input.trim().length === 0) {
    return { ok: false, error: 'parse_failed', message: 'Empty document.' };
  }

  let doc;
  try {
    doc = parse(input);
  } catch (err) {
    return {
      ok: false,
      error: 'parse_failed',
      message: `HTML parse failed: ${(err as Error).message}`,
    };
  }

  const html = doc.childNodes.find(
    (n) => (n as { tagName?: string }).tagName === 'html'
  );
  if (!html) {
    return { ok: false, error: 'parse_failed', message: 'No <html> root after parse.' };
  }

  stripDisallowedElements(doc);
  injectCompanionScript(doc);

  return { ok: true, html: serialize(doc) };
}
