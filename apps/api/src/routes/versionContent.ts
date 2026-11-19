import type { Hono } from 'hono';
import { sql } from 'drizzle-orm';
import type { PageInfoResponse } from '@polygonlabs/primer-api-types';
import type { AppVariables, AppDeps, AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { artifactCsp } from '../lib/pagePolicy.ts';
import {
  canRead, loadEffectiveRole,
  type Visibility,
} from '../lib/permissions.ts';
import { pagePolicyOf } from '../records/page.ts';
import type { Storage } from '../storage/types.ts';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerVersionContentRoute(
  app: Hono<{ Variables: AppVariables }>,
  deps: AppDeps
): void {
  app.get('/api/versions/:versionId/content', async (c) => {
    const page = await loadReadablePage(deps.storage, c.req.param('versionId'), c.get('user'));
    if (!page) return c.json({ error: 'not_found' }, 404);
    return new Response(page.html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        // A page that opted in to records gets the complete outbound lockdown.
        'content-security-policy': artifactCsp(pagePolicyOf(page.html)),
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'private, max-age=300',
      },
    });
  });

  // What the host binds a page to, before it binds anything: the document
  // the page belongs to (the only document a records capability is ever
  // bound to) and its outbound policy, read from the same stored bytes the
  // content route serves.
  app.get('/api/versions/:versionId/page', async (c) => {
    const page = await loadReadablePage(deps.storage, c.req.param('versionId'), c.get('user'));
    if (!page) return c.json({ error: 'not_found' }, 404);
    const body: PageInfoResponse = { documentId: page.documentId, versionId: page.versionId, policy: pagePolicyOf(page.html) };
    return c.json(body, 200);
  });
}

/** A version's stored page, when the caller may read its document (a
 *  deleted document's pages are never served). */
async function loadReadablePage(
  storage: Storage,
  versionId: string,
  user: AuthUser,
): Promise<{ documentId: string; versionId: string; html: string } | null> {
  if (!UUID_RE.test(versionId)) return null;
  const [row] = (await db.execute(sql`
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
  if (!row || row.deletedAt !== null) return null;
  const eff = await loadEffectiveRole({ id: row.documentId, uploaderId: row.uploaderId, visibility: row.visibility }, user);
  if (!canRead(row.visibility, eff)) return null;
  const html = await new Response(await storage.get(row.storageKey)).text();
  return { documentId: row.documentId, versionId, html };
}
