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
 * A label fragment (`widget/<blockId>/<textId>`) has the shape of a page-text
 * fragment (M6), so the one overlay edits both: a single paragraph whose block
 * id is the text id, holding the label's words.
 */
export function textFragmentContent(textId: string, text: string): PmNode {
  return serverEditor()._blocksToProsemirrorNode([{ id: textId, type: 'paragraph', content: text }] as never);
}

/** Sets one label's words (one line), whatever the fragment held. Only the
 *  paragraph's text changes when the fragment already has that shape. */
export function labelEdit(target: Target & { textId: string }, text: string, inverse = false): PlannedEdit {
  const words = text.replace(/\s+/g, ' ').trim();
  return {
    target,
    inverse,
    build: (tr) => {
      const paragraphs: { pos: number; node: PmNode }[] = [];
      tr.doc.descendants((node, pos) => {
        if (node.type.name === 'paragraph') paragraphs.push({ pos, node });
        return !node.isTextblock;
      });
      const only = paragraphs.length === 1 ? paragraphs[0]! : null;
      if (only && only.node.textContent === words) return;
      if (only) {
        const from = only.pos + 1;
        tr.replaceWith(from, from + only.node.content.size, words ? [serverEditor().editor.pmSchema.text(words)] : []);
        return;
      }
      tr.replaceWith(0, tr.doc.content.size, textFragmentContent(target.textId, words).content);
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
