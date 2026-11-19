// Choice blocks: votes, picks, proposals and the decision register.
//
// - A choice is a layout block whose children are `choiceOption` blocks; an
//   option's id is its block id. Choices live in the document.
// - Votes are shared records in `primer.choice/<choiceId>`, one per voter,
//   keyed by the voter's id. Only people vote, through `vote` here, which
//   forces the record id to the caller. The generic records verbs could still
//   write that collection, so a vote counts only when the record's last writer
//   is the voter it is keyed by and it names a current option.
// - The decision lives in the choice block's props, written only by `pick`,
//   which admits people with edit rights, and announced as `decision.made`.
//   Agents may `propose` a pick (the `proposed*` props), never make it.
// - The register is a read-time projection over the choice blocks: no table.
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
import { optionLabel, parseEvidence, parseOpenQuestions } from '@primer/blocks';
import type { AuthUser } from '../app.ts';
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
import { withLiveDocument } from './instance.ts';

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

/** Votes per current option: a record counts only when its last writer is
 *  the voter it is keyed by (see the module comment). */
async function countVotes(actor: AuthUser, documentId: string, choiceId: string, options: Option[]): Promise<Result<ChoiceTallyResponse>> {
  const api = recordsApi(actor, documentId);
  const valid = new Set(options.map((o) => o.id));
  const counts: Record<string, number> = Object.fromEntries(options.map((o) => [o.id, 0]));
  let mine: string | null = null;
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const out = await api.list({ collection: choiceVotesCollection(choiceId), scope: 'shared', limit: 200, cursor });
    if (!out.ok) return out;
    for (const r of out.value.records) {
      const optionId = r.data.optionId;
      if (r.recordId !== r.updatedBy || typeof optionId !== 'string' || !valid.has(optionId)) continue;
      counts[optionId] = (counts[optionId] ?? 0) + 1;
      if (r.recordId === actor.id) mine = optionId;
    }
    if (!out.value.nextCursor) break;
    cursor = out.value.nextCursor;
  }
  return { ok: true, value: { counts, mine } };
}

export async function choiceTally(actor: AuthUser, documentId: string, choiceId: string): Promise<Result<ChoiceTallyResponse>> {
  if (!validBlockId(choiceId)) return refuse('not_found', 'Choice not found.');
  const access = await liveDocAccess(documentId, actor);
  if (!access.ok) return access;
  const choice = await readChoice(documentId, choiceId);
  if (!choice) return refuse('not_found', 'Choice not found.');
  return countVotes(actor, documentId, choiceId, choice.options);
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
  if (choice.props.decidedOptionId) return refuse('choice_decided', 'This choice is decided.');
  if (optionId !== null && !choice.options.some((o) => o.id === optionId)) {
    return refuse('bad_request', `Option ${optionId} is not an option of this choice.`);
  }
  const api = recordsApi(actor, documentId);
  const target = { collection: choiceVotesCollection(choiceId), scope: 'shared' as const, recordId: actor.id };
  const out = optionId === null ? await api.delete(target) : await api.set({ ...target, data: { optionId } });
  if (!out.ok) return out;
  return countVotes(actor, documentId, choiceId, choice.options);
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
 *  of its options, and (unless re-picking) not decided. */
function choiceCheck(optionId: string, allowDecided: boolean) {
  return (block: { type: string; attrs: Record<string, unknown>; childIds: string[] }): Refusal | null => {
    if (block.type !== 'choice') return refuse('not_found', 'Choice not found.').refusal;
    if (!block.childIds.includes(optionId)) return refuse('bad_request', `Option ${optionId} is not an option of this choice.`).refusal;
    if (!allowDecided && block.attrs.decidedOptionId) return refuse('choice_decided', 'This choice is decided.').refusal;
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
  return setBlockProps(
    actor,
    documentId,
    { tabId: choice.tabId, blockId: choiceId },
    choiceCheck(req.optionId, true),
    {
      decidedOptionId: req.optionId,
      rationale: req.rationale ?? '',
      evidence: JSON.stringify(evidence),
      openQuestions: JSON.stringify(req.openQuestions ?? []),
      decidedBy: actor.id,
      decidedByName: label(actor),
      decidedAt: new Date().toISOString(),
      proposedOptionId: '',
      proposedBy: '',
      proposalNote: '',
    },
    async () => {
      await transactionWithEvents(async (_tx, emit) => {
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
  return setBlockProps(
    actor,
    documentId,
    { tabId: choice.tabId, blockId: choiceId },
    choiceCheck(req.optionId, false),
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
  const decisions: DecisionDTO[] = [];
  for (const c of choices) {
    const tally = await countVotes(actor, documentId, c.id, c.options);
    if (!tally.ok) return tally;
    const decided = c.options.find((o) => o.id === c.props.decidedOptionId);
    const proposed = c.options.find((o) => o.id === c.props.proposedOptionId);
    const entry: DecisionDTO = {
      target: { tabId: c.tabId, blockId: c.id },
      question: c.props.question ?? '',
      options: c.options.map((o) => ({ ...o, votes: tally.value.counts[o.id] ?? 0 })),
      status: decided ? 'decided' : 'open',
      decided: decided
        ? {
            optionId: decided.id,
            label: decided.label,
            rationale: c.props.rationale ?? '',
            evidence: parseEvidence(c.props.evidence),
            openQuestions: parseOpenQuestions(c.props.openQuestions),
            decidedBy: c.props.decidedBy ?? '',
            decidedByName: c.props.decidedByName ?? '',
            decidedAt: c.props.decidedAt ?? '',
          }
        : null,
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
