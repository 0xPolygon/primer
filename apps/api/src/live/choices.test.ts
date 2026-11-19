import { describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import { db } from '../db/client.ts';
import { documentCollaborators, events } from '../db/schema.ts';
import { recordsApi } from '../records/store.ts';
import { AGENT, OWNER, READER, VIEWER, seedRecordsDoc } from '../records/records.testlib.ts';
import { addChoice, choiceTally, listDecisions, pick, proposePick, vote } from './choices.ts';
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
    expect(changed).toEqual({ ok: true, value: { counts: { [pg!]: 1, [lite!]: 1, [duck!]: 0 }, mine: lite } });

    // Agents propose, never vote; commenters can't write records.
    expect(await vote(AGENT, doc, choiceId, pg)).toMatchObject({ ok: false, refusal: { code: 'forbidden' } });
    expect(await vote(READER, doc, choiceId, pg)).toMatchObject({ ok: false, refusal: { code: 'forbidden' } });
    // A vote forged under someone else's id through the generic verbs doesn't count.
    await recordsApi(VIEWER, doc).set({ collection: `primer.choice/${choiceId}`, scope: 'shared', recordId: READER.id, data: { optionId: pg } });
    // Nor does one for an option the choice doesn't have.
    await recordsApi(OWNER, doc).set({ collection: `primer.choice/${choiceId}`, scope: 'shared', recordId: OWNER.id, data: { optionId: 'nope' } });

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
