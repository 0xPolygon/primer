import { useState } from 'react';
import { createReactBlockSpec } from '@blocknote/react';
import {
  useBlockText,
  usePrimerBlockServices,
  type Evidence,
  type ChoiceTally,
  type PrimerBlockServices,
} from './services.ts';
import { BLOCK_TEXT_EN, fill } from './text.ts';

/**
 * A choice: a question and its options, which people vote on and one person
 * with edit rights decides. A layout block (BlockNote's layout-block pattern)
 * whose children are `choiceOption` blocks, so each option is ordinary rich
 * text with its own block id: votes and comments address an option by it.
 *
 * Votes are shared records (`primer.choice/<choiceId>`) and the decision is
 * the API's record, neither in the document. The block carries only the
 * decision's nonce (`decisionId`, written by the API's pick route), which ties
 * the record to this block. The `decided*` props are render slots the server
 * fills from its record for exports and static renders; nothing the document
 * holds there is shown. An agent may only fill the `proposed*` props.
 */
export const choiceBlock = createReactBlockSpec(
  {
    type: 'choice',
    propSchema: {
      question: { default: '' },
      /** The recorded decision's nonce. */
      decisionId: { default: '' },
      // Render slots, filled by the server at export (live/export.ts).
      decidedOptionId: { default: '' },
      decidedLabel: { default: '' },
      decidedQuestion: { default: '' },
      decisionChanged: { default: '' },
      rationale: { default: '' },
      decidedByName: { default: '' },
      proposedOptionId: { default: '' },
      proposedBy: { default: '' },
      proposalNote: { default: '' },
    },
    content: 'none',
    layoutOnly: true,
    children: { allow: ['choiceOption'], min: 1, dissolve: false },
  },
  {
    renderFrame: (props) => <ChoiceFrame {...(props as unknown as ChoiceFrameProps)} />,
    // Exports and static renders: the question, the options as a list, then
    // the decision. No controls.
    toExternalHTML: (props) => {
      const block = props.block as unknown as AnyBlock;
      const p = block.props as Record<string, string>;
      const text = BLOCK_TEXT_EN;
      return (
        <div data-primer-choice="">
          <p>
            <strong>Choice:</strong> {p.question}
          </p>
          <ul ref={props.childrenRef} />
          {p.decidedOptionId && (
            <p>
              <strong>{fill(text.decision, { label: p.decidedLabel ?? '' })}</strong>
              {p.decidedByName ? ` ${fill(text.by, { name: p.decidedByName })}` : ''}
              {p.rationale ? ` (${p.rationale})` : ''}
              {p.decisionChanged ? ` ${text.changed} ${p.decidedQuestion}` : ''}
            </p>
          )}
        </div>
      );
    },
  },
);

/** One option of a choice: any blocks, its first block's text is its label. */
export const choiceOptionBlock = createReactBlockSpec(
  {
    type: 'choiceOption',
    propSchema: {},
    content: 'none',
    layoutOnly: true,
    placeable: 'namedOnly',
  },
  {
    meta: { draggable: true },
    renderFrame: (props) => <OptionFrame {...(props as unknown as OptionFrameProps)} />,
    toExternalHTML: (props) => <li ref={props.childrenRef} />,
  },
);

type AnyBlock = { id: string; type: string; props: Record<string, unknown>; content?: unknown; children: AnyBlock[] };
type Editor = {
  isEditable: boolean;
  getBlock(id: string): AnyBlock | undefined;
  getParentBlock(id: string): AnyBlock | undefined;
  updateBlock(id: string, update: { props: Record<string, unknown> }): unknown;
  insertBlocks(blocks: unknown[], reference: string, placement: 'before' | 'after'): AnyBlock[];
  setTextCursorPosition(id: string, placement: 'start' | 'end'): void;
};
type ChoiceFrameProps = { block: AnyBlock; editor: Editor; slotRef: (node: HTMLElement | null) => void };
type OptionFrameProps = ChoiceFrameProps;

/** The plain text of inline content (BlockNote's styled text and links). */
export function inlineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((item: unknown) => {
      if (typeof item !== 'object' || item === null) return '';
      const i = item as { type?: string; text?: unknown; content?: unknown };
      if (i.type === 'text' && typeof i.text === 'string') return i.text;
      if (i.type === 'link') return inlineText(i.content);
      return '';
    })
    .join('');
}

/** An option's label: the text of its first block that has any. */
export function optionLabel(option: AnyBlock): string {
  for (const child of option.children) {
    const text = inlineText(child.content).trim();
    if (text) return text;
  }
  return '';
}

/** The decision to show: the server's record in the editor (the props are a
 *  mirror anyone with edit access could rewrite), the props mirror in exports. */
function useDecision(block: AnyBlock, services: PrimerBlockServices | null): DecisionView | null {
  const tally = (services?.useTally ?? noTally)(block.id);
  if (services) {
    return tally?.decision ?? null;
  }
  // Exports and static renders: the server fills these props from its record
  // (live/export.ts) and drops whatever the document held.
  const p = block.props as Record<string, string>;
  if (!p.decidedOptionId) return null;
  return {
    label: p.decidedLabel ?? '',
    rationale: p.rationale ?? '',
    evidence: [],
    openQuestions: [],
    decidedByName: p.decidedByName ?? '',
    changedSinceDecided: p.decisionChanged === 'true',
  };
}

const noTally = (): ChoiceTally | null => null;

type DecisionView = {
  label: string;
  rationale: string;
  evidence: Evidence[];
  openQuestions: string[];
  decidedByName: string;
  changedSinceDecided: boolean;
};

function ChoiceFrame({ block, editor, slotRef }: ChoiceFrameProps) {
  const text = useBlockText();
  const services = usePrimerBlockServices();
  const p = block.props as Record<string, string>;
  const decided = useDecision(block, services);
  return (
    <div className="primer-choice" data-primer-choice="" data-decided={decided ? 'true' : 'false'}>
      <div className="primer-choice-head" contentEditable={false}>
        <span className="primer-choice-badge">{decided ? text.decided : text.openChoice}</span>
        {editor.isEditable && !decided ? (
          <input
            className="primer-choice-question"
            aria-label={text.question}
            placeholder={text.questionPlaceholder}
            value={p.question}
            onChange={(e) => editor.updateBlock(block.id, { props: { question: e.target.value } })}
          />
        ) : (
          <span className="primer-choice-question">{p.question || text.untitledChoice}</span>
        )}
      </div>
      <div className="primer-choice-options" ref={slotRef} />
      <div className="primer-choice-foot" contentEditable={false}>
        {services && editor.isEditable && !decided && (
          <button type="button" className="primer-choice-add" onClick={() => addOption(editor, block.id)}>
            {text.addOption}
          </button>
        )}
        {decided ? (
          <Decision decision={decided} />
        ) : (
          <Undecided block={block} services={services} />
        )}
      </div>
    </div>
  );
}

function addOption(editor: Editor, choiceId: string) {
  const choice = editor.getBlock(choiceId);
  const last = choice?.children[choice.children.length - 1];
  if (!last) return;
  const [option] = editor.insertBlocks([{ type: 'choiceOption', children: [{ type: 'paragraph' }] }], last.id, 'after');
  if (option?.children[0]) editor.setTextCursorPosition(option.children[0].id, 'start');
}

function Decision({ decision }: { decision: DecisionView }) {
  const text = useBlockText();
  const { evidence, openQuestions: questions } = decision;
  return (
    <div className="primer-choice-decision" data-primer-decision="">
      <div>
        <strong>{fill(text.decision, { label: decision.label })}</strong>
        {decision.decidedByName && <span className="primer-choice-meta"> {fill(text.by, { name: decision.decidedByName })}</span>}
        {decision.changedSinceDecided && <span className="primer-choice-meta"> {text.changed}</span>}
      </div>
      {decision.rationale && <p className="primer-choice-rationale">{decision.rationale}</p>}
      {evidence.length > 0 && (
        <ul className="primer-choice-evidence">
          {evidence.map((e, i) => (
            <li key={i}>{e.url ? <a href={e.url} target="_blank" rel="noopener noreferrer">{e.label}</a> : e.label}</li>
          ))}
        </ul>
      )}
      {questions.length > 0 && (
        <div className="primer-choice-questions">
          <strong>{text.openQuestions}</strong>
          <ul>
            {questions.map((q, i) => (
              <li key={i}>{q}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Undecided({ block, services }: { block: AnyBlock; services: PrimerBlockServices | null }) {
  const text = useBlockText();
  const [open, setOpen] = useState(false);
  const p = block.props as Record<string, string>;
  const proposed = block.children.find((o) => o.id === p.proposedOptionId);
  return (
    <>
      {proposed && (
        <div className="primer-choice-proposal">
          {fill(text.proposes, { by: p.proposedBy || text.anAgent, label: optionLabel(proposed) })}
          {p.proposalNote && <span>: {p.proposalNote}</span>}
        </div>
      )}
      {services?.canPick && !open && (
        <button type="button" className="primer-choice-decide" onClick={() => setOpen(true)}>
          {text.decide}
        </button>
      )}
      {services?.canPick && open && (
        <PickForm block={block} services={services} initial={proposed?.id} onDone={() => setOpen(false)} />
      )}
    </>
  );
}

function PickForm(props: { block: AnyBlock; services: PrimerBlockServices; initial?: string; onDone: () => void }) {
  const text = useBlockText();
  const options = props.block.children;
  const [optionId, setOptionId] = useState(props.initial ?? options[0]?.id ?? '');
  const [rationale, setRationale] = useState('');
  const [evidence, setEvidence] = useState('');
  const [questions, setQuestions] = useState('');
  const [error, setError] = useState('');
  const submit = async () => {
    setError('');
    try {
      await props.services.pick(props.block.id, {
        optionId,
        rationale: rationale.trim(),
        evidence: parseEvidenceLines(evidence),
        openQuestions: questions.split('\n').map((q) => q.trim()).filter(Boolean),
      });
      props.onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };
  return (
    <form
      className="primer-choice-pick"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label>
        {text.option}
        <select value={optionId} onChange={(e) => setOptionId(e.target.value)} aria-label={text.option}>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {optionLabel(o) || text.untitledOption}
            </option>
          ))}
        </select>
      </label>
      <label>
        {text.rationale}
        <textarea aria-label={text.rationale} value={rationale} onChange={(e) => setRationale(e.target.value)} rows={2} />
      </label>
      <label>
        {text.evidence}
        <textarea aria-label={text.evidence} value={evidence} onChange={(e) => setEvidence(e.target.value)} rows={2} />
      </label>
      <label>
        {text.openQuestionsField}
        <textarea aria-label={text.openQuestionsField} value={questions} onChange={(e) => setQuestions(e.target.value)} rows={2} />
      </label>
      {error && <div role="alert">{error}</div>}
      <div className="primer-choice-pick-actions">
        <button type="submit" disabled={!optionId}>
          {text.recordDecision}
        </button>
        <button type="button" onClick={props.onDone}>
          {text.cancel}
        </button>
      </div>
    </form>
  );
}

/** "Benchmark https://…" lines to evidence entries. */
function parseEvidenceLines(text: string): Evidence[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const m = /^(.*?)\s*(https?:\/\/\S+)$/i.exec(line);
      return m ? { label: m[1] || m[2]!, url: m[2]! } : { label: line };
    });
}

function OptionFrame({ block, editor, slotRef }: OptionFrameProps) {
  const services = usePrimerBlockServices();
  const choice = editor.getParentBlock(block.id);
  const tally = (services?.useTally ?? noTally)(choice?.id ?? '');
  const decided = services ? tally?.decision?.optionId === block.id : choice?.props.decidedOptionId === block.id;
  return (
    <div className="primer-choice-option" data-primer-option="" data-chosen={decided ? 'true' : 'false'}>
      <div className="primer-choice-option-body" ref={slotRef} />
      {/* After the body: BlockNote's side menu sits to the left of each block. */}
      <div className="primer-choice-vote" contentEditable={false}>
        {services && choice ? (
          <VoteButton services={services} choiceId={choice.id} optionId={block.id} locked={Boolean(tally?.decision)} />
        ) : (
          <span className="primer-choice-dot" />
        )}
      </div>
    </div>
  );
}

function VoteButton(props: { services: PrimerBlockServices; choiceId: string; optionId: string; locked: boolean }) {
  const text = useBlockText();
  const tally = props.services.useTally(props.choiceId);
  const count = tally?.counts[props.optionId] ?? 0;
  const mine = tally?.mine === props.optionId;
  return (
    <button
      type="button"
      className="primer-choice-vote-button"
      aria-pressed={mine}
      aria-label={fill(text.vote, { count })}
      disabled={!props.services.canVote || props.locked}
      onClick={() => void props.services.vote(props.choiceId, props.optionId).catch(() => undefined)}
    >
      {mine ? '●' : '○'} {count}
    </button>
  );
}
