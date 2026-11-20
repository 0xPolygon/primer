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
import { getLiveDoc } from './read.ts';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publishDocument } from '../lib/publish.ts';
import { FilesystemStorage } from '../storage/filesystem.ts';
import { setPidText } from '../page/text.ts';

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
  it('orphaned thread re-anchors to the reworded sentence', async () => {
    const id = await createLiveDoc({ uploaderId: MOCK_USER.id });
    await seedBlocks(id, [paragraph('p1', 'We ship the beta to five pilot customers in March.'), paragraph('p2', 'Unrelated')]);
    const made = await createLiveThread(new NoopNotifier(), MOCK_USER, id, {
      anchor: { type: 'prose', target: main('p1'), quote: 'We ship the beta to five pilot customers in March.' },
      body: 'Which customers?',
    });
    if (!made.ok) throw new Error(made.refusal.message);
    // The sentence is rewritten in a new block: the old one, and its mark, are gone.
    await deleteBlock(id, 'p1');
    await applyPlan(id, SYSTEM_ORIGIN, {
      onConflict: 'refuse',
      edits: [
        {
          target: main(''),
          inverse: false,
          build: (tr) => void tr.insert(1, serverEditor()._blocksToProsemirrorNode([paragraph('p3', 'Plan: we ship the beta to 5 pilot customers in March, then widen.')] as never)),
        },
      ],
    });
    expect((await sync(id)).orphaned).toBe(true);

    // Creating a thread stays exact; only re-anchoring matches reworded text.
    const exact = await createLiveThread(new NoopNotifier(), MOCK_USER, id, {
      anchor: { type: 'prose', target: main('p3'), quote: 'We ship the beta to five pilot customers in March.' },
      body: 'x',
    });
    expect(exact.ok).toBe(false);

    // The Re-anchor button sends nothing: the thread's own quote and (gone) block.
    const out = await reanchorThread(MOCK_USER, made.value.id, {});
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.orphaned).toBe(false);
    expect(out.value.anchor).toEqual({ type: 'prose', target: main('p3'), quote: 'we ship the beta to 5 pilot customers in March,' });
    await withLiveDoc(id, (doc) => expect(presentThreadIds(doc).has(made.value.id)).toBe(true));
  });

  it('a reworded quote that fits two places equally is refused, not guessed', async () => {
    const id = await createLiveDoc({ uploaderId: MOCK_USER.id });
    await seedBlocks(id, [paragraph('p1', 'Review the budget by Friday.'), paragraph('p2', 'Review the budgets by Friday.')]);
    const made = await createLiveThread(new NoopNotifier(), MOCK_USER, id, {
      anchor: { type: 'prose', target: main('p2'), quote: 'Review the budgets by Friday.' },
      body: 'Ok?',
    });
    if (!made.ok) throw new Error(made.refusal.message);
    const out = await reanchorThread(MOCK_USER, made.value.id, { target: main(''), quote: 'Review the budgetz by Friday.' });
    expect(out.ok).toBe(false);
    expect(!out.ok && out.refusal.code).toBe('quote_not_found');
  });
  it('a thread on page text re-anchors to the reworded text, and the edit reads as a change to the page', async () => {
    const root = await mkdtemp(join(tmpdir(), 'primer-page-reanchor-'));
    try {
      const storage = new FilesystemStorage(root);
      const published = await publishDocument(storage, {
        actor: MOCK_USER,
        title: 'Results',
        filename: 'results.html',
        format: 'html',
        content: new TextEncoder().encode('<!doctype html><html><body><h1>Results</h1><p>Scores for the week went up by a third.</p></body></html>'),
      });
      if (!published.ok) throw new Error(published.refusal.message);
      const id = published.documentId;
      const read = await getLiveDoc(id, MOCK_USER, { format: 'markdown', storage });
      if (!read.ok) throw new Error(read.refusal.message);
      const target = read.value.pages![0]!.texts.find((t) => t.text.includes('Scores for'))!.target;
      const made = await createLiveThread(new NoopNotifier(), MOCK_USER, id, {
        anchor: { type: 'prose', target, quote: 'Scores for the week went up by a third.' },
        body: 'Source?',
      });
      if (!made.ok) throw new Error(made.refusal.message);
      const before = await getLiveDoc(id, MOCK_USER, { format: 'markdown' });
      if (!before.ok) throw new Error(before.refusal.message);

      // The text is retyped (cleared, then written reworded): its comment mark is gone.
      await applyPlan(id, SYSTEM_ORIGIN, { onConflict: 'refuse', edits: [setPidText(target, '')] });
      await applyPlan(id, SYSTEM_ORIGIN, { onConflict: 'refuse', edits: [setPidText(target, 'Scores for the week went up by about a third.')] });
      await withLiveDoc(id, (doc) => syncOrphans(id, doc));
      expect((await loadThread(made.value.id))!.orphaned).toBe(true);

      // Agents' delta reads (and catch-up, and highlights) see the page block as changed.
      const delta = await getLiveDoc(id, MOCK_USER, { format: 'markdown', since: before.value.docVersion });
      expect(delta.ok && delta.value.blocks.map((b) => b.target.blockId)).toEqual([target.blockId]);
      expect(delta.ok && delta.value.deletedIds).toEqual([]);

      const out = await reanchorThread(MOCK_USER, made.value.id, {});
      expect(out.ok && out.value.anchor).toEqual({ type: 'prose', target, quote: 'Scores for the week went up by about a third.' });
      expect(out.ok && out.value.orphaned).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
