import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { sql } from 'drizzle-orm';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { db } from '../db/client.ts';
import { compact, loadYDoc, persistedUpTo } from './persist.ts';
import { createLiveDoc, paragraph, seedBlocks, withLiveDoc } from './live.testlib.ts';
import { SYSTEM_ORIGIN } from './origin.ts';
import { serverEditor } from './editor.ts';
import { applyPlan } from './pipeline.ts';

const mainJson = (doc: Y.Doc) => yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('document-store'));

async function appendText(documentId: string, blockId: string, text: string) {
  await applyPlan(documentId, SYSTEM_ORIGIN, {
    onConflict: 'refuse',
    edits: [
      {
        target: { tabId: 'main', blockId },
        inverse: false,
        build: (tr, at) => {
          tr.insert(at!.pos + 2 + at!.node.firstChild!.content.size, serverEditor().editor.pmSchema.text(text));
        },
      },
    ],
  });
}

describe('live document persistence', () => {
  it('updates round-trip through snapshot and log', async () => {
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha'), paragraph('b', 'Beta')]);
    await appendText(id, 'a', ' one');
    await compact(id, { above: 0 });
    await appendText(id, 'b', ' two');

    const [snapshot] = (await db.execute(sql`SELECT upto_update_id FROM doc_snapshots WHERE document_id = ${id}`)) as unknown as { upto_update_id: string }[];
    expect(snapshot).toBeDefined();
    const [{ n }] = (await db.execute(sql`SELECT count(*)::int AS n FROM doc_updates WHERE document_id = ${id} AND update IS NOT NULL`)) as unknown as { n: number }[];
    expect(n).toBe(1);

    const live = await withLiveDoc(id, async (doc) => ({ json: mainJson(doc), docVersion: await persistedUpTo(doc) }));
    const loaded = await loadYDoc(id);
    expect(mainJson(loaded.doc)).toEqual(live.json);
    expect(loaded.docVersion).toBe(live.docVersion);
    expect(JSON.stringify(live.json)).toContain('Alpha one');
    expect(JSON.stringify(live.json)).toContain('Beta two');
  });

  it('compaction never interleaves with an append', async () => {
    const id = await createLiveDoc();
    const inMemory = await withLiveDoc(id, async (doc) => {
      const list = doc.getArray<number>('stress');
      const compactions: Promise<void>[] = [];
      for (let i = 0; i < 1000; i++) {
        doc.transact(() => list.push([i]), { source: 'local', context: SYSTEM_ORIGIN });
        if (i === 600) compactions.push(compact(id));
      }
      await Promise.all(compactions);
      await persistedUpTo(doc);
      return list.toArray();
    });
    expect(inMemory).toHaveLength(1000);

    const [{ snapshots }] = (await db.execute(sql`SELECT count(*)::int AS snapshots FROM doc_snapshots WHERE document_id = ${id}`)) as unknown as { snapshots: number }[];
    expect(snapshots).toBe(1);
    const loaded = await loadYDoc(id);
    expect(loaded.doc.getArray<number>('stress').toArray()).toEqual(inMemory);
    expect(loaded.docVersion).toBeGreaterThan(0);
  });
});
