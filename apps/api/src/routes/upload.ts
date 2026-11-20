import type { Hono, Context } from 'hono';
import type { AppVariables, AppDeps } from '../app.ts';
import type { UploadResponse } from '@polygonlabs/primer-api-types';
import { validateUpload } from '../upload/validate.ts';
import { publishDocument, type PublishResult } from '../lib/publish.ts';
import { logger } from '../logger.ts';

/** A publish refusal as a REST response: the legacy `error` code clients
 *  branch on, plus the structured `refusal` with its fix. */
export function refusalResponse(
  c: Context<{ Variables: AppVariables }>,
  result: Extract<PublishResult, { ok: false }>,
) {
  const { refusal } = result;
  const error = typeof refusal.details?.error === 'string' ? refusal.details.error : refusal.code;
  return c.json({ error, message: refusal.message, refusal }, result.status);
}

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

    let result: PublishResult;
    try {
      result = await publishDocument(deps.storage, {
        actor: c.get('user'),
        title: validated.title,
        description: validated.description,
        content: validated.file.bytes,
        filename: validated.file.filename,
        format: validated.format,
      });
    } catch (err) {
      logger.warn({ err }, 'upload: publish failed');
      return c.json({ error: 'internal', message: 'Failed to persist upload.' }, 500);
    }
    if (!result.ok) return refusalResponse(c, result);

    const body: UploadResponse = {
      documentId: result.documentId,
      versionId: result.versionId,
      url: `/d/${result.documentId}`,
    };
    return c.json(body, 200);
  });
}
