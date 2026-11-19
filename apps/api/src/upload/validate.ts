import type { PublishFormat, UploadErrorCode } from '@polygonlabs/primer-api-types';

export const MAX_BYTES = 10 * 1024 * 1024; // 10 MiB
export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 2000;

export interface UploadInputFile {
  filename: string;
  contentType: string | undefined;
  bytes: Uint8Array;
}

export interface UploadInput {
  file: UploadInputFile | undefined;
  title: string;
  description: string | undefined;
}

export type ValidateResult =
  | { ok: true; title: string; description: string | null; file: UploadInputFile; format: PublishFormat }
  | { ok: false; error: UploadErrorCode; message: string };

export function validateUpload(input: UploadInput): ValidateResult {
  if (!input.file) {
    return { ok: false, error: 'missing_file', message: 'A file is required.' };
  }

  const title = input.title.trim();
  if (title.length === 0) {
    return { ok: false, error: 'missing_title', message: 'Title is required.' };
  }
  if (title.length > MAX_TITLE) {
    return {
      ok: false,
      error: 'validation_failed',
      message: `Title must be ${MAX_TITLE} characters or fewer.`,
    };
  }

  const description = input.description?.trim() ?? '';
  if (description.length > MAX_DESCRIPTION) {
    return {
      ok: false,
      error: 'validation_failed',
      message: `Description must be ${MAX_DESCRIPTION} characters or fewer.`,
    };
  }

  if (input.file.bytes.byteLength > MAX_BYTES) {
    return {
      ok: false,
      error: 'too_large',
      message: `File exceeds the ${MAX_BYTES}-byte limit.`,
    };
  }

  const format = formatForFilename(input.file.filename);
  if (format === null) {
    return {
      ok: false,
      error: 'bad_extension',
      message: 'File must be .html, .md, .markdown, or .txt.',
    };
  }

  if (input.file.contentType !== undefined) {
    const ct = input.file.contentType;
    const ok =
      (format === 'html' && ct === 'text/html') ||
      (format === 'markdown' && (ct === 'text/markdown' || ct === 'text/x-markdown' || ct === 'text/plain')) ||
      (format === 'text' && ct === 'text/plain');
    if (!ok) {
      return {
        ok: false,
        error: 'bad_content_type',
        message: `Unexpected content-type: ${ct}.`,
      };
    }
  }

  return {
    ok: true,
    title,
    description: description.length === 0 ? null : description,
    file: input.file,
    format,
  };
}

/** The publish format an uploaded file's extension names, or null. */
export function formatForFilename(filename: string): PublishFormat | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.html')) return 'html';
  if (lower.endsWith('.md') || lower.endsWith('.markdown')) return 'markdown';
  if (lower.endsWith('.txt')) return 'text';
  return null;
}
