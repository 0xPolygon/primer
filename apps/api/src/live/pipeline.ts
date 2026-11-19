import * as Y from 'yjs';
import { Node as PmNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { updateYFragment, yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import type { EditOutcome, Reconciliation, Refusal, Target } from '@polygonlabs/primer-api-types';
import { blockVersion, findBlock } from './blocks.ts';
import { serverEditor } from './editor.ts';
import { liveDocName, liveInstance } from './instance.ts';
import type { LiveOrigin } from './origin.ts';
import { persistedUpTo } from './persist.ts';
import { docQueue } from './queue.ts';
import { fragmentName } from './reach.ts';

export type { LiveOrigin } from './origin.ts';

/** The target block (a `blockContainer`) in the transform's current doc, or
 *  null when the fragment has no block with that id (a whole-fragment edit). */
export type Located = { pos: number; node: PmNode } | null;

export type PlannedEdit = {
  target: Target;
  /** The `block.version` the caller read; a mismatch makes this edit a conflict. */
  expectVersion?: string;
  /** Adds steps to `tr`. Synchronous: it runs inside the document's queue. */
  build: (tr: Transform, at: Located) => void;
  /** Capture the target's prior subtree for undo (`Inverse`). */
  inverse: boolean;
};

/** What an applied `inverse: true` edit replaced: the target's prior subtree
 *  (null when the edit created it) and its version right after the edit. */
export type Inverse = {
  index: number;
  target: Target;
  prior: Record<string, unknown> | null;
  afterVersion: string | null;
};

export type Plan = {
  edits: PlannedEdit[];
  /** `suggest` turns conflicts into suggestions once suggestions exist; until
   *  then both report `conflict`. */
  onConflict: 'refuse' | 'suggest';
  /** Runs on the document's queue just before the mutation; a refusal turns
   *  every edit into a conflict carrying it (e.g. a cancelled run). */
  guard?: () => Promise<Refusal | null>;
  /** Runs once the update is stored, with its docVersion (e.g. to write the
   *  run's inverses). */
  afterPersist?: (result: { docVersion: number; inverses: Inverse[] }) => Promise<void>;
};

/**
 * The one way the server writes a live document (C4). Callers convert and
 * validate their input first. Then, on the document's queue, every
 * precondition is rechecked against the live fragments and every change is
 * built as a ProseMirror transform before anything is written; the result is
 * written with `updateYFragment` in one transaction whose origin is `origin`.
 * Untouched nodes keep their marks (comments, suggestions) and their Y items.
 * Yjs has no rollback, so an exception before the write leaves the document
 * untouched. Resolves once the update is stored.
 */
export async function applyPlan(documentId: string, origin: LiveOrigin, plan: Plan): Promise<Reconciliation> {
  const connection = await liveInstance().openDirectConnection(liveDocName(documentId), origin);
  try {
    const doc = connection.document!;
    const step = await docQueue(documentId)(async () => {
      const refusal = plan.guard ? await plan.guard() : null;
      if (refusal) {
        const outcomes: EditOutcome[] = plan.edits.map((edit, index) => ({
          index,
          target: edit.target,
          status: 'conflict',
          refusal,
        }));
        return { outcomes, inverses: [] as Inverse[] };
      }
      const prepared = prepare(doc, plan.edits);
      if (prepared.writes.length > 0) {
        await connection.transact(() => {
          for (const write of prepared.writes) {
            updateYFragment(doc, write.fragment, write.doc, { mapping: new Map(), isOMark: new Map() });
          }
        });
      }
      return { outcomes: prepared.outcomes, inverses: prepared.inverses };
    });
    const docVersion = await persistedUpTo(doc);
    if (plan.afterPersist) await plan.afterPersist({ docVersion, inverses: step.inverses });
    return { docVersion, outcomes: step.outcomes };
  } finally {
    await connection.disconnect({ unloadImmediately: false });
  }
}

/** Synchronous: locate, check, build and capture inverses for every edit. */
function prepare(doc: Y.Doc, edits: PlannedEdit[]) {
  const fragments = new Map<string, { fragment: Y.XmlFragment; tr: Transform }>();
  const outcomes: EditOutcome[] = [];
  const inverses: Inverse[] = [];

  edits.forEach((edit, index) => {
    const name = fragmentName(edit.target);
    let entry = fragments.get(name);
    if (!entry) {
      const fragment = doc.getXmlFragment(name);
      entry = { fragment, tr: new Transform(toPmDoc(fragment)) };
      fragments.set(name, entry);
    }
    const at = findBlock(entry.tr.doc, edit.target.blockId);
    if (edit.expectVersion !== undefined) {
      const current = at ? blockVersion(at.node) : null;
      if (current !== edit.expectVersion) {
        outcomes.push({ index, target: edit.target, status: 'conflict', refusal: targetChanged(edit.target, current) });
        return;
      }
    }
    const prior = at ? (at.node.toJSON() as Record<string, unknown>) : null;
    const before = entry.tr.steps.length;
    edit.build(entry.tr, at);
    const changed = entry.tr.steps.length > before;
    outcomes.push({ index, target: edit.target, status: changed ? 'applied' : 'unchanged' });
    if (edit.inverse && changed) {
      const after = findBlock(entry.tr.doc, edit.target.blockId);
      inverses.push({ index, target: edit.target, prior, afterVersion: after ? blockVersion(after.node) : null });
    }
  });

  const writes = [...fragments.values()]
    .filter((entry) => entry.tr.docChanged)
    .map((entry) => ({ fragment: entry.fragment, doc: entry.tr.doc }));
  return { outcomes, inverses, writes };
}

function toPmDoc(fragment: Y.XmlFragment): PmNode {
  const schema = serverEditor().editor.pmSchema;
  if (fragment.length === 0) return schema.topNodeType.createAndFill()!;
  const node = PmNode.fromJSON(schema, yXmlFragmentToProsemirrorJSON(fragment));
  node.check();
  return node;
}

function targetChanged(target: Target, current: string | null): Refusal {
  return {
    code: 'target_changed',
    message: current
      ? `Block ${target.blockId} changed since you read it.`
      : `Block ${target.blockId} no longer exists.`,
    fix: 'Read the block again and retry with its current version.',
    details: { blockId: target.blockId, version: current },
  };
}
