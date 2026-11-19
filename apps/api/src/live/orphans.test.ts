import { describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { Node as PmNode } from '@tiptap/pm/model';
import type { ThreadDTO } from '@polygonlabs/primer-api-types';
import { db } from '../db/client.ts';
import { createLiveThread, reanchorThread } from '../lib/liveThreads.ts';
import { loadThread } from '../lib/threadList.ts';
import { MOCK_USER } from '../auth/resolver.ts';
import { NoopNotifier } from '../notifications/notifier.ts';
import { serverEditor } from './editor.ts';
import { fragmentDoc, presentThreadIds } from './marks.ts';
import { syncOrphans } from './orphans.ts';
import { SYSTEM_ORIGIN, originFor } from './origin.ts';
import { applyPlan } from './pipeline.ts';
import { createLiveDoc, paragraph, seedBlocks, withLiveDoc } from './live.testlib.ts';

const main = (blockId: string) => ({ tabId: 'main', blockId });

async function setup(): Promise<{ id: string; thread: ThreadDTO }> {
  const id = await createLiveDoc({ uploaderId: MOCK_USER.id });
  await seedBlocks(id, [paragraph('p1', 'The launch is on Friday'), paragraph('p2', 'Unrelated')]);
  const out = await createLiveThread(new NoopNotifier(), MOCK_USER, id, {
    anchor: { type: 'prose', target: main('p1'), quote: 'Friday' },
    body: 'Which Friday?',
  });
  if (!out.ok) throw new Error(out.refusal.message);
  return { id, thread: out.value };
}

function deleteBlock(id: string, blockId: string) {
  return applyPlan(id, originFor(MOCK_USER), {
    onConflict: 'refuse',
    edits: [{ target: main(blockId), inverse: false, build: (tr, at) => void tr.delete(at!.pos, at!.pos + at!.node.nodeSize) }],
  });
}

async function sync(id: string) {
  await withLiveDoc(id, (doc) => syncOrphans(id, doc));
  return (await loadThread((await threadIds(id))[0]!))!;
}

async function threadIds(id: string): Promise<string[]> {
  const rows = (await db.execute(sql`SELECT id FROM threads WHERE document_id = ${id}`)) as unknown as { id: string }[];
  return rows.map((r) => r.id);
}

async function orphanEvents(id: string): Promise<boolean[]> {
  const rows = (await db.execute(sql`
    SELECT payload FROM events WHERE document_id = ${id} AND type = 'thread.orphaned' ORDER BY id
  `)) as unknown as { payload: string | { orphaned: boolean } }[];
  return rows.map((r) => (typeof r.payload === 'string' ? JSON.parse(r.payload) : r.payload).orphaned);
}

describe('orphaned threads', () => {
  it('deleting the commented text orphans the thread and keeps its quote', async () => {
    const { id, thread } = await setup();
    await deleteBlock(id, 'p1');
    const after = await sync(id);
    expect(after.orphaned).toBe(true);
    expect(after.resolvedAt).toBeNull();
    expect(after.anchor).toMatchObject({ type: 'prose', quote: 'Friday' });
    expect(await orphanEvents(id)).toEqual([true]);
    expect(thread.orphaned).toBe(false);
  });

  it('undoing the delete clears the flag', async () => {
    const { id } = await setup();
    const before = await withLiveDoc(id, (doc) => fragmentDoc(doc.getXmlFragment('document-store')).toJSON());
    await deleteBlock(id, 'p1');
    expect((await sync(id)).orphaned).toBe(true);

    // Undo restores the same content, comment mark included.
    const restored = PmNode.fromJSON(serverEditor().editor.pmSchema, before);
    await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [{ target: main(''), inverse: false, build: (tr) => void tr.replaceWith(0, tr.doc.content.size, restored.content) }],
    });
    expect((await sync(id)).orphaned).toBe(false);
    expect(await orphanEvents(id)).toEqual([true, false]);
  });

  it('re-anchor by quote restores the mark', async () => {
    const { id, thread } = await setup();
    await deleteBlock(id, 'p1');
    await sync(id);

    const out = await reanchorThread(MOCK_USER, thread.id, { target: main('p2'), quote: 'Unrelated' });
    expect(out.ok && out.value.orphaned).toBe(false);
    expect(out.ok && out.value.anchor).toEqual({ type: 'prose', target: main('p2'), quote: 'Unrelated' });
    await withLiveDoc(id, (doc) => expect(presentThreadIds(doc).has(thread.id)).toBe(true));
    expect((await sync(id)).orphaned).toBe(false);
  });

  it('marks left in unreachable fragments count as removed', async () => {
    const { id, thread } = await setup();
    // A page-text fragment no current content references still holds a mark.
    const schema = serverEditor().editor.pmSchema;
    const marked = schema.text('Friday', [schema.marks.comment!.create({ threadId: thread.id, orphan: false })]);
    await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [
        {
          target: { tabId: 'main', blockId: 'gone', pid: 'p1' },
          inverse: false,
          build: (tr) => {
            let pos = -1;
            tr.doc.descendants((node, at) => {
              if (pos < 0 && node.isTextblock) pos = at + 1;
              return pos < 0;
            });
            tr.insert(pos, marked);
          },
        },
      ],
    });
    await deleteBlock(id, 'p1');
    expect((await sync(id)).orphaned).toBe(true);
  });

  it("a thread id from another document planted in a mark never touches that thread", async () => {
    const a = await setup();
    const b = await setup();
    await deleteBlock(b.id, 'p1');
    await withLiveDoc(b.id, (doc) => syncOrphans(b.id, doc));
    expect((await loadThread(b.thread.id))!.orphaned).toBe(true);

    // A client of document A writes a comment mark carrying B's thread id.
    const schema = serverEditor().editor.pmSchema;
    const planted = schema.text('copy', [schema.marks.comment!.create({ threadId: b.thread.id, orphan: false })]);
    await applyPlan(a.id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [{ target: main('p2'), inverse: false, build: (tr, at) => void tr.insert(at!.pos + 2, planted) }],
    });
    await withLiveDoc(a.id, (doc) => syncOrphans(a.id, doc));
    expect((await loadThread(b.thread.id))!.orphaned).toBe(true);
    expect(await orphanEvents(b.id)).toEqual([true]);
    expect(await orphanEvents(a.id)).toEqual([]);
  });
});
