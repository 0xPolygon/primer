// Shared by the choice and task features: access to a live document, walking
// its blocks across tabs, and inserting one new block through the pipeline.
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { eq } from 'drizzle-orm';
import { blockToNode, type PartialBlock } from '@blocknote/core';
import { LIVE_BLOCK_ID_RE, type BlockPlacement, type Refusal, type RefusalCode, type Target } from '@polygonlabs/primer-api-types';
import type { AuthUser } from '../app.ts';
import { db } from '../db/client.ts';
import { documents } from '../db/schema.ts';
import { canEdit, canRead, loadEffectiveRole, type EffectiveRole, type Visibility } from '../lib/permissions.ts';
import { readBlocks, serverEditor, type PrimerBlock } from './editor.ts';
import { originFor } from './origin.ts';
import { applyPlan } from './pipeline.ts';
import { tabsOf } from './reach.ts';

export type Result<T> = { ok: true; value: T } | { ok: false; refusal: Refusal };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TAB_ID = /^[\w-]{1,64}$/;

const FIX: Partial<Record<RefusalCode, string>> = {
  bad_request: 'Fix the arguments and call again.',
  not_found: 'Check the document and block ids, and that you can read the document.',
  forbidden: 'Ask the document owner for editor access.',
  choice_decided: 'The choice is closed; read the decision with primer_list_decisions.',
};

export function refuse(code: RefusalCode, message: string, fix?: string): { ok: false; refusal: Refusal } {
  return { ok: false, refusal: { code, message, fix: fix ?? FIX[code] ?? 'Call again with valid arguments.' } };
}

export type LiveDocAccess = { role: EffectiveRole; uploaderId: string };

/** The caller's role on a live document it can read; edit rights when `write`. */
export async function liveDocAccess(documentId: string, actor: AuthUser, write = false): Promise<Result<LiveDocAccess>> {
  if (!UUID.test(documentId)) return refuse('not_found', 'Document not found.');
  const [doc] = await db
    .select({ uploaderId: documents.uploaderId, visibility: documents.visibility, deletedAt: documents.deletedAt, format: documents.format })
    .from(documents)
    .where(eq(documents.id, documentId));
  if (!doc || doc.deletedAt !== null) return refuse('not_found', 'Document not found.');
  const role = await loadEffectiveRole({ id: documentId, uploaderId: doc.uploaderId, visibility: doc.visibility as Visibility }, actor);
  if (!canRead(doc.visibility as Visibility, role)) return refuse('not_found', 'Document not found.');
  if (!doc.format) {
    return refuse('bad_request', 'This document is version-only HTML, not a live document.', 'Use a live (Markdown or text) document.');
  }
  if (write && !canEdit(role)) return refuse('forbidden', 'Only the document owner and editors can change its blocks.');
  return { ok: true, value: { role, uploaderId: doc.uploaderId } };
}

/** Every block of every tab, depth first, with its tab. */
export function* liveBlocks(doc: Y.Doc): Generator<{ tabId: string; block: PrimerBlock }> {
  for (const tab of tabsOf(doc)) {
    const stack = [...readBlocks(doc, tab.id)].reverse();
    while (stack.length > 0) {
      const block = stack.pop()!;
      yield { tabId: tab.id, block };
      for (let i = block.children.length - 1; i >= 0; i--) stack.push(block.children[i] as PrimerBlock);
    }
  }
}

/** The block with this id (of this type), or null. */
export function findLiveBlock(doc: Y.Doc, blockId: string, type: string): { tabId: string; block: PrimerBlock } | null {
  for (const entry of liveBlocks(doc)) if (entry.block.id === blockId && entry.block.type === type) return entry;
  return null;
}

export function validBlockId(raw: unknown): raw is string {
  return typeof raw === 'string' && LIVE_BLOCK_ID_RE.test(raw);
}

/** A placement, validated: `afterBlockId` or the end of `tabId` (main by default). */
export function checkPlacement(raw: BlockPlacement): string | null {
  if (raw.tabId !== undefined && (typeof raw.tabId !== 'string' || !TAB_ID.test(raw.tabId))) return 'tabId is not a tab id';
  if (raw.afterBlockId !== undefined && !validBlockId(raw.afterBlockId)) return 'afterBlockId is not a block id';
  return null;
}

/** A fresh block id. */
export function newBlockId(): string {
  return randomUUID();
}

/**
 * Inserts `block` (built entirely by the server, never taken from the caller)
 * after `afterBlockId`, or at the end of the tab, through the pipeline.
 */
export async function insertBlock(
  actor: AuthUser,
  documentId: string,
  placement: BlockPlacement,
  block: PartialBlock,
): Promise<Result<{ target: Target; docVersion: number }>> {
  const tabId = placement.tabId ?? 'main';
  const node = blockToNode(block as never, serverEditor().editor.pmSchema);
  let refusal: Refusal | null = null;
  const result = await applyPlan(documentId, originFor(actor), {
    onConflict: 'refuse',
    edits: [
      {
        target: { tabId, blockId: placement.afterBlockId ?? '' },
        inverse: false,
        build: (tr, at) => {
          if (placement.afterBlockId) {
            if (!at || at.node.type.name !== 'blockContainer') {
              refusal = refuse('not_found', `Block ${placement.afterBlockId} is not a block in tab ${tabId}.`).refusal;
              return;
            }
            tr.insert(at.pos + at.node.nodeSize, node);
            return;
          }
          const group = tr.doc.firstChild!;
          tr.insert(1 + group.content.size, node);
        },
      },
    ],
  });
  if (refusal) return { ok: false, refusal };
  return { ok: true, value: { target: { tabId, blockId: block.id! }, docVersion: result.docVersion } };
}

/**
 * Sets props on one block through the pipeline, once `check` accepts the
 * block as it is inside the document's queue. Layout blocks (a choice) are
 * the node itself; other blocks keep their props on the content node.
 */
export async function setBlockProps(
  actor: AuthUser,
  documentId: string,
  target: Target,
  check: (block: { type: string; attrs: Record<string, unknown>; childIds: string[] }) => Refusal | null,
  props: Record<string, string>,
  afterPersist?: (docVersion: number) => Promise<void>,
): Promise<Result<{ docVersion: number }>> {
  let refusal: Refusal | null = null;
  const result = await applyPlan(documentId, originFor(actor), {
    onConflict: 'refuse',
    edits: [
      {
        target,
        inverse: false,
        build: (tr, at) => {
          if (!at) {
            refusal = refuse('not_found', `Block ${target.blockId} no longer exists.`).refusal;
            return;
          }
          const layout = at.node.type.name !== 'blockContainer';
          const pos = layout ? at.pos : at.pos + 1;
          const node = layout ? at.node : at.node.firstChild!;
          const childIds: string[] = [];
          if (layout) at.node.forEach((child) => childIds.push(String(child.attrs.id)));
          refusal = check({ type: node.type.name, attrs: node.attrs, childIds });
          if (refusal) return;
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...props });
        },
      },
    ],
    afterPersist: afterPersist ? ({ docVersion }) => (refusal ? Promise.resolve() : afterPersist(docVersion)) : undefined,
  });
  if (refusal) return { ok: false, refusal };
  return { ok: true, value: { docVersion: result.docVersion } };
}
