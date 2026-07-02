import type { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, AppDeps } from '../app.ts';
import { versions } from '@primer/shared/schema';
import { db } from '../db/client.ts';
import {
  canRead, effectiveRole, loadCollaboratorRole,
  type Visibility,
} from '../lib/permissions.ts';

export const ARTIFACT_CSP = [
  "default-src 'none'",
  // blob: required for self-bundled artifacts that decode JS/CSS/fonts from
  // an embedded base64 manifest into blob: URLs at runtime. Blob URLs are
  // origin-bound to the creator (the sandboxed opaque-origin iframe) so this
  // does not expand the exfil surface — connect-src 'none' still blocks all
  // outbound network from the artifact.
  // 'unsafe-inline' is required so uploaded artifacts can ship inline
  // <script> blocks and on* event handlers — that's the only way most
  // interactive dashboards work. The threat surface this opens is bounded
  // by ArtifactIframe's sandbox (opaque origin, no `allow-same-origin`) plus
  // `connect-src 'none'` and `form-action 'none'` below: inline JS runs,
  // but cannot reach Primer cookies/storage/parent DOM, cannot make network
  // requests, and cannot submit forms.
  "script-src 'self' 'unsafe-inline' blob: cdn.tailwindcss.com cdnjs.cloudflare.com unpkg.com cdn.jsdelivr.net esm.sh cdn.skypack.dev",
  "style-src 'self' 'unsafe-inline' blob: cdn.tailwindcss.com cdnjs.cloudflare.com unpkg.com cdn.jsdelivr.net fonts.googleapis.com",
  "connect-src 'none'",
  "img-src data: blob: 'self' https:",
  "font-src 'self' blob: data: fonts.gstatic.com",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
].join('; ');

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
    const collabRole = await loadCollaboratorRole(versionWithDoc.documentId, user.id);
    const eff = effectiveRole(versionWithDoc, user.id, collabRole);
    if (!canRead(versionWithDoc.visibility, eff)) {
      return c.json({ error: 'not_found' }, 404);
    }

    const rows = await db.select().from(versions).where(eq(versions.id, versionId)).limit(1);
    if (rows.length === 0) {
      return c.json({ error: 'not_found' }, 404);
    }

    const stream = await deps.storage.get(rows[0].storageKey);

    return new Response(stream, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': ARTIFACT_CSP,
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'private, max-age=300',
      },
    });
  });
}
