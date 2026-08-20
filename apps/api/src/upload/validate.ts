import type { UploadErrorCode } from '@polygonlabs/primer-api-types';

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
  | { ok: true; title: string; description: string | null; file: UploadInputFile }
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

  const lowerName = input.file.filename.toLowerCase();
  const isHtml = lowerName.endsWith('.html');
  const isMarkdown = lowerName.endsWith('.md') || lowerName.endsWith('.markdown');

  if (!isHtml && !isMarkdown) {
    return {
      ok: false,
      error: 'bad_extension',
      message: 'File must be .html, .md, or .markdown.',
    };
  }

  if (input.file.contentType !== undefined) {
    const ct = input.file.contentType;
    const htmlOk = isHtml && ct === 'text/html';
    const mdOk = isMarkdown && (ct === 'text/markdown' || ct === 'text/x-markdown' || ct === 'text/plain');
    if (!htmlOk && !mdOk) {
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
  };
}
