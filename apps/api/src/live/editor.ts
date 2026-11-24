import * as Y from 'yjs';
import { ServerBlockNoteEditor } from '@blocknote/server-util';
import { getDocument } from '@blocknote/server-util/dom';
import { yXmlFragmentToProsemirrorJSON } from 'y-prosemirror';
import { primerSchema, commentMarkExtension, type PrimerSchema } from '@primer/blocks';
import { tabFragmentName } from './reach.ts';

export type PrimerServerEditor = ServerBlockNoteEditor<
  PrimerSchema['blockSchema'],
  PrimerSchema['inlineContentSchema'],
  PrimerSchema['styleSchema']
>;
export type PrimerBlock = ReturnType<PrimerServerEditor['yDocToBlocks']>[number];

let editor: PrimerServerEditor | null = null;
let dom: ReturnType<typeof getDocument> | null = null;

/** The one JSDOM document every conversion shares: each `getDocument()` is a
 *  whole new window, so callers never make their own. */
export function serverDocument(): ReturnType<typeof getDocument> {
  return (dom ??= getDocument());
}

/** The one server editor (Primer's schema, one shared JSDOM document). Use it
 *  for conversions: `editor.pmSchema`, HTML/Markdown import and export. */
export function serverEditor(): PrimerServerEditor {
  editor ??= ServerBlockNoteEditor.create(
    { schema: primerSchema, extensions: [commentMarkExtension] },
    serverDocument(),
  ) as unknown as PrimerServerEditor;
  return editor;
}

/**
 * The blocks of one tab. Reads go through ProseMirror JSON rather than
 * y-prosemirror's node builder, which repairs the Y.Doc in place (deleting
 * content the schema rejects); a read here never writes, and a mismatch throws.
 */
export function readBlocks(doc: Y.Doc, tabId: string): PrimerBlock[] {
  const fragment = doc.getXmlFragment(tabFragmentName(tabId));
  if (fragment.length === 0) return [];
  return serverEditor()._prosemirrorJSONToBlocks(yXmlFragmentToProsemirrorJSON(fragment));
}
