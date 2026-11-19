import { describe, expect, it } from 'vitest';
import type { AuthUser } from '../app.ts';
import { liveDocName, liveInstance } from './instance.ts';
import { createLiveDoc, makeAgent, markdownOf, ops, paragraph, seedBlocks, until, versions } from './live.testlib.ts';
import { claimRun, requestRun } from './runs.ts';
import { undoRun } from './undo.ts';

const owner: AuthUser = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User', kind: 'person', viaUserId: null };
const main = (blockId: string) => ({ tabId: 'main', blockId });

async function run(documentId: string, agent: AuthUser): Promise<string> {
  const out = await requestRun(owner, documentId, {
    agentId: agent.id,
    request: { kind: 'send', prompt: `edit ${Math.random()}`, viewer: { tabId: 'main', selectedBlockIds: [], cursorBlockId: null } },
  });
  if (!out.ok) throw new Error(out.refusal.message);
  await claimRun(agent, out.value.id);
  return out.value.id;
}

async function undo(runId: string) {
  const out = await undoRun(runId, owner);
  if (!out.ok) throw new Error(out.refusal.message);
  return out.value;
}

async function setup() {
  const agent = await makeAgent();
  const id = await createLiveDoc();
  await seedBlocks(id, [paragraph('a', 'Alpha'), paragraph('b', 'Beta'), paragraph('c', 'Gamma'), paragraph('d', 'Delta')]);
  return { agent, id, runId: await run(id, agent) };
}

describe('undoRun', () => {
  it("undo removes the run's edits and keeps a person's later edit in another block", async () => {
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, {
      runId,
      ops: [
        { op: 'update', target: main('a'), block: 'Alpha by agent', expectVersion: v.a },
        { op: 'replaceRange', from: main('b'), to: main('c'), blocks: ['X\n\nY\n\nZ'], expectVersions: { b: v.b, c: v.c } },
      ],
    });
    // A person edits another block afterwards.
    await ops(id, owner, { ops: [{ op: 'update', target: main('d'), block: 'Delta by person', expectVersion: v.d }] });

    const result = await undo(runId);
    expect(result.outcomes.every((o) => o.status === 'applied')).toBe(true);
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta by person']);
  });

  it('undo after a restart works', async () => {
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, { runId, ops: [{ op: 'update', target: main('b'), block: 'Beta by agent', expectVersion: v.b }] });

    // Drop the in-memory document (as a restart would), once its pending store is done.
    await until(async () => {
      const document = liveInstance().documents.get(liveDocName(id));
      if (document) await liveInstance().unloadDocument(document);
      return !liveInstance().documents.has(liveDocName(id));
    }, 10_000);

    await undo(runId);
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  }, 15_000);

  it('a block changed since the run becomes a restore suggestion', async () => {
    // Until suggestions land (M5) the block is left untouched and reported
    // as a conflict; M5 turns that conflict into a restore suggestion.
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, {
      runId,
      ops: [
        { op: 'update', target: main('a'), block: 'Alpha by agent', expectVersion: v.a },
        { op: 'update', target: main('b'), block: 'Beta by agent', expectVersion: v.b },
      ],
    });
    const w = await versions(id, agent);
    await ops(id, owner, { ops: [{ op: 'update', target: main('b'), block: 'Beta by person', expectVersion: w.b }] });

    const result = await undo(runId);
    const byBlock = Object.fromEntries(result.outcomes.map((o) => [o.target.blockId, o]));
    expect(byBlock.a).toMatchObject({ status: 'applied' });
    expect(byBlock.b).toMatchObject({ status: 'conflict', refusal: { code: 'target_changed' } });
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta by person', 'Gamma', 'Delta']);
  });

  it('blocks and fragments the run created are removed', async () => {
    const { agent, id, runId } = await setup();
    await ops(id, agent, {
      runId,
      ops: [
        { op: 'add', at: main('a'), position: 'after', blocks: ['- one\n  - nested\n- two'] },
        { op: 'add', at: main('d'), position: 'after', blocks: ['Tail'] },
      ],
    });
    expect((await markdownOf(id, agent)).length).toBe(8);

    await undo(runId);
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });

  it('undo of a delete puts the blocks back in place', async () => {
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, {
      runId,
      ops: [
        { op: 'delete', target: main('b'), expectVersion: v.b },
        { op: 'delete', target: main('c'), expectVersion: v.c },
      ],
    });
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Delta']);

    await undo(runId);
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
    expect(Object.keys(await versions(id, agent))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('undo of a move puts the block back', async () => {
    const { agent, id, runId } = await setup();
    const v = await versions(id, agent);
    await ops(id, agent, { runId, ops: [{ op: 'move', target: main('a'), at: main('c'), position: 'after', expectVersion: v.a }] });
    expect(await markdownOf(id, agent)).toEqual(['Beta', 'Gamma', 'Alpha', 'Delta']);

    await undo(runId);
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'Beta', 'Gamma', 'Delta']);
  });
});
