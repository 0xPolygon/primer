import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import type { AgentRunRequest } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { agentAwareness, agentClientId } from './awareness.ts';
import { liveDocName, liveInstance } from './instance.ts';
import { applyOps } from './ops.ts';
import { comment, createLiveDoc, makeAgent, markdownOf, ops, paragraph, seedBlocks, startTestHub, until, versions } from './live.testlib.ts';
import { approveRun, cancelRun, claimRun, finishRun, LARGE_RUN_EDITS, requestRun, retryRun, updateRunStatus } from './runs.ts';

const owner: AuthUser = { id: 'mock-user-1', email: 'mock@example.com', displayName: 'Mock User', kind: 'person', viaUserId: null };
const main = (blockId: string) => ({ tabId: 'main', blockId });
const ask = (prompt = 'Tighten the intro'): AgentRunRequest => ({
  kind: 'send',
  prompt,
  viewer: { tabId: 'main', selectedBlockIds: ['a'], cursorBlockId: 'a' },
});

async function startedRun(documentId: string, agent: AuthUser, prompt?: string) {
  const out = await requestRun(owner, documentId, { agentId: agent.id, request: ask(prompt) });
  if (!out.ok) throw new Error(out.refusal.message);
  const claimed = await claimRun(agent, out.value.id);
  if (!claimed.ok) throw new Error(claimed.refusal.message);
  return claimed.value;
}

const addOne = (text: string) => ({ op: 'add', at: main('a'), position: 'after', blocks: [text] });

describe('agent runs', () => {
  it('duplicate ask while queued returns the existing run', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    const first = await requestRun(owner, id, { agentId: agent.id, request: ask() });
    const second = await requestRun(owner, id, { agentId: agent.id, request: ask() });
    const other = await requestRun(owner, id, { agentId: agent.id, request: ask('Something else') });
    expect(first.ok && second.ok && other.ok).toBe(true);
    if (!first.ok || !second.ok || !other.ok) return;
    expect(second.value.id).toBe(first.value.id);
    expect(other.value.id).not.toBe(first.value.id);
    const events = (await db.execute(sql`
      SELECT count(*)::int AS n FROM events WHERE document_id = ${id} AND namespace = 'primer' AND type = 'run.requested'
    `)) as unknown as { n: number }[];
    expect(events[0]!.n).toBe(2);
  });

  it('plan approval on a cancelled run is refused (409)', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    const run = await startedRun(id, agent);
    await updateRunStatus(agent, run.id, { plan: 'Rewrite every section.' });

    // An agent never approves a plan, even with its person's editor role.
    expect(await approveRun(agent, run.id)).toMatchObject({ ok: false, status: 403 });

    expect((await cancelRun(owner, run.id)).ok).toBe(true);
    expect(await approveRun(owner, run.id)).toMatchObject({ ok: false, status: 409, refusal: { code: 'run_cancelled' } });
  });

  it('cancel stops further ops', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha')]);
    const run = await startedRun(id, agent);

    expect((await ops(id, agent, { runId: run.id, ops: [addOne('One')] })).outcomes[0]!.status).toBe('applied');
    await cancelRun(owner, run.id);
    const after = await ops(id, agent, { runId: run.id, ops: [addOne('Two')] });
    expect(after.outcomes[0]).toMatchObject({ status: 'conflict', refusal: { code: 'run_cancelled' } });
    expect(await markdownOf(id, agent)).toEqual(['Alpha', 'One']);
    // Finishing a cancelled run is refused too.
    expect(await finishRun(agent, run.id, {})).toMatchObject({ ok: false, refusal: { code: 'run_cancelled' } });
  });

  it('retry creates a new run with the same request', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    const run = await startedRun(id, agent, 'Summarise');
    await finishRun(agent, run.id, { error: 'model timed out' });

    const retried = await retryRun(owner, run.id);
    expect(retried.ok).toBe(true);
    if (!retried.ok) return;
    expect(retried.value.id).not.toBe(run.id);
    expect(retried.value).toMatchObject({ status: 'queued', request: run.request, agentId: agent.id });
  });

  it('cancel racing an apply: the apply either fully lands before cancel or is refused', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha')]);
    const jitter = () => new Promise((r) => setTimeout(r, Math.floor(Math.random() * 4)));

    for (let i = 0; i < 100; i++) {
      const run = await startedRun(id, agent, `race ${i}`);
      await updateRunStatus(agent, run.id, { plan: 'A plan.' });
      const [applied, cancelled, approved] = await Promise.all([
        jitter().then(() => applyOps(id, agent, { baseVersion: 0, runId: run.id, ops: [addOne(`R${i} one`), addOne(`R${i} two`)] })),
        jitter().then(() => cancelRun(owner, run.id)),
        jitter().then(() => approveRun(owner, run.id)),
      ]);
      expect(cancelled.ok).toBe(true);
      if (!applied.ok) throw new Error(JSON.stringify(applied));
      const statuses = applied.value.outcomes.map((o) => o.status);
      const rows = (await db.execute(sql`
        SELECT count(*)::int AS n FROM doc_updates WHERE document_id = ${id} AND run_id = ${run.id}
      `)) as unknown as { n: number }[];
      if (statuses[0] === 'applied') {
        expect(statuses).toEqual(['applied', 'applied']);
        expect(rows[0]!.n).toBe(1);
      } else {
        expect(applied.value.outcomes.every((o) => o.refusal?.code === 'run_cancelled')).toBe(true);
        expect(rows[0]!.n).toBe(0);
      }
      // An approval either landed before the cancel or was refused after it.
      if (!approved.ok) expect(approved.refusal.code).toBe('run_cancelled');
    }
    const blocks = await markdownOf(id, agent);
    for (let i = 0; i < 100; i++) {
      expect(blocks.filter((b) => b.startsWith(`R${i} `)).length % 2).toBe(0);
    }
  });

  it('a large run needs an approved plan: of two concurrent batches crossing the threshold, exactly one applies', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha')]);
    const run = await startedRun(id, agent);
    await db.execute(sql`UPDATE agent_runs SET edits_applied = ${LARGE_RUN_EDITS - 10} WHERE id = ${run.id}`);
    const batch = (tag: string) => Array.from({ length: 6 }, (_, k) => addOne(`${tag}${k}`));

    const results = await Promise.all([
      ops(id, agent, { runId: run.id, ops: batch('x') }),
      ops(id, agent, { runId: run.id, ops: batch('y') }),
    ]);
    const passed = results.filter((r) => r.outcomes.every((o) => o.status === 'applied'));
    const held = results.filter((r) => r.outcomes.every((o) => o.refusal?.code === 'approval_required'));
    expect([passed.length, held.length]).toEqual([1, 1]);

    await updateRunStatus(agent, run.id, { plan: 'Add the remaining sections.' });
    expect((await approveRun(owner, run.id)).ok).toBe(true);
    const after = await ops(id, agent, { runId: run.id, ops: batch('z') });
    expect(after.outcomes.every((o) => o.status === 'applied')).toBe(true);
  });

  it('ids planted from another document are refused and never touch it', async () => {
    const agent = await makeAgent();
    const a = await createLiveDoc();
    const b = await createLiveDoc();
    await seedBlocks(a, [paragraph('a', 'Alpha'), paragraph('x', 'Commented in B')]);
    await seedBlocks(b, [paragraph('b', 'Beta')]);
    const runOfB = await startedRun(b, agent);

    // A run of document B can't carry ops on document A.
    const out = await applyOps(a, agent, { baseVersion: 0, runId: runOfB.id, ops: [addOne('nope')] });
    expect(out).toMatchObject({ ok: false, status: 404 });
    const [counts] = (await db.execute(sql`
      SELECT edits_applied AS "editsApplied" FROM agent_runs WHERE id = ${runOfB.id}
    `)) as unknown as { editsApplied: number }[];
    expect(counts!.editsApplied).toBe(0);

    // A thread of document B can't be the subject of a run on A.
    const threadOfB = await comment(b, 'b', 'Beta');
    const asked = await requestRun(owner, a, { agentId: agent.id, request: { ...ask(), kind: 'mention', threadId: threadOfB } });
    expect(asked).toMatchObject({ ok: false, status: 400 });

    // A comment mark in A naming B's open thread doesn't hold A's text.
    const planted = await comment(a, 'x', 'Commented');
    await db.execute(sql`UPDATE threads SET document_id = ${b} WHERE id = ${planted}`);
    const v = await versions(a, agent);
    const deleted = await ops(a, agent, { ops: [{ op: 'delete', target: main('x'), expectVersion: v.x }] });
    expect(deleted.outcomes[0]!.status).toBe('applied');
  });
});

describe('agent awareness', () => {
  let hub: Awaited<ReturnType<typeof startTestHub>>;
  beforeAll(async () => {
    hub = await startTestHub();
  });
  afterAll(async () => {
    await hub.close();
  });

  it('awareness shows the agent status line and clears on finish', async () => {
    const agent = await makeAgent();
    const id = await createLiveDoc();
    await seedBlocks(id, [paragraph('a', 'Alpha'), paragraph('b', 'Beta')]);
    const { provider } = await hub.connect(id, 'mock-user-1');
    const clientId = agentClientId(agent.id);
    const stateOf = () => provider.awareness!.getStates().get(clientId) as
      | { user: { name: string; color: string }; status: string; cursor: { anchor: unknown; head: unknown } | null }
      | undefined;

    const run = await startedRun(id, agent);
    await updateRunStatus(agent, run.id, { statusLine: 'Drafting the summary' });
    await until(() => stateOf()?.status === 'Drafting the summary');
    expect(stateOf()!.user.name).toBe('Helper');

    const v = await versions(id, agent);
    await ops(id, agent, { runId: run.id, ops: [{ op: 'update', target: main('b'), block: 'Beta 2', expectVersion: v.b }] });
    await until(() => stateOf()?.cursor !== null && stateOf()?.cursor !== undefined);
    expect(stateOf()!.cursor!.anchor).toMatchObject({ type: expect.anything() });

    // The heartbeat renews the state before peers would drop it (30 s).
    const server = liveInstance().documents.get(liveDocName(id))!;
    const clock = server.awareness.meta.get(clientId)!.clock;
    // Its own state last renewed 20 s ago: the next check (every 3 s) renews it.
    agentAwareness(id, agent.id)!.meta.get(clientId)!.lastUpdated -= 20_000;
    await until(() => server.awareness.meta.get(clientId)!.clock > clock, 5000);

    await finishRun(agent, run.id, {});
    await until(() => stateOf() === undefined);
  }, 15_000);
});
