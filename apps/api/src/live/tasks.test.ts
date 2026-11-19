import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client.ts';
import { docTasks, documents, events } from '../db/schema.ts';
import { AGENT, OWNER, READER, seedRecordsDoc } from '../records/records.testlib.ts';
import { readBlocks } from './editor.ts';
import { seedBlocks, withLiveDoc } from './live.testlib.ts';
import { addTask, flushTaskSync, listDocumentTasks, listMyTasks, rebuildTaskIndex, updateTask } from './tasks.ts';

async function liveDoc(): Promise<string> {
  const id = await seedRecordsDoc();
  await db.update(documents).set({ format: 'markdown' }).where(eq(documents.id, id));
  return id;
}

async function taskEvents(doc: string) {
  const rows = await db.select().from(events).where(eq(events.documentId, doc)).orderBy(events.id);
  return rows.filter((r) => r.type.startsWith('task.')).map((r) => ({ type: r.type, author: r.authorId, payload: r.payload }));
}

describe('task blocks', () => {
  it('adding a task block creates a tracked task and emits task.created', async () => {
    const doc = await liveDoc();
    const added = await addTask(OWNER, doc, { title: 'Draft the launch note', assigneeId: AGENT.id, due: '2026-12-01' });
    if (!added.ok) throw new Error(added.refusal.message);
    await flushTaskSync();

    const listed = await listDocumentTasks(READER, doc);
    expect(listed.ok && listed.value.tasks).toEqual([
      expect.objectContaining({
        target: added.value.target,
        title: 'Draft the launch note',
        assigneeId: AGENT.id,
        due: '2026-12-01',
        status: 'open',
        createdBy: OWNER.id,
      }),
    ]);
    const [task] = listed.ok ? listed.value.tasks : [];
    expect(await taskEvents(doc)).toEqual([
      {
        type: 'task.created',
        author: OWNER.id,
        payload: { document_id: doc, task_id: task!.id, block_id: added.value.target.blockId, assignee_id: AGENT.id, status: 'open' },
      },
    ]);
    // The assignee finds it across documents, fenced: people wrote the title.
    const mine = await listMyTasks(AGENT);
    expect(mine.ok && mine.value.tasks.map((t) => [t.id, t.untrusted])).toEqual([[task!.id, true]]);
  });

  it('checking it off updates status', async () => {
    const doc = await liveDoc();
    const added = await addTask(OWNER, doc, { title: 'Collect numbers', assigneeId: AGENT.id });
    if (!added.ok) throw new Error(added.refusal.message);
    await flushTaskSync();

    // The agent reports progress inline: shown in the block, no event.
    expect((await updateTask(AGENT, doc, added.value.target.blockId, { progress: 'Pulled Q3, Q4 next' })).ok).toBe(true);
    await flushTaskSync();
    expect(await taskEvents(doc)).toHaveLength(1);

    // A person ticks the box.
    expect((await updateTask(OWNER, doc, added.value.target.blockId, { status: 'done' })).ok).toBe(true);
    await flushTaskSync();
    const [row] = await db.select().from(docTasks).where(eq(docTasks.documentId, doc));
    expect(row!.status).toBe('done');
    const all = await taskEvents(doc);
    expect(all[1]).toEqual({
      type: 'task.updated',
      author: OWNER.id,
      payload: expect.objectContaining({ assignee_id: AGENT.id, status: 'done', changed: ['status'] }),
    });
    await withLiveDoc(doc, (d) => {
      const block = readBlocks(d, 'main').find((b) => b.id === added.value.target.blockId)!;
      expect(block.props).toMatchObject({ status: 'done', progress: 'Pulled Q3, Q4 next' });
    });
    // A reader can't tick it.
    expect(await updateTask(READER, doc, added.value.target.blockId, { status: 'open' })).toMatchObject({
      ok: false,
      refusal: { code: 'forbidden' },
    });
  });

  it('the index is rebuilt from the document, checking what it reads', async () => {
    const doc = await liveDoc();
    // Written straight into the (client-writable) document: an unknown
    // assignee, a malformed date and a block id no storage key may hold.
    await seedBlocks(doc, [
      { id: 'task-1', type: 'task', props: { assigneeId: 'ghost', due: '2026-13-45' }, content: 'Ghost task' } as never,
      { id: 'bad/../id', type: 'task', content: 'Skipped' } as never,
    ]);
    await flushTaskSync();
    await db.delete(docTasks).where(eq(docTasks.documentId, doc));
    await rebuildTaskIndex(doc);
    const rows = await db.select().from(docTasks).where(and(eq(docTasks.documentId, doc)));
    expect(rows.map((r) => [r.blockId, r.title, r.assigneeId, r.dueDate])).toEqual([['task-1', 'Ghost task', null, null]]);
    // The first sync announced it, authored by the owner (the system made the change).
    expect((await taskEvents(doc)).map((e) => [e.type, e.author])).toEqual([['task.created', OWNER.id]]);
  });
});
