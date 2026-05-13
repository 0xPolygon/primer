import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { AppVariables, AppDeps } from '../app.ts';
import { versions } from '@primer/shared/schema';
import { db } from '../db/client.ts';

export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' cdn.tailwindcss.com cdnjs.cloudflare.com unpkg.com cdn.jsdelivr.net esm.sh cdn.skypack.dev",
  "style-src 'self' 'unsafe-inline' cdn.tailwindcss.com cdnjs.cloudflare.com unpkg.com cdn.jsdelivr.net fonts.googleapis.com",
  "connect-src 'none'",
  "img-src data: blob: 'self' https:",
  "font-src 'self' fonts.gstatic.com",
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
