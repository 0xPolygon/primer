import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { MOCK_USER } from '../auth/resolver.ts';
import { db } from '../db/client.ts';
import { documents, users } from '../db/schema.ts';
import { publishDocument } from '../lib/publish.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { applyOps } from './ops.ts';
import { listCitations } from './citations.ts';
import { exportHtml } from './export.ts';
import { createLiveDoc, makeAgent, ops, paragraph, seedBlocks, withLiveDoc } from './live.testlib.ts';

const main = (blockId: string) => ({ tabId: 'main', blockId });

async function legacyDoc(storage: FilesystemStorage, uploader: string, versions: number, existing?: string): Promise<string> {
  let documentId = existing;
  for (let n = 1; n <= versions; n++) {
    const out = await publishDocument(storage, {
      actor: { ...MOCK_USER, id: uploader },
      title: 'Q3 numbers',
      filename: 'q3.html',
      format: 'html',
      content: new TextEncoder().encode(`<!doctype html><html><body><p>Revenue v${n}</p></body></html>`),
      ...(documentId ? { documentId } : {}),
    } as never);
    if (!out.ok) throw new Error(out.refusal.message);
    documentId = out.documentId;
  }
  return documentId!;
}

describe('citations', () => {
  it('citation to a Primer doc pins the cited version', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-cite-'));
    try {
      const storage = new FilesystemStorage(root);
      const cited = await legacyDoc(storage, MOCK_USER.id, 2);
      const agent = await makeAgent();
      const id = await createLiveDoc();
      await seedBlocks(id, [paragraph('a', 'Intro')]);

      const claim = (props: Record<string, string>) => ({
        op: 'add',
        at: main('a'),
        position: 'after',
        blocks: [{ json: { type: 'paragraph', content: [{ type: 'text', text: 'Revenue grew 12%', styles: {} }, { type: 'citation', props }] } }],
      });
      const out = await ops(id, agent, { ops: [claim({ docId: cited, quote: 'Revenue v2' }), claim({ url: 'https://example.com/report', quote: 'p. 4' })] });
      expect(out.outcomes.map((o) => o.status)).toEqual(['applied', 'applied']);

      // A later version of the cited document doesn't move the citation.
      await legacyDoc(storage, MOCK_USER.id, 1, cited);
      const list = await listCitations(MOCK_USER, id);
      expect(list.ok && list.value.citations.map((c) => [c.number, c.docId ?? c.url, c.versionNumber, c.source?.title])).toEqual([
        [1, 'https://example.com/report', undefined, undefined],
        [2, cited, 2, 'Q3 numbers'],
      ]);
      // The static rendering links the pinned version, numbered by CSS.
      const html = await withLiveDoc(id, (doc) => exportHtml(doc));
      expect(html).toContain(`href="/d/${cited}/v/2"`);
      expect(html).toContain('counter(primer-citation)');

      // A document the agent can't read is never cited, nor named.
      await db.insert(users).values({ id: 'cite-other', email: 'other@p.t', displayName: 'Other' }).onConflictDoNothing();
      const hidden = await legacyDoc(storage, 'cite-other', 1);
      await db.update(documents).set({ visibility: 'private' }).where(eq(documents.id, hidden));
      const refused = await applyOps(id, agent, { ops: [claim({ docId: hidden, quote: 'x' })] });
      expect(!refused.ok && refused.errors?.[0]?.refusal.code).toBe('invalid_op');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
