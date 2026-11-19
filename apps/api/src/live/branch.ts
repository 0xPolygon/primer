import * as Y from 'yjs';
import type { Node as PmNode } from '@tiptap/pm/model';
import { Transform } from '@tiptap/pm/transform';
import { eq, sql } from 'drizzle-orm';
import { v7 as uuidv7 } from 'uuid';
import type { BlockPlace, ProposeBranchResponse, Refusal } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documents } from '../db/schema.ts';
import { transactionWithEvents } from '../lib/events.ts';
import { readableLiveDoc } from '../lib/liveThreads.ts';
import { canEdit, canManage } from '../lib/permissions.ts';
import type { Storage } from '../storage/types.ts';
import { blockVersion, findBlock } from './blocks.ts';
import { referencedFiles } from './bundle.ts';
import { rewriteIds } from './copy.ts';
import { withLiveDocument } from './instance.ts';
import { fragmentDoc } from './marks.ts';
import { removeBlock } from './ops.ts';
import { originFor } from './origin.ts';
import { applyPlan, contentVersion, indexBlocks, type PlannedEdit } from './pipeline.ts';
import { docQueue } from './queue.ts';
import { tabFragmentName, tabsOf } from './reach.ts';
import { insertAt } from './undo.ts';

export type ProposeResult = { ok: true; value: ProposeBranchResponse } | { ok: false; status: 400 | 403 | 404; refusal: Refusal };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Proposes a branch back to its parent as one change set (plan M10c.1). Per
 * tab and per block id, three versions are compared: base (the parent as
 * branched), parent (now) and branch (now, its thread and file ids mapped
 * back to the parent's):
 *
 * | branch      | parent      | result                                   |
 * |-------------|-------------|------------------------------------------|
 * | unchanged   | any         | nothing (never a revert of the parent)   |
 * | changed     | unchanged   | a suggestion                             |
 * | changed     | changed     | a suggestion marked `conflict`           |
 * | same change | same change | nothing                                  |
 * | new         | —           | a suggestion (runs of new siblings: one) |
 * | removed     | unchanged   | a suggestion to remove it                |
 * | removed     | changed     | a conflict                               |
 * | changed     | removed     | a conflict that adds it back             |
 *
 * "Changed" is a block's own content (children compare as blocks of their
 * own) or its place among the blocks both sides still have. Every edit
 * checks the parent's live block inside the pipeline, so a parent edit made
 * meanwhile is a conflict too, never overwritten. The change set's id is the
 * branch's id; proposing again withdraws the set's open suggestions first.
 */
export async function proposeBranch(storage: Storage, actor: AuthUser, branchId: string): Promise<ProposeResult> {
  const notFound: ProposeResult = { ok: false, status: 404, refusal: { code: 'not_found', message: 'Branch not found.', fix: 'Check the document id.' } };
  if (!UUID.test(branchId)) return notFound;
  const branch = await readableLiveDoc(branchId, actor);
  if (!branch) return notFound;
  const [row] = await db
    .select({ parentId: documents.branchOf, base: documents.branchBaseState })
    .from(documents)
    .where(eq(documents.id, branchId));
  if (!row?.parentId || !row.base) {
    return { ok: false, status: 400, refusal: { code: 'bad_request', message: 'This document is not a branch.', fix: 'Branch the document first, then propose the branch.' } };
  }
  if (!canManage(branch.role)) {
    return { ok: false, status: 403, refusal: { code: 'forbidden', message: 'Only the branch\'s owner can propose it.', fix: 'Ask its owner.' } };
  }
  const parent = await readableLiveDoc(row.parentId, actor);
  if (!parent) {
    return { ok: false, status: 404, refusal: { code: 'not_found', message: 'The branch\'s parent document is gone.', fix: 'Fork the branch into a document of its own instead.' } };
  }
  if (!canEdit(parent.role)) {
    return {
      ok: false,
      status: 403,
      refusal: { code: 'forbidden', message: 'Only the owner and editors of the parent can propose a branch to it.', fix: 'Ask for editor access, or comment on the parent instead.' },
    };
  }
  const parentId = parent.id;

  const ids = await idsToParent(storage, branchId, parentId);
  const baseDoc = new Y.Doc();
  Y.applyUpdate(baseDoc, row.base);
  const baseTabs = new Set(tabsOf(baseDoc).map((t) => t.id));
  const tabs = await withLiveDocument(branchId, (doc) =>
    tabsOf(doc).map((tab) => {
      const tr = new Transform(fragmentDoc(doc.getXmlFragment(tabFragmentName(tab.id))));
      rewriteIds(tr, 'branch', ids);
      return { id: tab.id, branch: tr.doc };
    }),
  );
  const edits: PlannedEdit[] = [];
  for (const tab of tabs) {
    if (!baseTabs.has(tab.id)) edits.push(newTabEdit(tab.id));
    else edits.push(...tabEdits(tab.id, fragmentDoc(baseDoc.getXmlFragment(tabFragmentName(tab.id))), tab.branch));
  }
  baseDoc.destroy();

  await docQueue(parentId)(() => withdrawOpenSet(parentId, branchId, actor));
  const result = await applyPlan(parentId, originFor(actor), { edits, onConflict: 'suggest', mode: 'suggest', changeSetId: branchId });
  return { ok: true, value: { ...result, documentId: parentId, changeSetId: branchId } };
}

/**
 * Branch ids → the parent's: threads copied from the parent's own threads,
 * files copied from the parent's own files. Files the branch added are
 * copied into the parent now, so a suggestion's links resolve there. Every
 * lookup is scoped by document (the ids come from editable content).
 */
async function idsToParent(storage: Storage, branchId: string, parentId: string): Promise<Map<string, string>> {
  const ids = new Map<string, string>();
  const threadRows = (await db.execute(sql`
    SELECT t.id, t.copied_from AS "from" FROM threads t JOIN threads p ON p.id = t.copied_from AND p.document_id = ${parentId}
     WHERE t.document_id = ${branchId}
  `)) as unknown as { id: string; from: string }[];
  for (const t of threadRows) ids.set(t.id, t.from);

  const used = await withLiveDocument(branchId, (doc) => referencedFiles(doc, branchId));
  if (used.length === 0) return ids;
  const fileRows = (await db.execute(sql`
    SELECT f.id, f.storage_key AS "storageKey", f.content_type AS "contentType", f.size_bytes AS "sizeBytes", f.uploaded_by AS "uploadedBy", p.id AS "parentFile"
      FROM doc_files f LEFT JOIN doc_files p ON p.id = f.copied_from AND p.document_id = ${parentId}
     WHERE f.document_id = ${branchId} AND f.id IN (${sql.join(used.map((id) => sql`${id}`), sql`, `)})
  `)) as unknown as { id: string; storageKey: string; contentType: string; sizeBytes: number; uploadedBy: string; parentFile: string | null }[];
  for (const f of fileRows) {
    if (f.parentFile) {
      ids.set(f.id, f.parentFile);
      continue;
    }
    const id = uuidv7();
    const storageKey = `files/${parentId}/${id}`;
    await storage.put(storageKey, new Uint8Array(await new Response(await storage.get(f.storageKey)).arrayBuffer()));
    await db.execute(sql`
      INSERT INTO doc_files (id, document_id, storage_key, content_type, size_bytes, uploaded_by, copied_from)
      VALUES (${id}, ${parentId}, ${storageKey}, ${f.contentType}, ${f.sizeBytes}, ${f.uploadedBy}, ${f.id})
    `);
    ids.set(f.id, id);
  }
  return ids;
}

/** Withdraws the open suggestions of an earlier proposal of this branch. */
async function withdrawOpenSet(parentId: string, branchId: string, actor: AuthUser): Promise<void> {
  await transactionWithEvents(async (tx, emit) => {
    const rows = (await tx.execute(sql`
      UPDATE suggestions SET status = 'withdrawn', decided_by = ${actor.id}, decided_at = now()
       WHERE document_id = ${parentId} AND change_set_id = ${branchId} AND status = 'open'
      RETURNING id
    `)) as unknown as { id: string }[];
    for (const r of rows) {
      emit({
        documentId: parentId,
        actorId: actor.id,
        type: 'suggestion.decided',
        payload: { document_id: parentId, suggestion_id: r.id, decision: 'withdrawn', by: actor.id },
      });
    }
  });
}

type Tree = { index: ReturnType<typeof indexBlocks>; order: string[]; siblings: Map<string, string[]> };

function tree(root: PmNode): Tree {
  const index = indexBlocks(root);
  const siblings = new Map<string, string[]>();
  for (const [id, b] of index) {
    const key = b.place.parentId ?? '';
    siblings.set(key, [...(siblings.get(key) ?? []), id]);
  }
  const order: string[] = [];
  root.descendants((node) => {
    if (node.type.name === 'blockContainer') order.push(node.attrs.id as string);
    return true;
  });
  return { index, order, siblings };
}

/** A block's parent and its nearest previous sibling among `common`: where
 *  it sits, ignoring blocks only one side has. */
function relPlace(t: Tree, id: string, common: (id: string) => boolean): string {
  const parentId = t.index.get(id)!.place.parentId ?? '';
  const sibs = t.siblings.get(parentId)!;
  const before = sibs.slice(0, sibs.indexOf(id)).filter(common);
  return `${parentId}|${before.at(-1) ?? ''}`;
}

function tabEdits(tabId: string, baseRoot: PmNode, branchRoot: PmNode): PlannedEdit[] {
  const base = tree(baseRoot);
  const branch = tree(branchRoot);
  const inBoth = (id: string) => base.index.has(id) && branch.index.has(id);
  const edits: PlannedEdit[] = [];
  let run: { nodes: PmNode[]; place: BlockPlace } | null = null;

  for (const id of branch.order) {
    const r = branch.index.get(id)!;
    const b = base.index.get(id);
    if (!b) {
      const parentNew = r.place.parentId !== null && !base.index.has(r.place.parentId);
      if (parentNew) continue;
      // Consecutive new siblings go in one edit: a suggestion builds against
      // the parent as it is, so separate ones would all anchor the same way.
      if (run && run.nodes.at(-1)!.attrs.id === r.place.prevId) run.nodes.push(r.node);
      else {
        run = { nodes: [r.node], place: r.place };
        edits.push(insertRunEdit(tabId, run));
      }
      continue;
    }
    const changed = contentVersion(r.node) !== contentVersion(b.node);
    const moved = relPlace(branch, id, inBoth) !== relPlace(base, id, inBoth);
    if (changed || moved) edits.push(updateEdit(tabId, id, b.node, r.node, r.place, base, changed, moved));
  }
  for (const id of base.order) {
    const b = base.index.get(id)!;
    if (branch.index.has(id)) continue;
    if (b.place.parentId !== null && !branch.index.has(b.place.parentId)) continue;
    edits.push(removeEdit(tabId, id, b.node));
  }
  return edits;
}

function bothChanged(target: { tabId: string; blockId: string }, why: string): Refusal {
  return {
    code: 'target_changed',
    message: `Block ${target.blockId} ${why} in the parent since the branch was made; the branch's version is a conflict to decide.`,
    fix: 'Decide the conflict: accept the branch\'s version or reject it.',
    details: { blockId: target.blockId },
  };
}

function updateEdit(
  tabId: string,
  id: string,
  baseNode: PmNode,
  branchNode: PmNode,
  place: BlockPlace,
  base: Tree,
  changed: boolean,
  moved: boolean,
): PlannedEdit {
  const target = { tabId, blockId: id };
  return {
    target,
    inverse: false,
    build: (tr, at, ctx) => {
      if (!at) {
        if (!ctx.suggesting) return bothChanged(target, 'was removed');
        return insertAt(tr, branchNode, place);
      }
      const content = changed && contentVersion(branchNode) !== contentVersion(at.node);
      const parentChanged = contentVersion(at.node) !== contentVersion(baseNode);
      let parentMoved = false;
      if (moved) {
        const now = tree(tr.doc);
        const common = (x: string) => base.index.has(x) && now.index.has(x);
        parentMoved = relPlace(now, id, common) !== relPlace(base, id, common);
      }
      if (!ctx.suggesting && ((content && parentChanged) || (moved && parentMoved))) {
        return bothChanged(target, content && parentChanged ? 'was edited' : 'was moved');
      }
      if (content) tr.replaceWith(at.pos + 1, at.pos + 1 + at.node.firstChild!.nodeSize, branchNode.firstChild!);
      if (moved) {
        const now = findBlock(tr.doc, id)!;
        const removed = removeBlock(tr, now);
        if (removed) return removed;
        ctx.moved(id);
        return insertAt(tr, now.node, place);
      }
    },
  };
}

function insertRunEdit(tabId: string, run: { nodes: PmNode[]; place: BlockPlace }): PlannedEdit {
  return {
    target: { tabId, blockId: run.nodes[0]!.attrs.id as string },
    inverse: false,
    build: (tr) => {
      // Already there (proposed and accepted before): nothing to add.
      if (findBlock(tr.doc, run.nodes[0]!.attrs.id as string)) return;
      let place = run.place;
      for (const node of run.nodes) {
        const refused = insertAt(tr, node, place);
        if (refused) return refused;
        place = { parentId: place.parentId, prevId: node.attrs.id as string, nextId: null };
      }
    },
  };
}

function removeEdit(tabId: string, id: string, baseNode: PmNode): PlannedEdit {
  const target = { tabId, blockId: id };
  return {
    target,
    inverse: false,
    build: (tr, at, ctx) => {
      if (!at) return;
      if (!ctx.suggesting && blockVersion(at.node) !== blockVersion(baseNode)) return bothChanged(target, 'was edited');
      return removeBlock(tr, at);
    },
  };
}

/** A tab made on the branch: tabs aren't blocks, so it can't be suggested. */
function newTabEdit(tabId: string): PlannedEdit {
  return {
    target: { tabId, blockId: '' },
    inverse: false,
    build: () => ({
      code: 'target_missing',
      message: `Tab ${tabId} was added on the branch; tabs can't be proposed.`,
      fix: 'Add the tab to the parent and copy its content by hand.',
      details: { tabId },
    }),
  };
}
