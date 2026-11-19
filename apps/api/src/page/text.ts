// Page text in the Y.Doc: one fragment `page/<blockId>/<pid>` per pid (C3),
// holding a single paragraph whose text (hard breaks as `\n`) is the pid's
// current text. The paragraph's block id is the page block's id, so a pid
// target `{ tabId, blockId, pid }` locates it like any block: preconditions,
// suggestions and comment anchors work unchanged. The overlay editor binds to it; the server reads and writes it
// through the pipeline.
import type * as Y from 'yjs';
import type { Node as PmNode } from '@tiptap/pm/model';
import type { Transform } from '@tiptap/pm/transform';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import type { Target } from '@polygonlabs/primer-api-types';
import { serverEditor } from '../live/editor.ts';
import type { PlannedEdit } from '../live/pipeline.ts';
import { fragmentFor } from '../live/reach.ts';

export function pidTarget(tabId: string, blockId: string, pid: string): Target {
  return { tabId, blockId, pid };
}

/** The text of a page fragment's ProseMirror doc: blocks joined by `\n`, hard breaks as `\n`. */
export function docText(doc: PmNode): string {
  const blocks: string[] = [];
  doc.descendants((node) => {
    if (!node.isTextblock) return true;
    let text = '';
    node.forEach((child) => {
      text += child.isText ? child.text! : child.type.name === 'hardBreak' ? '\n' : '';
    });
    blocks.push(text);
    return false;
  });
  return blocks.join('\n');
}

/** The current text of a pid, read without writing. */
export function readPidText(doc: Y.Doc, target: Target): string {
  const fragment = fragmentFor(doc, target);
  if (fragment.length === 0) return '';
  const schema = serverEditor().editor.pmSchema;
  return docText(schema.nodeFromJSON(yXmlFragmentToProsemirrorJSON(fragment)));
}

/** Inline content for `text`: text nodes with hard breaks for `\n`. */
function inline(text: string): PmNode[] {
  const schema = serverEditor().editor.pmSchema;
  const nodes: PmNode[] = [];
  text.split('\n').forEach((line, i) => {
    if (i > 0) nodes.push(schema.nodes.hardBreak!.create());
    if (line) nodes.push(schema.text(line));
  });
  return nodes;
}

/**
 * Sets a pid's text. When the fragment already holds one paragraph, only the
 * changed middle (between the common prefix and suffix) is replaced, so
 * comment marks on the rest of the text stay. Otherwise the fragment is
 * replaced with one paragraph whose block id is the page block's.
 */
export function setPidText(target: Target, text: string): PlannedEdit {
  return { target, inverse: false, build: (tr) => writeText(tr, target.blockId, text) };
}

export function writeText(tr: Transform, blockId: string, text: string): void {
  const para = singleParagraph(tr.doc);
  if (!para) {
    const editor = serverEditor();
    const fresh = editor._blocksToProsemirrorNode([{ id: blockId, type: 'paragraph', content: [] }] as never);
    tr.replaceWith(0, tr.doc.content.size, fresh.content);
    const start = singleParagraph(tr.doc)!.start;
    if (text) tr.insert(start, inline(text));
    return;
  }
  const current = docText(tr.doc);
  let prefix = 0;
  const max = Math.min(current.length, text.length);
  while (prefix < max && current[prefix] === text[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < max - prefix &&
    current[current.length - 1 - suffix] === text[text.length - 1 - suffix]
  ) suffix++;
  // Never split a surrogate pair.
  if (prefix > 0 && isHighSurrogate(text.charCodeAt(prefix - 1))) prefix--;
  if (suffix > 0 && isHighSurrogate(text.charCodeAt(text.length - 1 - suffix))) suffix--;
  const from = para.start + prefix;
  const to = para.start + current.length - suffix;
  const middle = text.slice(prefix, text.length - suffix);
  if (from === to && !middle) return;
  tr.replaceWith(from, to, inline(middle));
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff;

/** The content start of the doc's only paragraph (in a block with an id), or null. */
function singleParagraph(doc: PmNode): { start: number } | null {
  let found: { start: number } | null = null;
  let blocks = 0;
  doc.descendants((node, pos) => {
    if (node.type.name === 'blockContainer') blocks += node.attrs.id ? 1 : 2;
    if (node.isTextblock) {
      if (node.type.name === 'paragraph' && !found) found = { start: pos + 1 };
      return false;
    }
    return true;
  });
  return blocks === 1 ? found : null;
}
