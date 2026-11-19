import type { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { AppVariables, AppDeps } from '../app.ts';
import { db } from '../db/client.ts';
import { artifactCsp } from '../lib/pagePolicy.ts';
import {
  canRead, loadEffectiveRole,
  type Visibility,
} from '../lib/permissions.ts';

export function registerVersionContentRoute(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
  app.get('/api/versions/:versionId/content', async (c) => {
    const versionId = c.req.param('versionId');

    // Enforce soft-delete and permissions: a deleted doc's content must not be
    // served, and private docs are only accessible to the owner and collabs.
    const [versionWithDoc] = (await db.execute(sql`
      SELECT v.storage_key AS "storageKey",
             d.uploader_id  AS "uploaderId",
             d.visibility   AS "visibility",
             d.deleted_at   AS "deletedAt",
             d.id           AS "documentId"
      FROM versions v
      INNER JOIN documents d ON d.id = v.document_id
      WHERE v.id = ${versionId}
      LIMIT 1
    `)) as unknown as {
      storageKey: string;
      uploaderId: string;
      visibility: Visibility;
      deletedAt: Date | null;
      documentId: string;
    }[];
    if (!versionWithDoc || versionWithDoc.deletedAt !== null) {
      return c.json({ error: 'not_found' }, 404);
    }

    const user = c.get('user');
    const eff = await loadEffectiveRole({ id: versionWithDoc.documentId, uploaderId: versionWithDoc.uploaderId, visibility: versionWithDoc.visibility as Visibility }, user);
    if (!canRead(versionWithDoc.visibility, eff)) {
      return c.json({ error: 'not_found' }, 404);
    }

    const stream = await deps.storage.get(versionWithDoc.storageKey);

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': artifactCsp('standard'),
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'private, max-age=300',
      },
    });
  });
}
