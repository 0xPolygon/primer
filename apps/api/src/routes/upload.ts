import type { Hono } from 'hono';
import { v7 as uuidv7 } from 'uuid';
import type { AppVariables, AppDeps } from '../app.ts';
import type { UploadResponse } from '@primer/shared/api';
import { documents, versions } from '@primer/shared/schema';
import { validateUpload } from '../upload/validate.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';
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
    const transformed = transformHtml(text);
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
