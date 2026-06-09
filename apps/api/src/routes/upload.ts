import type { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables, AppDeps } from '../app.ts';
import type { UploadResponse } from '@primer/shared/api';
import { documents, versions } from '@primer/shared/schema';
import { isValidTemplateId } from '@primer/shared/templates';
import { validateUpload } from '../upload/validate.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
import { markdownToHtml } from '../upload/markdown.ts';
import { db } from '../db/client.ts';
import { logger } from '../logger.ts';

export function registerUploadRoute(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
  app.post('/api/upload', async (c) => {
    const form = await c.req.parseBody();
    const file = form['file'];
    const title = typeof form['title'] === 'string' ? form['title'] : '';
    const description =
      typeof form['description'] === 'string' ? form['description'] : undefined;

    const templateRaw = form['template'];
    let template: string | null = null;
    if (typeof templateRaw === 'string' && templateRaw.length > 0) {
      if (!isValidTemplateId(templateRaw)) {
        return c.json(
          { error: 'validation_failed', message: `Unknown template: ${templateRaw}` },
          400,
        );
      }
      template = templateRaw;
    }

    let bytes: Uint8Array | undefined;
    let filename = '';
    let contentType: string | undefined;
    if (file instanceof File) {
      bytes = new Uint8Array(await file.arrayBuffer());
      filename = file.name;
      contentType = file.type === '' ? undefined : file.type;
    }

    const validated = validateUpload({
      file: bytes ? { filename, contentType, bytes } : undefined,
      title,
      description,
    });
    if (!validated.ok) {
      return c.json({ error: validated.error, message: validated.message }, 400);
    }

    const text = new TextDecoder('utf-8').decode(validated.file.bytes);
    const lowerName = validated.file.filename.toLowerCase();
    const isMarkdown =
      lowerName.endsWith('.md') || lowerName.endsWith('.markdown');

    let preparedHtml: string;
    if (isMarkdown) {
      let mdResult;
      try {
        mdResult = markdownToHtml(text);
      } catch (err) {
        return c.json(
          {
            error: 'parse_failed',
            message: `Markdown conversion failed: ${(err as Error).message}`,
          },
          400,
        );
      }
      if (mdResult.bodyIsEmpty) {
        return c.json(
          { error: 'parse_failed', message: 'Document body is empty.' },
          400,
        );
      }
      preparedHtml = mdResult.html;
    } else {
      preparedHtml = text;
    }

    const transformed = transformHtml(preparedHtml);
    if (!transformed.ok) {
      return c.json({ error: transformed.error, message: transformed.message }, 400);
    }

    const documentId = uuidv7();
    const versionId = uuidv7();
    const storageKey = `v1/${versionId}.html`;
    const transformedBytes = new TextEncoder().encode(transformed.html);

    await deps.storage.put(storageKey, transformedBytes);

    try {
      await db.transaction(async (tx) => {
        await tx.insert(documents).values({
          id: documentId,
          title: validated.title,
          description: validated.description,
          uploaderId: c.get('user').id,
        });
        await tx.insert(versions).values({
          id: versionId,
          documentId,
          versionNumber: 1,
          storageKey,
          sizeBytes: transformedBytes.byteLength,
          versionNote: null,
          template,
        });
      });
    } catch (err) {
      logger.warn({ err, storageKey }, 'db insert failed; attempting compensating delete');
      try {
        await deps.storage.delete(storageKey);
      } catch (cleanupErr) {
        logger.warn({ err: cleanupErr, storageKey }, 'compensating delete also failed');
      }
      return c.json({ error: 'internal', message: 'Failed to persist upload.' }, 500);
    }

    const body: UploadResponse = { documentId, versionId, url: `/d/${documentId}` };
    return c.json(body, 200);
  });
}
