// Choice blocks: votes, picks, proposals and the decision register.
//
// - A choice is a layout block whose children are `choiceOption` blocks; an
//   option's id is its block id. Choices live in the document.
// - Votes are shared records in `primer.choice/<choiceId>`, one per voter,
//   keyed by the voter's id. Only people vote, through `vote` here, which
//   forces the record id to the caller; the general records verbs never write
//   `primer.` collections. A vote counts only when its record was last written
//   by the person it is keyed by and names a current option.
// - The decision is a `doc_decisions` row, written only by `pick` (people with
//   edit rights) in the same transaction as its `decision.made` event. The
//   block's decision props are a display mirror for exports; nothing reads
//   them back, since the document is client-writable. Agents may `propose` a
//   pick (the `proposed*` props), never make it.
// - The register is a read-time projection over the choice blocks, joined
//   with their decisions: a choice deleted from the document leaves it.
import {
  MAX_CHOICE_LIST,
  MAX_CHOICE_OPTIONS,
  MAX_CHOICE_TEXT,
  choiceVotesCollection,
  type AddChoiceRequest,
  type AddChoiceResponse,
  type ChoiceEvidence,
  type ChoiceTallyResponse,
  type DecisionDTO,
  type DecisionsResponse,
  type PickRequest,
  type ProposePickRequest,
  type Refusal,
} from '@polygonlabs/primer-api-types';
import { optionLabel } from '@primer/blocks';
import type { ChoiceDecisionDTO } from '@polygonlabs/primer-api-types';
import { sql } from 'drizzle-orm';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { actorNameOf } from '../lib/actors.ts';
import { transactionWithEvents } from '../lib/events.ts';
import { recordsApi } from '../records/store.ts';
import {
  checkPlacement,
  findLiveBlock,
  insertBlock,
  liveBlocks,
  liveDocAccess,
  newBlockId,
  refuse,
  setBlockProps,
  validBlockId,
  type Result,
} from './blockTools.ts';
import type { PrimerBlock } from './editor.ts';
import { onLiveUpdate, withLiveDocument } from './instance.ts';
import { logger } from '../logger.ts';
import type { ExportDecision, ExportDecisions } from './export.ts';

type Option = { id: string; label: string };

function optionsOf(block: PrimerBlock): Option[] {
  return (block.children as unknown as PrimerBlockLike[])
    .filter((c) => c.type === 'choiceOption')
    .map((c) => ({ id: c.id, label: optionLabel(c as never) }));
}

type PrimerBlockLike = { id: string; type: string; props: Record<string, unknown>; children: PrimerBlockLike[] };

function label(actor: AuthUser): string {
  return actor.kind === 'agent' ? `${actor.displayName} (agent)` : actor.displayName;
}

async function readChoice(documentId: string, choiceId: string) {
  return withLiveDocument(documentId, (doc) => {
    const found = findLiveBlock(doc, choiceId, 'choice');
    if (!found) return null;
    const props = found.block.props as Record<string, string>;
    return { tabId: found.tabId, props, options: optionsOf(found.block) };
  });
}

// ───────────────────────── Votes ─────────────────────────

/** Votes per current option: a record counts only when it was last written
 *  by the person it is keyed by (see the module comment). */
async function countVotes(actor: AuthUser, documentId: string, choiceId: string, options: Option[]): Promise<ChoiceTallyResponse> {
  const rows = (await db.execute(sql`
    SELECT r.record_id AS "voterId", r.data->>'optionId' AS "optionId"
      FROM doc_records r JOIN users u ON u.id = r.updated_by
     WHERE r.document_id = ${documentId} AND r.collection = ${choiceVotesCollection(choiceId)}
       AND r.scope = 'shared' AND r.record_id = r.updated_by AND u.kind = 'person'
  `)) as unknown as { voterId: string; optionId: string | null }[];
  const counts: Record<string, number> = Object.fromEntries(options.map((o) => [o.id, 0]));
  let mine: string | null = null;
  for (const r of rows) {
    if (!r.optionId || !(r.optionId in counts)) continue;
    counts[r.optionId]! += 1;
    if (r.voterId === actor.id) mine = r.optionId;
  }
  return { counts, mine, decision: null };
}

/** Decisions recorded for these choices, keyed by block id. */
async function decisionsOf(documentId: string, choiceIds: string[]): Promise<Map<string, ChoiceDecisionDTO>> {
  if (choiceIds.length === 0) return new Map();
  const rows = (await db.execute(sql`
    SELECT d.block_id AS "blockId", d.option_id AS "optionId", d.question, d.option_label AS label,
           d.rationale, d.evidence, d.open_questions AS "openQuestions",
           d.decided_by AS "decidedBy", ${actorNameOf('u')} AS "decidedByName", d.decided_at AS "decidedAt"
      FROM doc_decisions d JOIN users u ON u.id = d.decided_by
     WHERE d.document_id = ${documentId} AND d.block_id IN ${sql`(${sql.join(choiceIds.map((id) => sql`${id}`), sql`, `)})`}
  `)) as unknown as (Omit<ChoiceDecisionDTO, 'decidedAt' | 'changedSinceDecided'> & { blockId: string; decidedAt: Date | string })[];
  return new Map(
    rows.map((r) => [
      r.blockId,
      {
        optionId: r.optionId,
        question: r.question,
        label: r.label,
        changedSinceDecided: false,
        rationale: r.rationale,
        evidence: r.evidence,
        openQuestions: r.openQuestions,
        decidedBy: r.decidedBy,
        decidedByName: r.decidedByName,
        decidedAt: (r.decidedAt instanceof Date ? r.decidedAt : new Date(r.decidedAt)).toISOString(),
      },
    ]),
  );
}

/** A recorded decision as it stands against the live choice: none once the
 *  decided option is gone; flagged when the question or the option's label
 *  changed after the pick (the saved text is what was decided). */
function standing(d: ChoiceDecisionDTO | undefined, question: string, options: Option[]): ChoiceDecisionDTO | null {
  const option = d && options.find((o) => o.id === d.optionId);
  if (!d || !option) return null;
  return { ...d, changedSinceDecided: d.question !== question || d.label !== option.label };
}

async function decisionFor(documentId: string, choiceId: string, choice: { props: Record<string, string>; options: Option[] }) {
  return standing((await decisionsOf(documentId, [choiceId])).get(choiceId), choice.props.question ?? '', choice.options);
}

export async function choiceTally(actor: AuthUser, documentId: string, choiceId: string): Promise<Result<ChoiceTallyResponse>> {
  if (!validBlockId(choiceId)) return refuse('not_found', 'Choice not found.');
  const access = await liveDocAccess(documentId, actor);
  if (!access.ok) return access;
  const choice = await readChoice(documentId, choiceId);
  if (!choice) return refuse('not_found', 'Choice not found.');
  const tally = await countVotes(actor, documentId, choiceId, choice.options);
  return { ok: true, value: { ...tally, decision: await decisionFor(documentId, choiceId, choice) } };
}

/** Records the caller's vote (`optionId: null` withdraws it). People only. */
export async function vote(actor: AuthUser, documentId: string, choiceId: string, optionId: unknown): Promise<Result<ChoiceTallyResponse>> {
  if (actor.kind !== 'person') {
    return refuse('forbidden', 'Only people vote on a choice.', 'Propose a pick with primer_propose_pick instead.');
  }
  if (!validBlockId(choiceId)) return refuse('not_found', 'Choice not found.');
  if (optionId !== null && !validBlockId(optionId)) return refuse('bad_request', 'optionId must be an option id or null');
  const access = await liveDocAccess(documentId, actor);
  if (!access.ok) return access;
  const choice = await readChoice(documentId, choiceId);
  if (!choice) return refuse('not_found', 'Choice not found.');
  if (await decisionFor(documentId, choiceId, choice)) return refuse('choice_decided', 'This choice is decided.');
  if (optionId !== null && !choice.options.some((o) => o.id === optionId)) {
    return refuse('bad_request', `Option ${optionId} is not an option of this choice.`);
  }
  const api = recordsApi(actor, documentId, { reserved: true });
  const target = { collection: choiceVotesCollection(choiceId), scope: 'shared' as const, recordId: actor.id };
  const out = optionId === null ? await api.delete(target) : await api.set({ ...target, data: { optionId } });
  if (!out.ok) return out;
  return { ok: true, value: await countVotes(actor, documentId, choiceId, choice.options) };
}

// ───────────────────────── Pick and propose ─────────────────────────

function checkText(raw: unknown, name: string, max = MAX_CHOICE_TEXT): string | null {
  if (raw === undefined) return null;
  return typeof raw === 'string' && raw.length <= max ? null : `${name} must be a string of at most ${max} characters`;
}

function checkEvidence(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > MAX_CHOICE_LIST) return `evidence must be a list of at most ${MAX_CHOICE_LIST} entries`;
  for (const [i, e] of raw.entries()) {
    if (typeof e !== 'object' || e === null) return `evidence[${i}] must be { label, url? , docId? }`;
    const { label, url, docId } = e as Record<string, unknown>;
    if (typeof label !== 'string' || label.length === 0 || label.length > 500) return `evidence[${i}].label must be 1–500 characters`;
    if (url !== undefined && (typeof url !== 'string' || !/^https?:\/\/\S{1,2000}$/i.test(url))) return `evidence[${i}].url must be an http(s) link`;
    if (docId !== undefined && (typeof docId !== 'string' || !/^[0-9a-f-]{36}$/i.test(docId))) return `evidence[${i}].docId must be a document id`;
  }
  return null;
}

function checkQuestions(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (!Array.isArray(raw) || raw.length > MAX_CHOICE_LIST) return `openQuestions must be a list of at most ${MAX_CHOICE_LIST} strings`;
  return raw.every((q) => typeof q === 'string' && q.length > 0 && q.length <= 1000) ? null : 'openQuestions must hold strings of 1–1000 characters';
}

/** The pipeline-side check of a choice: still a choice, the option still one
 *  of its options. */
function choiceCheck(optionId: string) {
  return (block: { type: string; childIds: string[] }): Refusal | null => {
    if (block.type !== 'choice') return refuse('not_found', 'Choice not found.').refusal;
    if (!block.childIds.includes(optionId)) return refuse('bad_request', `Option ${optionId} is not an option of this choice.`).refusal;
    return null;
  };
}

/**
 * A person with edit rights decides a choice: the picked option, rationale,
 * evidence and open questions go into the block (and so the register), and
 * `decision.made` wakes whoever watches the document. A later pick replaces
 * the decision.
 */
export async function pick(actor: AuthUser, documentId: string, choiceId: string, req: PickRequest): Promise<Result<{ docVersion: number }>> {
  if (actor.kind !== 'person') {
    return refuse('forbidden', 'Only a person with edit rights can decide a choice.', 'Propose a pick with primer_propose_pick; a person decides.');
  }
  if (!validBlockId(choiceId)) return refuse('not_found', 'Choice not found.');
  const bad =
    (validBlockId(req.optionId) ? null : 'optionId must be an option id') ??
    checkText(req.rationale, 'rationale') ??
    checkEvidence(req.evidence) ??
    checkQuestions(req.openQuestions);
  if (bad) return refuse('bad_request', bad);
  const access = await liveDocAccess(documentId, actor, true);
  if (!access.ok) return access;
  const choice = await readChoice(documentId, choiceId);
  if (!choice) return refuse('not_found', 'Choice not found.');
  const evidence: ChoiceEvidence[] = (req.evidence ?? []).map((e) => ({
    label: e.label,
    ...(e.url ? { url: e.url } : {}),
    ...(e.docId ? { docId: e.docId } : {}),
  }));
  const option = choice.options.find((o) => o.id === req.optionId);
  if (!option) return refuse('bad_request', `Option ${req.optionId} is not an option of this choice.`);
  // The document only loses the pending proposal; the decision is the
  // server's row, with the question and label as they were when decided.
  return setBlockProps(
    actor,
    documentId,
    { tabId: choice.tabId, blockId: choiceId },
    choiceCheck(req.optionId),
    { proposedOptionId: '', proposedBy: '', proposalNote: '' },
    async () => {
      await transactionWithEvents(async (tx, emit) => {
        await tx.execute(sql`
          INSERT INTO doc_decisions (document_id, block_id, option_id, question, option_label, rationale, evidence,
                                     open_questions, decided_by, decided_at)
          VALUES (${documentId}, ${choiceId}, ${req.optionId}, ${choice.props.question ?? ''}, ${option.label},
                  ${req.rationale ?? ''}, ${JSON.stringify(evidence)}::jsonb, ${JSON.stringify(req.openQuestions ?? [])}::jsonb,
                  ${actor.id}, now())
          ON CONFLICT (document_id, block_id) DO UPDATE
            SET option_id = EXCLUDED.option_id, question = EXCLUDED.question, option_label = EXCLUDED.option_label,
                rationale = EXCLUDED.rationale, evidence = EXCLUDED.evidence, open_questions = EXCLUDED.open_questions,
                decided_by = EXCLUDED.decided_by, decided_at = now()
        `);
        emit({
          documentId,
          actorId: actor.id,
          type: 'decision.made',
          payload: { document_id: documentId, block_id: choiceId, option_id: req.optionId, decided_by: actor.id },
        });
      });
    },
  );
}

/** Proposes a pick for a person to confirm (agents, and anyone with edit rights). */
export async function proposePick(
  actor: AuthUser,
  documentId: string,
  choiceId: string,
  req: ProposePickRequest,
): Promise<Result<{ docVersion: number }>> {
  if (!validBlockId(choiceId)) return refuse('not_found', 'Choice not found.');
  const bad = (validBlockId(req.optionId) ? null : 'optionId must be an option id') ?? checkText(req.note, 'note', 1000);
  if (bad) return refuse('bad_request', bad);
  const access = await liveDocAccess(documentId, actor, true);
  if (!access.ok) return access;
  const choice = await readChoice(documentId, choiceId);
  if (!choice) return refuse('not_found', 'Choice not found.');
  if (await decisionFor(documentId, choiceId, choice)) return refuse('choice_decided', 'This choice is decided.');
  return setBlockProps(
    actor,
    documentId,
    { tabId: choice.tabId, blockId: choiceId },
    choiceCheck(req.optionId),
    { proposedOptionId: req.optionId, proposedBy: label(actor), proposalNote: req.note ?? '' },
  );
}

// ───────────────────────── Create ─────────────────────────

/** Adds a choice block, its options in order. Never decided. */
export async function addChoice(actor: AuthUser, documentId: string, req: AddChoiceRequest): Promise<Result<AddChoiceResponse>> {
  const bad =
    (typeof req.question === 'string' && req.question.trim().length > 0 && req.question.length <= 500
      ? null
      : 'question must be 1–500 characters') ??
    (Array.isArray(req.options) &&
    req.options.length >= 2 &&
    req.options.length <= MAX_CHOICE_OPTIONS &&
    req.options.every((o) => typeof o === 'string' && o.trim().length > 0 && o.length <= 500)
      ? null
      : `options must be 2–${MAX_CHOICE_OPTIONS} labels of 1–500 characters`) ??
    checkPlacement(req);
  if (bad) return refuse('bad_request', bad);
  const access = await liveDocAccess(documentId, actor, true);
  if (!access.ok) return access;
  const choiceId = newBlockId();
  const optionIds = req.options.map(() => newBlockId());
  const out = await insertBlock(actor, documentId, req, {
    id: choiceId,
    type: 'choice',
    props: { question: req.question.trim() },
    children: req.options.map((text, i) => ({
      id: optionIds[i],
      type: 'choiceOption',
      children: [{ id: newBlockId(), type: 'paragraph', content: text.trim() }],
    })),
  } as never);
  if (!out.ok) return out;
  return { ok: true, value: { ...out.value, optionIds } };
}

// ───────────────────────── The register ─────────────────────────

/** Every choice in the document (decided ones first), with its tally and
 *  decision. Agents get each entry marked untrusted: people wrote its text. */
export async function listDecisions(actor: AuthUser, documentId: string): Promise<Result<DecisionsResponse>> {
  const access = await liveDocAccess(documentId, actor);
  if (!access.ok) return access;
  const choices = await withLiveDocument(documentId, (doc) =>
    [...liveBlocks(doc)]
      .filter((e) => e.block.type === 'choice' && validBlockId(e.block.id))
      .map((e) => ({ tabId: e.tabId, id: e.block.id, props: e.block.props as Record<string, string>, options: optionsOf(e.block) })),
  );
  const recorded = await decisionsOf(documentId, choices.map((c) => c.id));
  const decisions: DecisionDTO[] = [];
  for (const c of choices) {
    const tally = await countVotes(actor, documentId, c.id, c.options);
    const decided = standing(recorded.get(c.id), c.props.question ?? '', c.options);
    const proposed = c.options.find((o) => o.id === c.props.proposedOptionId);
    const entry: DecisionDTO = {
      target: { tabId: c.tabId, blockId: c.id },
      question: c.props.question ?? '',
      options: c.options.map((o) => ({ ...o, votes: tally.counts[o.id] ?? 0 })),
      status: decided ? 'decided' : 'open',
      decided,
      proposed: !decided && proposed
        ? { optionId: proposed.id, label: proposed.label, by: c.props.proposedBy ?? '', note: c.props.proposalNote ?? '' }
        : null,
    };
    if (actor.kind === 'agent') entry.untrusted = true;
    decisions.push(entry);
  }
  decisions.sort((a, b) => (a.status === b.status ? 0 : a.status === 'decided' ? -1 : 1));
  return { ok: true, value: { decisions } };
}

// ───────────────────────── Keeping decisions with their blocks ─────────────────────────

/** Deletes decisions whose choice block, or decided option, is gone from the
 *  document, so a block id used again never inherits an old decision. */
export async function reconcileDecisions(documentId: string): Promise<void> {
  const rows = (await db.execute(sql`
    SELECT block_id AS "blockId", option_id AS "optionId" FROM doc_decisions WHERE document_id = ${documentId}
  `)) as unknown as { blockId: string; optionId: string }[];
  if (rows.length === 0) return;
  const live = await withLiveDocument(documentId, (doc) => {
    const options = new Map<string, Set<string>>();
    for (const e of liveBlocks(doc)) if (e.block.type === 'choice') options.set(e.block.id, new Set(optionsOf(e.block).map((o) => o.id)));
    return options;
  });
  for (const r of rows) {
    if (live.get(r.blockId)?.has(r.optionId)) continue;
    await db.execute(sql`
      DELETE FROM doc_decisions WHERE document_id = ${documentId} AND block_id = ${r.blockId} AND option_id = ${r.optionId}
    `);
  }
}

const pendingDecisions = new Map<string, ReturnType<typeof setTimeout>>();
const runningDecisions = new Set<Promise<void>>();

function runDecisionSync(documentId: string): void {
  const job = reconcileDecisions(documentId).catch((err: unknown) => {
    logger.warn({ documentId, error: String(err) }, 'choices: decision sync failed');
  });
  runningDecisions.add(job);
  void job.finally(() => runningDecisions.delete(job));
}

onLiveUpdate((documentId) => {
  if (pendingDecisions.has(documentId)) return;
  const timer = setTimeout(() => {
    pendingDecisions.delete(documentId);
    runDecisionSync(documentId);
  }, 500);
  timer.unref?.();
  pendingDecisions.set(documentId, timer);
});

/** Runs every scheduled decision sync now and waits (tests, shutdown). */
export async function flushDecisionSync(): Promise<void> {
  for (const [documentId, timer] of [...pendingDecisions]) {
    clearTimeout(timer);
    pendingDecisions.delete(documentId);
    runDecisionSync(documentId);
  }
  await Promise.all([...runningDecisions]);
}

/** Decisions for exports and static renders, keyed by choice block id: the
 *  server's record, never the document's props. */
export async function exportDecisions(documentId: string): Promise<ExportDecisions> {
  const rows = (await db.execute(sql`
    SELECT d.block_id AS "blockId", d.option_id AS "optionId", d.rationale, ${actorNameOf('u')} AS "decidedByName"
      FROM doc_decisions d JOIN users u ON u.id = d.decided_by
     WHERE d.document_id = ${documentId}
  `)) as unknown as ({ blockId: string } & ExportDecision)[];
  return new Map(rows.map(({ blockId, ...d }) => [blockId, d]));
}
