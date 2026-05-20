import type { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';
import type { AppVariables, AppDeps } from '../app.ts';
import { versions } from '@primer/shared/schema';
import { db } from '../db/client.ts';

export const ARTIFACT_CSP = [
  "default-src 'none'",
  // blob: required for self-bundled artifacts that decode JS/CSS/fonts from
  // an embedded base64 manifest into blob: URLs at runtime. Blob URLs are
  // origin-bound to the creator (the sandboxed opaque-origin iframe) so this
  // does not expand the exfil surface — connect-src 'none' still blocks all
  // outbound network from the artifact.
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

    // Enforce soft-delete: a deleted doc's content must not be served.
    const [versionWithDoc] = (await db.execute(sql`
      SELECT v.storage_key, d.deleted_at FROM versions v
      INNER JOIN documents d ON d.id = v.document_id
      WHERE v.id = ${versionId}
      LIMIT 1
    `)) as unknown as { storage_key: string; deleted_at: Date | null }[];
    if (!versionWithDoc || versionWithDoc.deleted_at !== null) {
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
