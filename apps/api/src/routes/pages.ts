import type { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { LivePageInfo } from '@polygonlabs/primer-api-types';
import type { AppDeps, AppVariables, AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documents } from '../db/schema.ts';
import { artifactCsp } from '../lib/pagePolicy.ts';
import { canRead, loadEffectiveRole, type Visibility } from '../lib/permissions.ts';
import { withLiveDocument } from '../live/instance.ts';
import { pageBlocks } from '../live/reach.ts';
import { readEmbeds } from '../page/embeds.ts';
import { loadStamped } from '../page/publish.ts';
import { readPids } from '../page/stamp.ts';
import { pagePolicyOf } from '../records/page.ts';
import type { Storage } from '../storage/types.ts';
import { transformHtml } from '../upload/htmlPipeline.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A live page block's frame (M6): its stamped source, sanitized and with the
 * companion injected, served like any version's content; and what the host
 * binds the frame to (its document, outbound policy, and each pid's source
 * text and each embed, which the overlay needs). People's current text is
 * pushed by the host over the bridge, never served here.
 */
export function registerPageRoutes(app: Hono<{ Variables: AppVariables }>, deps: AppDeps): void {
  app.get('/api/documents/:docId/pages/:blockId/content', async (c) => {
    const page = await readablePage(deps.storage, c.req.param('docId'), c.req.param('blockId'), c.get('user'));
    if (!page) return c.json({ error: 'not_found' }, 404);
    const served = transformHtml(page.stamped);
    if (!served.ok) return c.json({ error: 'parse_failed', message: served.message }, 500);
    return new Response(served.html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': artifactCsp(pagePolicyOf(served.html)),
        'x-frame-options': 'SAMEORIGIN',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cache-control': 'private, no-store',
      },
    });
  });

  app.get('/api/documents/:docId/pages/:blockId', async (c) => {
    const page = await readablePage(deps.storage, c.req.param('docId'), c.req.param('blockId'), c.get('user'));
    if (!page) return c.json({ error: 'not_found' }, 404);
    const embeds = readEmbeds(page.stamped);
    const served = transformHtml(page.stamped);
    const body: LivePageInfo = {
      documentId: page.documentId,
      versionId: page.versionId,
      policy: pagePolicyOf(served.ok ? served.html : page.stamped),
      blockId: page.blockId,
      texts: Object.fromEntries(readPids(page.stamped).map((p) => [p.pid, p.text])),
      embeds: 'embeds' in embeds ? embeds.embeds.map((e) => ({ embedId: e.embedId, kind: e.kind })) : [],
    };
    return c.json(body, 200);
  });
}

async function readablePage(storage: Storage, documentId: string, blockId: string, user: AuthUser) {
  if (!UUID.test(documentId) || !ID.test(blockId)) return null;
  const [doc] = await db
    .select({ uploaderId: documents.uploaderId, visibility: documents.visibility, deletedAt: documents.deletedAt, format: documents.format })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc || doc.deletedAt !== null || doc.format !== 'html') return null;
  const role = await loadEffectiveRole({ id: documentId, uploaderId: doc.uploaderId, visibility: doc.visibility as Visibility }, user);
  if (!canRead(doc.visibility as Visibility, role)) return null;
  const ref = await withLiveDocument(documentId, (ydoc) => pageBlocks(ydoc).find((p) => p.blockId === blockId) ?? null);
  if (!ref) return null;
  const stamped = await loadStamped(storage, documentId, ref);
  if (stamped === null) return null;
  const versionId = ref.sourceKey.slice(`pages/${documentId}/`.length, -'.html'.length);
  return { documentId, blockId, versionId, stamped };
}
