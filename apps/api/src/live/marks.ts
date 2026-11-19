import * as Y from 'yjs';
import { Node as PmNode, type Schema } from '@tiptap/pm/model';
import {
  absolutePositionToRelativePosition,
  relativePositionToAbsolutePosition,
  yXmlFragmentToProsemirrorJSON,
} from 'y-prosemirror';
import type { Target } from '@polygonlabs/primer-api-types';
import { serverEditor } from './editor.ts';
import { findBlock } from './blocks.ts';
import { liveDocName, liveInstance } from './instance.ts';
import type { PlannedEdit } from './pipeline.ts';
import { fragmentName, reachableFragments } from './reach.ts';

/** BlockNote's comment mark: `{ threadId, orphan }`. */
const COMMENT = 'comment';

/** A selection that no longer resolves in the live document. */
export class AnchorMissingError extends Error {
  constructor(message = 'The selection no longer resolves in the document.') {
    super(message);
  }
}

/** A selection sent as base64 `Y.encodeRelativePosition` bytes. */
export type RelativeSelection = { anchor: string; head: string };

/** The ProseMirror doc of one fragment (Primer's schema). */
export function fragmentDoc(fragment: Y.XmlFragment): PmNode {
  const schema = serverEditor().editor.pmSchema;
  if (fragment.length === 0) return schema.topNodeType.createAndFill()!;
  return PmNode.fromJSON(schema, yXmlFragmentToProsemirrorJSON(fragment));
}

/**
 * The `mapping` y-prosemirror's position helpers need (Y type → ProseMirror
 * node size), computed from the Y structure and the schema instead of a live
 * editor binding: an element is 1 when its node type is a leaf, else 2 plus
 * its children; a text run is its length.
 */
function sizeMapping(schema: Schema): Map<Y.AbstractType<any>, { nodeSize: number }> {
  const size = (type: Y.AbstractType<any>): number => {
    if (type instanceof Y.XmlText) return type.length;
    const el = type as Y.XmlElement;
    if (schema.nodes[el.nodeName]?.isLeaf) return 1;
    return 2 + el.toArray().reduce((n, child) => n + size(child as Y.AbstractType<any>), 0);
  };
  return { get: (type: Y.AbstractType<any>) => ({ nodeSize: size(type) }) } as never;
}

/** Encodes ProseMirror position `pos` in `fragment` as a relative position. */
export function toRelative(fragment: Y.XmlFragment, pos: number): string {
  const rel = absolutePositionToRelativePosition(pos, fragment, sizeMapping(serverEditor().editor.pmSchema) as never);
  return Buffer.from(Y.encodeRelativePosition(rel)).toString('base64');
}

/** Position `pos` in `fragment` as relative-position JSON, the form
 *  y-prosemirror's collaboration cursors read from awareness. */
export function toRelativeJSON(fragment: Y.XmlFragment, pos: number): unknown {
  const rel = absolutePositionToRelativePosition(pos, fragment, sizeMapping(serverEditor().editor.pmSchema) as never);
  return Y.relativePositionToJSON(rel);
}

/** The absolute range of a relative selection in `target`'s fragment, or null. */
export function resolveSelection(doc: Y.Doc, target: Target, sel: RelativeSelection): { from: number; to: number } | null {
  const fragment = doc.getXmlFragment(fragmentName(target));
  const mapping = sizeMapping(serverEditor().editor.pmSchema);
  const resolve = (encoded: string): number | null => {
    let rel: Y.RelativePosition;
    try {
      rel = Y.decodeRelativePosition(new Uint8Array(Buffer.from(encoded, 'base64')));
    } catch {
      return null;
    }
    return relativePositionToAbsolutePosition(doc, fragment, rel, mapping as never);
  };
  const a = resolve(sel.anchor);
  const h = resolve(sel.head);
  if (a === null || h === null || a === h) return null;
  return { from: Math.min(a, h), to: Math.max(a, h) };
}

/**
 * Adds the comment mark for `threadId` over a selection, resolved inside the
 * document's queue (so positions match the content the mark lands on). The
 * marked text is reported through `onQuote`. Throws AnchorMissingError when
 * the selection no longer resolves or covers no text.
 */
export function commentMarkEdit(
  documentId: string,
  threadId: string,
  target: Target,
  sel: RelativeSelection,
  onQuote: (quote: string) => void,
): PlannedEdit {
  return {
    target,
    inverse: false,
    build: (tr) => {
      const doc = liveInstance().documents.get(liveDocName(documentId));
      const range = doc ? resolveSelection(doc, target, sel) : null;
      if (!range) throw new AnchorMissingError();
      addComment(tr.doc, range, threadId, onQuote, (from, to, mark) => tr.addMark(from, to, mark));
    },
  };
}

/** Adds the comment mark for `threadId` over the first exact occurrence of
 *  `quote` in the target (its block, or the whole fragment). */
export function quoteMarkEdit(threadId: string, target: Target, quote: string): PlannedEdit {
  return {
    target,
    inverse: false,
    build: (tr) => {
      const range = findQuote(tr.doc, blockScope(target), quote);
      if (!range) throw new AnchorMissingError(`"${quote}" was not found in the target.`);
      addComment(tr.doc, range, threadId, () => undefined, (from, to, mark) => tr.addMark(from, to, mark));
    },
  };
}

function addComment(
  doc: PmNode,
  range: { from: number; to: number },
  threadId: string,
  onQuote: (quote: string) => void,
  add: (from: number, to: number, mark: ReturnType<Schema['mark']>) => void,
) {
  const quote = doc.textBetween(range.from, range.to, '\n');
  if (quote.trim() === '') throw new AnchorMissingError('The selection covers no text.');
  add(range.from, range.to, doc.type.schema.marks[COMMENT]!.create({ threadId, orphan: false }));
  onQuote(quote);
}

/**
 * The range of the first exact occurrence of `quote` inside one textblock of
 * the block `blockId` (or anywhere in the fragment when `blockId` is empty).
 * M10b adds a fuzzy stage.
 */
export function findQuote(doc: PmNode, blockId: string, quote: string): { from: number; to: number } | null {
  if (quote === '') return null;
  const scope = blockId ? findBlock(doc, blockId) : { pos: -1, node: doc };
  if (!scope) return null;
  let found: { from: number; to: number } | null = null;
  scope.node.descendants((node, offset) => {
    if (found) return false;
    if (!node.isTextblock) return true;
    const start = scope.pos + 1 + offset + 1;
    const index = node.textContent.indexOf(quote);
    if (index >= 0) found = textRange(node, start, index, quote.length);
    return false;
  });
  return found;
}

/** Positions of `[index, index + length)` of a textblock's text content. */
function textRange(node: PmNode, start: number, index: number, length: number): { from: number; to: number } {
  let from = -1;
  let to = -1;
  let seen = 0;
  node.forEach((child, offset) => {
    const text = child.isText ? child.text!.length : 0;
    if (from < 0 && index < seen + text) from = start + offset + (index - seen);
    if (to < 0 && index + length <= seen + text) to = start + offset + (index + length - seen);
    seen += text;
  });
  return { from, to };
}

/** The block to search for a target's quote: a sub-fragment (page text,
 *  embed, widget label) is searched whole. */
function blockScope(target: Target): string {
  return target.pid || target.textId || target.embedId ? '' : target.blockId;
}

/** `findQuote` against the live content of the target's fragment. */
export function findMarkedQuote(doc: Y.Doc, target: Target, quote: string): { from: number; to: number } | null {
  return findQuote(fragmentDoc(doc.getXmlFragment(fragmentName(target))), blockScope(target), quote);
}

/** Thread ids of every comment mark in `node`. */
export function commentedThreadIds(node: PmNode): string[] {
  const ids = new Set<string>();
  node.descendants((child) => {
    for (const mark of child.marks) {
      if (mark.type.name === COMMENT && typeof mark.attrs.threadId === 'string') ids.add(mark.attrs.threadId);
    }
    return true;
  });
  return [...ids];
}

/** Threads whose comment mark is in reachable content. Fragments a republish
 *  left behind still hold marks, but those don't count. */
export function presentThreadIds(doc: Y.Doc): Set<string> {
  const ids = new Set<string>();
  for (const name of reachableFragments(doc)) {
    const fragment = doc.getXmlFragment(name);
    if (fragment.length === 0) continue;
    for (const id of commentedThreadIds(fragmentDoc(fragment))) ids.add(id);
  }
  return ids;
}
