import { parse, serialize } from 'parse5';
import type { UploadErrorCode } from '@primer/shared/api';
import { sanitizeUploadedHtml } from './sanitize.ts';
import {
  injectCompanionScript,
  injectStoragePolyfill,
  injectThemeOwnershipMarker,
  injectViewportMeta,
} from './inject.ts';

export type TransformResult =
  | { ok: true; html: string }
  | { ok: false; error: UploadErrorCode; message: string };

export interface TransformOptions {
  /** True for Primer-authored content (Markdown) whose theme the parent app
   *  controls. Marks <html> with `data-primer-theme="managed"` so the companion
   *  forces the app theme; raw uploaded HTML is left unmarked so its own theme
   *  handling wins. Defaults to false. */
  themeManaged?: boolean;
}

export function transformHtml(
  input: string,
  options: TransformOptions = {},
): TransformResult {
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

  injectViewportMeta(doc);
  injectStoragePolyfill(doc);
  injectCompanionScript(doc);
  if (options.themeManaged) {
    injectThemeOwnershipMarker(doc);
  }

  return { ok: true, html: serialize(doc) };
}
