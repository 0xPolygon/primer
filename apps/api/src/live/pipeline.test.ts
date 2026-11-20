import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { db } from '../db/client.ts';
import { users } from '../db/schema.ts';
import { blockVersion, findBlock } from './blocks.ts';
import { serverEditor } from './editor.ts';
import { createLiveDoc, paragraph, seedBlocks, withLiveDoc } from './live.testlib.ts';
import { applyPlan, type PlannedEdit } from './pipeline.ts';
import { SYSTEM_ORIGIN } from './origin.ts';

const main = (blockId: string) => ({ tabId: 'main', blockId });

/** Replaces a paragraph block's text. */
function setText(blockId: string, text: string, expectVersion?: string): PlannedEdit {
  return {
    target: main(blockId),
    expectVersion,
    inverse: false,
    build: (tr, at) => {
      const content = at!.node.firstChild!;
      const from = at!.pos + 2;
      tr.replaceWith(from, from + content.content.size, serverEditor().editor.pmSchema.text(text));
    },
  };
}

function blockElement(doc: Y.Doc, blockId: string): Y.XmlElement {
  const group = doc.getXmlFragment('document-store').get(0) as Y.XmlElement;
  return group.toArray().find((el) => (el as Y.XmlElement).getAttribute('id') === blockId) as Y.XmlElement;
}

async function rowCount(documentId: string): Promise<number> {
  const [row] = (await db.execute(sql`SELECT count(*)::int AS n FROM doc_updates WHERE document_id = ${documentId}`)) as unknown as { n: number }[];
  return row!.n;
}

describe('applyPlan', () => {
  it('a write to block A leaves a comment mark in block B intact', async () => {
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha'), paragraph('b', 'Beta')]);
    await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [
        {
          target: main('b'),
          inverse: false,
          build: (tr, at) => {
            tr.addMark(at!.pos + 2, at!.pos + 2 + 'Beta'.length, serverEditor().editor.pmSchema.marks.comment!.create({ threadId: 't1' }));
          },
        },
      ],
    });
    const before = await withLiveDoc(id, (doc) => blockElement(doc, 'b'));

    const result = await applyPlan(id, SYSTEM_ORIGIN, { onConflict: 'refuse', edits: [setText('a', 'Alpha, edited')] });
    expect(result.outcomes).toEqual([{ index: 0, target: main('a'), status: 'applied' }]);

    await withLiveDoc(id, (doc) => {
      expect(blockElement(doc, 'b')).toBe(before);
      const json = JSON.stringify(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('document-store')));
      expect(json).toContain('Alpha, edited');
      expect(json).toContain('"type":"comment","attrs":{"orphan":false,"threadId":"t1"}');
    });
  });

  it('origin from a DirectConnection context is attributed', async () => {
    const agentId = `agent_${uuidv7()}`;
    await db.insert(users).values({ id: agentId, email: '', displayName: 'Helper', kind: 'agent', viaUserId: 'mock-user-1' });
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha'), paragraph('b', 'Beta')]);
    const runId = uuidv7();

    const result = await applyPlan(id, { kind: 'agent', actorId: agentId, runId }, { onConflict: 'refuse', edits: [setText('b', 'Beta!')] });

    const [row] = (await db.execute(sql`
      SELECT id, actor_id, run_id, touched FROM doc_updates WHERE document_id = ${id} ORDER BY id DESC LIMIT 1
    `)) as unknown as { id: string; actor_id: string; run_id: string; touched: string[] }[];
    expect(row).toMatchObject({ actor_id: agentId, run_id: runId, touched: ['b'] });
    expect(result.docVersion).toBe(Number(row!.id));
  });

  it('a precondition failure leaves the document untouched', async () => {
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha'), paragraph('b', 'Beta')]);
    const version = (await applyPlan(id, SYSTEM_ORIGIN, { onConflict: 'refuse', edits: [] })).docVersion;
    const rows = await rowCount(id);

    const result = await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [setText('a', 'Alpha, stale', '0000000000000000')],
    });

    expect(result.docVersion).toBe(version);
    expect(result.outcomes[0]).toMatchObject({ status: 'conflict', refusal: { code: 'target_changed' } });
    expect(await rowCount(id)).toBe(rows);
    await withLiveDoc(id, (doc) => {
      expect(JSON.stringify(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('document-store')))).not.toContain('stale');
    });
  });

  it('a matching version applies and unrelated edits in the batch still apply', async () => {
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha'), paragraph('b', 'Beta')]);
    const versionOfA = await withLiveDoc(id, (doc) => {
      const pmDoc = serverEditor().editor.pmSchema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(doc.getXmlFragment('document-store')));
      return blockVersion(findBlock(pmDoc, 'a')!.node);
    });

    const result = await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [setText('a', 'Alpha 2', versionOfA), setText('b', 'Beta 2', 'ffffffffffffffff')],
    });
    expect(result.outcomes.map((o) => o.status)).toEqual(['applied', 'conflict']);
  });
});
