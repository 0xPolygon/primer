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

/** What a build may tell the pipeline beyond its steps. */
export type BuildContext = {
  /** `blockId` moved: undo puts it back at its prior place. */
  moved(blockId: string): void;
};

export type PlannedEdit = {
  target: Target;
  /** The `block.version` the caller read; a mismatch makes this edit a conflict. */
  expectVersion?: string;
  /**
   * Adds steps to `tr`. Synchronous: it runs inside the document's queue, on a
   * transform of its own, so returning a Refusal (or throwing) drops every
   * step it added. A Refusal makes this edit a `conflict` and leaves the other
   * edits of the plan alone; a throw aborts the whole plan.
   */
  build: (tr: Transform, at: Located, ctx: BuildContext) => Refusal | void;
  /** Capture per-block inverses for undo (`BlockInverse`). */
  inverse: boolean;
  /** Called with the blocks the edit created or changed (as stored), once it applied. */
  applied?: (blocks: AppliedBlock[]) => void;
};

/**
 * One block an applied `inverse: true` edit created, removed, changed or
 * moved, enough to put it back:
 * - `prior`: the block's whole subtree (blockContainer JSON) before the edit,
 *   null when the edit created it;
 * - `afterVersion`: right after the edit, null when the edit removed it;
 *   undo's precondition. For a block the edit created it is the whole
 *   subtree's `blockVersion` (undo removes the subtree, so a person's later
 *   edit anywhere in it must stop that); otherwise the block's own content
 *   (`contentVersion`), so undoing a child never makes its parent stale;
 * - `place`: where the block was (parent, previous and next sibling ids),
 *   set when the edit removed or moved it.
 * Only the topmost block of a created or removed subtree is recorded.
 */
export type BlockInverse = {
  index: number;
  target: Target;
  prior: Record<string, unknown> | null;
  afterVersion: string | null;
  place: BlockPlace | null;
};

/** A block an edit created or changed, as stored, with its place in the tree. */
export type AppliedBlock = { node: PmNode; parentId: string | null; depth: number };

export type BlockPlace = { parentId: string | null; prevId: string | null; nextId: string | null };

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
  afterPersist?: (result: { docVersion: number; inverses: BlockInverse[] }) => Promise<void>;
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
        return { outcomes, inverses: [] as BlockInverse[] };
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
  const inverses: BlockInverse[] = [];

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
    const scratch = new Transform(entry.tr.doc);
    const moved = new Set<string>();
    const refusal = edit.build(scratch, at, { moved: (id) => moved.add(id) });
    if (refusal) {
      outcomes.push({ index, target: edit.target, status: 'conflict', refusal });
      return;
    }
    if (scratch.steps.length === 0) {
      outcomes.push({ index, target: edit.target, status: 'unchanged' });
      return;
    }
    try {
      scratch.doc.check();
    } catch (err) {
      outcomes.push({ index, target: edit.target, status: 'conflict', refusal: invalidStructure(err) });
      return;
    }
    for (const step of scratch.steps) entry.tr.step(step);
    outcomes.push({ index, target: edit.target, status: 'applied' });
    if (edit.inverse || edit.applied) {
      const diff = blockDiff(scratch.before, scratch.doc, moved);
      if (edit.inverse) {
        for (const { blockId, ...inv } of diff.inverses) inverses.push({ ...inv, index, target: { ...edit.target, blockId } });
      }
      edit.applied?.(diff.touched);
    }
  });

  const writes = [...fragments.values()]
    .filter((entry) => entry.tr.docChanged)
    .map((entry) => ({ fragment: entry.fragment, doc: entry.tr.doc }));
  return { outcomes, inverses, writes };
}

/** A block's own content (type, props, inline content), without its
 *  children: what undo restores and checks, so undoing a child never makes
 *  its parent's undo stale. */
export function contentVersion(blockContainer: PmNode): string {
  return blockVersion(blockContainer.firstChild!);
}

type Indexed = { node: PmNode; place: BlockPlace; depth: number };

/** Every block of a fragment doc by id, with its place. */
export function indexBlocks(root: PmNode): Map<string, Indexed> {
  const out = new Map<string, Indexed>();
  const walk = (group: PmNode, parentId: string | null, depth: number) => {
    const children: PmNode[] = [];
    group.forEach((child) => {
      if (child.type.name === 'blockContainer') children.push(child);
    });
    children.forEach((child, i) => {
      const id = child.attrs.id as string;
      out.set(id, {
        node: child,
        place: {
          parentId,
          prevId: i > 0 ? (children[i - 1]!.attrs.id as string) : null,
          nextId: i < children.length - 1 ? (children[i + 1]!.attrs.id as string) : null,
        },
        depth,
      });
      child.forEach((grand) => {
        if (grand.type.name === 'blockGroup') walk(grand, id, depth + 1);
      });
    });
  };
  root.forEach((child) => {
    if (child.type.name === 'blockGroup') walk(child, null, 0);
  });
  return out;
}

/** The blocks one edit created, removed, changed or moved. */
function blockDiff(before: PmNode, after: PmNode, moved: Set<string>) {
  const b = indexBlocks(before);
  const a = indexBlocks(after);
  const inverses: (Omit<BlockInverse, 'index' | 'target'> & { blockId: string })[] = [];
  const touched: AppliedBlock[] = [];
  for (const [id, old] of b) {
    const now = a.get(id);
    if (!now) {
      const parent = old.place.parentId;
      if (parent !== null && b.has(parent) && !a.has(parent)) continue;
      inverses.push({ blockId: id, prior: old.node.toJSON(), afterVersion: null, place: old.place });
      continue;
    }
    const changed = contentVersion(old.node) !== contentVersion(now.node);
    if (changed) touched.push({ node: now.node, parentId: now.place.parentId, depth: now.depth });
    if (changed || moved.has(id)) {
      inverses.push({
        blockId: id,
        prior: old.node.toJSON(),
        afterVersion: contentVersion(now.node),
        place: moved.has(id) ? old.place : null,
      });
    }
  }
  for (const [id, now] of a) {
    if (b.has(id)) continue;
    const parent = now.place.parentId;
    if (parent !== null && a.has(parent) && !b.has(parent)) continue;
    touched.push({ node: now.node, parentId: now.place.parentId, depth: now.depth });
    inverses.push({ blockId: id, prior: null, afterVersion: blockVersion(now.node), place: null });
  }
  return { inverses, touched };
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

function invalidStructure(err: unknown): Refusal {
  return {
    code: 'invalid_op',
    message: `The edit would leave the document invalid: ${err instanceof Error ? err.message : String(err)}`,
    fix: 'Change the op so every block keeps a valid place and content (for example, update a block instead of removing the last one).',
  };
}
