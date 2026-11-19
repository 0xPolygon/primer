import * as Y from 'yjs';
import type { Node as PmNode } from '@tiptap/pm/model';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import type { Target, WidgetLabelOutcome } from '@polygonlabs/primer-api-types';
import { serverEditor } from '../live/editor.ts';
import { liveDocName, liveInstance } from '../live/instance.ts';
import { SYSTEM_ORIGIN } from '../live/origin.ts';
import type { PlannedEdit } from '../live/pipeline.ts';
import { fragmentName, tabFragmentName, tabsOf } from '../live/reach.ts';

/**
 * A text sub-fragment (a widget label, `widget/<blockId>/<textId>`) holds one
 * paragraph block whose id is the owning block's id, so the pipeline locates
 * it by the Target's `blockId` and its `block.version` is the precondition of
 * a label edit. This builds that content.
 */
export function textFragmentContent(blockId: string, text: string): PmNode {
  return serverEditor()._blocksToProsemirrorNode([{ id: blockId, type: 'paragraph', content: text }] as never);
}

/** Sets one label's words (one line), whatever the fragment held. */
export function labelEdit(target: Target & { textId: string }, text: string, inverse = false): PlannedEdit {
  const words = text.replace(/\s+/g, ' ').trim();
  return {
    target,
    inverse,
    build: (tr, at) => {
      if (at) {
        const paragraph = at.node.firstChild!;
        const from = at.pos + 2;
        const to = from + paragraph.content.size;
        if (paragraph.textContent === words) return;
        if (words === '') tr.delete(from, to);
        else tr.replaceWith(from, to, serverEditor().editor.pmSchema.text(words));
        return;
      }
      tr.replaceWith(0, tr.doc.content.size, textFragmentContent(target.blockId, words).content);
    },
  };
}

/** A label's current words, or null when the fragment holds none yet. */
export function readLabel(doc: Y.Doc, blockId: string, textId: string): string | null {
  const fragment = doc.getXmlFragment(fragmentName({ tabId: '', blockId, textId }));
  if (fragment.length === 0) return null;
  const parts: string[] = [];
  const collect = (node: { type?: string; text?: string; content?: unknown[] }) => {
    if (node.type === 'text' && typeof node.text === 'string') parts.push(node.text);
    for (const child of (node.content ?? []) as (typeof node)[]) collect(child);
  };
  collect(yXmlFragmentToProsemirrorJSON(fragment) as never);
  return parts.join('');
}

/** The tab whose fragment holds block `blockId`, or null. */
export function tabOfBlock(doc: Y.Doc, blockId: string): string | null {
  for (const tab of tabsOf(doc)) {
    if (findElement(doc.getXmlFragment(tabFragmentName(tab.id)), (el) => el.nodeName === 'blockContainer' && el.getAttribute('id') === blockId)) {
      return tab.id;
    }
  }
  return null;
}

function findElement(node: Y.XmlFragment | Y.XmlElement, match: (el: Y.XmlElement) => boolean): Y.XmlElement | null {
  for (const child of node.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue;
    if (match(child)) return child;
    const found = findElement(child, match);
    if (found) return found;
  }
  return null;
}

/** Runs `fn` on the document's live Y.Doc (the one the hub and the pipeline share). Reads only. */
export async function readLiveDoc<T>(documentId: string, fn: (doc: Y.Doc) => T): Promise<T> {
  const connection = await liveInstance().openDirectConnection(liveDocName(documentId), SYSTEM_ORIGIN);
  try {
    return fn(connection.document!);
  } finally {
    await connection.disconnect({ unloadImmediately: false });
  }
}

/**
 * Three-way carry of label words over a republish, per text id the new
 * publish draws: `base` = the previous publish's words, `mine` = the
 * fragment's current words (people's edits), `theirs` = the new publish's.
 * A person's edit is never lost: if the agent changed the same label too, the
 * person's words stay and the agent is told (`kept`).
 */
export function carryLabels(
  base: Record<string, string>,
  mine: Record<string, string | null>,
  theirs: Record<string, string>,
): { texts: Record<string, string>; outcomes: WidgetLabelOutcome[] } {
  const texts: Record<string, string> = {};
  const outcomes: WidgetLabelOutcome[] = [];
  for (const [textId, agentText] of Object.entries(theirs)) {
    const current = mine[textId] ?? null;
    if (current === null || current === agentText || current === base[textId]) {
      texts[textId] = agentText;
    } else if (agentText === base[textId]) {
      texts[textId] = current;
      outcomes.push({ textId, status: 'carried', text: current, agentText });
    } else {
      texts[textId] = current;
      outcomes.push({ textId, status: 'kept', text: current, agentText });
    }
  }
  return { texts, outcomes };
}
