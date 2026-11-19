import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import { docRecords, documentCollaborators, events } from '../db/schema.ts';
import { applyPlan } from './pipeline.ts';
import { recordsApi } from '../records/store.ts';
import { AGENT, OWNER, READER, VIEWER, seedRecordsDoc } from '../records/records.testlib.ts';
import { addChoice, choiceTally, exportDecisions, flushDecisionSync, listDecisions, pick, proposePick, vote } from './choices.ts';
import { exportHtml, exportMarkdown } from './export.ts';
import { serverEditor } from './editor.ts';
import { withLiveDoc } from './live.testlib.ts';
import type { Target } from '@polygonlabs/primer-api-types';

const EDITOR = { kind: 'person' as const, actorId: OWNER.id, runId: null };

/** Rewrites a choice's props the way an editor's client can. */
async function setChoiceProps(doc: string, target: Target, props: Record<string, string>) {
  await applyPlan(doc, EDITOR, {
    onConflict: 'refuse',
    edits: [{ target, inverse: false, build: (tr, at) => void tr.setNodeMarkup(at!.pos, undefined, { ...at!.node.attrs, ...props }) }],
  });
}
import { documents } from '../db/schema.ts';

/** A live document owned by OWNER; VIEWER responds, READER comments, AGENT acts for OWNER. */
async function liveDoc(): Promise<string> {
  const id = await seedRecordsDoc();
  await db.update(documents).set({ format: 'markdown' }).where(eq(documents.id, id));
  return id;
}

async function choiceIn(doc: string) {
  const out = await addChoice(AGENT, doc, { question: 'Which database?', options: ['Postgres', 'SQLite', 'DuckDB'] });
  if (!out.ok) throw new Error(out.refusal.message);
  return out.value;
}

describe('choice blocks', () => {
  it('votes tally per option and one vote per person', async () => {
    const doc = await liveDoc();
    const { target, optionIds: [pg, lite, duck] } = await choiceIn(doc);
    const choiceId = target.blockId;

    expect((await vote(OWNER, doc, choiceId, pg)).ok).toBe(true);
    expect((await vote(VIEWER, doc, choiceId, pg)).ok).toBe(true);
    // A second vote replaces the first: one vote per person.
    const changed = await vote(VIEWER, doc, choiceId, lite);
    expect(changed).toEqual({ ok: true, value: { counts: { [pg!]: 1, [lite!]: 1, [duck!]: 0 }, mine: lite, decision: null } });

    // Agents propose, never vote; commenters can't write records.
    expect(await vote(AGENT, doc, choiceId, pg)).toMatchObject({ ok: false, refusal: { code: 'forbidden' } });
    expect(await vote(READER, doc, choiceId, pg)).toMatchObject({ ok: false, refusal: { code: 'forbidden' } });
    // The general records verbs never write votes.
    const collection = `primer.choice/${choiceId}`;
    expect(
      await recordsApi(VIEWER, doc).set({ collection, scope: 'shared', recordId: READER.id, data: { optionId: pg } }),
    ).toMatchObject({ ok: false, refusal: { code: 'bad_request' } });
    expect(
      await recordsApi(AGENT, doc).batch({ ops: [{ verb: 'set', collection, scope: 'shared', recordId: AGENT.id, data: { optionId: pg } }] }),
    ).toMatchObject({ ok: false, refusal: { code: 'bad_request' } });
    // Rows that got there anyway count only when a person wrote their own vote:
    // an agent's self-keyed row and a vote for a missing option don't.
    await db.insert(docRecords).values({
      documentId: doc, collection, recordId: AGENT.id, scope: 'shared', data: { optionId: pg }, contributors: [AGENT.id], version: 1, updatedBy: AGENT.id,
    });
    await db.update(docRecords).set({ data: { optionId: 'nope' } }).where(and(eq(docRecords.documentId, doc), eq(docRecords.recordId, OWNER.id)));

    const tally = await choiceTally(VIEWER, doc, choiceId);
    expect(tally.ok && tally.value.counts[pg!]).toBe(0);
    expect(tally.ok && tally.value.counts[lite!]).toBe(1);
    expect(tally.ok && tally.value.mine).toBe(lite);
  });

  it('register lists decided choices with rationale', async () => {
    const doc = await liveDoc();
    const first = await choiceIn(doc);
    const second = await choiceIn(doc);
    const [pg, lite] = first.optionIds;
    await vote(VIEWER, doc, first.target.blockId, lite);

    // An agent proposes; only a person with edit rights decides.
    expect((await proposePick(AGENT, doc, first.target.blockId, { optionId: pg!, note: 'Mature tooling' })).ok).toBe(true);
    expect(await pick(AGENT, doc, first.target.blockId, { optionId: pg! })).toMatchObject({ ok: false, refusal: { code: 'forbidden' } });
    expect(await pick(VIEWER, doc, first.target.blockId, { optionId: pg! })).toMatchObject({ ok: false, refusal: { code: 'forbidden' } });
    expect(
      await pick(OWNER, doc, first.target.blockId, { optionId: 'not-an-option' }),
    ).toMatchObject({ ok: false, refusal: { code: 'bad_request' } });

    const picked = await pick(OWNER, doc, first.target.blockId, {
      optionId: pg!,
      rationale: 'We already run it.',
      evidence: [{ label: 'Benchmarks', url: 'https://example.com/bench' }],
      openQuestions: ['Who owns backups?'],
    });
    expect(picked.ok).toBe(true);
    expect(await vote(VIEWER, doc, first.target.blockId, pg)).toMatchObject({ ok: false, refusal: { code: 'choice_decided' } });

    const register = await listDecisions(AGENT, doc);
    if (!register.ok) throw new Error(register.refusal.message);
    expect(register.value.decisions.map((d) => [d.target.blockId, d.status])).toEqual([
      [first.target.blockId, 'decided'],
      [second.target.blockId, 'open'],
    ]);
    expect(register.value.decisions[0]).toMatchObject({
      question: 'Which database?',
      untrusted: true,
      proposed: null,
      decided: {
        optionId: pg,
        label: 'Postgres',
        rationale: 'We already run it.',
        evidence: [{ label: 'Benchmarks', url: 'https://example.com/bench' }],
        openQuestions: ['Who owns backups?'],
        decidedBy: OWNER.id,
        decidedByName: 'Ada',
      },
    });
    expect(register.value.decisions[0]!.options.find((o) => o.id === lite)?.votes).toBe(1);

    // decision.made wakes whoever watches the document; ids only.
    const made = await db.select().from(events).where(and(eq(events.documentId, doc), eq(events.type, 'decision.made')));
    expect(made.map((e) => [e.authorId, e.payload])).toEqual([
      [OWNER.id, { document_id: doc, block_id: first.target.blockId, option_id: pg, decided_by: OWNER.id }],
    ]);
  });

  it('decision props forged in the document never count as a decision', async () => {
    const doc = await liveDoc();
    const { target, optionIds } = await choiceIn(doc);
    // An editor's client writes the decision props directly, claiming someone decided.
    await setChoiceProps(doc, target, { decidedOptionId: optionIds[0]!, decidedBy: VIEWER.id, decidedByName: 'Forger', rationale: 'forged' });
    const register = await listDecisions(OWNER, doc);
    expect(register.ok && register.value.decisions.map((d) => [d.status, d.decided])).toEqual([['open', null]]);
    const tally = await choiceTally(OWNER, doc, target.blockId);
    expect(tally.ok && tally.value.decision).toBeNull();
    expect((await vote(VIEWER, doc, target.blockId, optionIds[0])).ok).toBe(true);
    expect(await db.select().from(events).where(and(eq(events.documentId, doc), eq(events.type, 'decision.made')))).toEqual([]);

    // Nor in an export or the static rendering.
    const exports = async () =>
      withLiveDoc(doc, async (d) => {
        const decisions = await exportDecisions(doc);
        return [await exportMarkdown(d, doc, decisions), await exportHtml(d, 'Doc', decisions)].join('\n');
      });
    const forged = await exports();
    expect(forged).not.toContain('forged');
    expect(forged).not.toContain('Forger');
    expect(forged).not.toContain('Decision:');

    // A real pick shows there, with who made it as the server knows them.
    const choice = await choiceIn(doc);
    await pick(OWNER, doc, choice.target.blockId, { optionId: choice.optionIds[2]!, rationale: 'Fast reads' });
    const real = await exports();
    expect(real).toContain('Fast reads');
    expect(real).toContain('Ada');
    expect(real).not.toContain('Forger');
  });

  it('relabelling after a pick keeps what was decided and flags the change', async () => {
    const doc = await liveDoc();
    const { target, optionIds } = await choiceIn(doc);
    await pick(OWNER, doc, target.blockId, { optionId: optionIds[0]!, rationale: 'Known quantity' });
    await setChoiceProps(doc, target, { question: 'Which cache?' });
    // Relabel the decided option's text.
    await applyPlan(doc, EDITOR, {
      onConflict: 'refuse',
      edits: [{
        target: { tabId: 'main', blockId: optionIds[0]! },
        inverse: false,
        build: (tr, at) => {
          const para = at!.node.firstChild!; // the option's first block
          const from = at!.pos + 1 + 2;
          tr.replaceWith(from, from + para.firstChild!.content.size, serverEditor().editor.pmSchema.text('Redis'));
        },
      }],
    });
    const register = await listDecisions(OWNER, doc);
    const entry = register.ok ? register.value.decisions[0]! : null;
    expect(entry?.question).toBe('Which cache?');
    expect(entry?.decided).toMatchObject({ question: 'Which database?', label: 'Postgres', changedSinceDecided: true });
    expect(entry?.options[0]?.label).toBe('Redis');
  });

  it('deleting a decided choice and reusing its id leaves it undecided', async () => {
    const doc = await liveDoc();
    const { target, optionIds } = await choiceIn(doc);
    await pick(OWNER, doc, target.blockId, { optionId: optionIds[0]! });
    // Remove the block, as any editor can.
    await applyPlan(doc, EDITOR, {
      onConflict: 'refuse',
      edits: [{ target, inverse: false, build: (tr, at) => void tr.delete(at!.pos, at!.pos + at!.node.nodeSize) }],
    });
    await flushDecisionSync();
    expect((await listDecisions(OWNER, doc)).ok).toBe(true);
    // The same ids come back (pasted or written by a client).
    const node = serverEditor().editor.pmSchema.nodeFromJSON({
      type: 'choice',
      attrs: { id: target.blockId, question: 'Which database?' },
      content: optionIds.map((id, i) => ({
        type: 'choiceOption',
        attrs: { id },
        content: [{ type: 'blockContainer', attrs: { id: `${id}-p` }, content: [{ type: 'paragraph', content: [{ type: 'text', text: `Option ${i}` }] }] }],
      })),
    });
    await applyPlan(doc, EDITOR, {
      onConflict: 'refuse',
      edits: [{ target: { tabId: 'main', blockId: '' }, inverse: false, build: (tr) => void tr.insert(1 + tr.doc.firstChild!.content.size, node) }],
    });
    await flushDecisionSync();
    const register = await listDecisions(OWNER, doc);
    expect(register.ok && register.value.decisions.map((d) => [d.target.blockId, d.status])).toEqual([[target.blockId, 'open']]);
    const tally = await choiceTally(OWNER, doc, target.blockId);
    expect(tally.ok && tally.value.decision).toBeNull();
  });

  it('an editor collaborator decides; a reader sees the register', async () => {
    const doc = await liveDoc();
    await db
      .update(documentCollaborators)
      .set({ role: 'editor' })
      .where(and(eq(documentCollaborators.documentId, doc), eq(documentCollaborators.userId, VIEWER.id)));
    const { target, optionIds } = await choiceIn(doc);
    expect((await pick(VIEWER, doc, target.blockId, { optionId: optionIds[1]! })).ok).toBe(true);
    const register = await listDecisions(READER, doc);
    expect(register.ok && register.value.decisions[0]?.decided?.label).toBe('SQLite');
    expect(register.ok && register.value.decisions[0]?.untrusted).toBeUndefined();
    // Ids from the client-writable document are checked before any lookup.
    expect(await choiceTally(READER, doc, '../x')).toMatchObject({ ok: false, refusal: { code: 'not_found' } });
    expect(await choiceTally(READER, uuidv7(), target.blockId)).toMatchObject({ ok: false, refusal: { code: 'not_found' } });
  });
});
