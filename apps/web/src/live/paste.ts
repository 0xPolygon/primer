import type { BlockNoteEditor } from '@blocknote/core';
import type { ConvertMarkdownResponse } from '@polygonlabs/primer-api-types';
import { api } from '../lib/fetch.ts';

/**
 * Rich paste. BlockNote's stock paste already takes HTML from Google Docs,
 * Word, Notion and the web (office markup is normalised first), files and
 * VS Code, and decides when plain text is Markdown. The one thing Primer
 * changes is what "paste Markdown" does: the text goes to the server's
 * importer instead of BlockNote's own Markdown parser, so a paste and an
 * upload of the same text give the same blocks.
 *
 * The server is asked after the paste event has returned, so the cursor block
 * is captured first and the result is inserted relative to it. If the server
 * can't be reached, the text is pasted as plain text rather than lost.
 */
export function routeMarkdownPasteToServer(editor: BlockNoteEditor<any, any, any>): void {
  editor.pasteMarkdown = async (markdown: string) => {
    const at = editor.getTextCursorPosition().block;
    let blocks: unknown[];
    try {
      const res = await api('/api/convert/markdown', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ markdown }),
      });
      if (!res.ok) throw new Error(`convert failed: ${res.status}`);
      blocks = ((await res.json()) as ConvertMarkdownResponse).blocks;
    } catch {
      editor.pasteText(markdown);
      return;
    }
    if (blocks.length === 0) return;
    // A paste into an empty paragraph replaces it; anywhere else it follows the cursor block.
    const empty = at.type === 'paragraph' && Array.isArray(at.content) && at.content.length === 0 && at.children.length === 0;
    const inserted = empty
      ? editor.replaceBlocks([at], blocks as never).insertedBlocks
      : editor.insertBlocks(blocks as never, at, 'after');
    const last = inserted[inserted.length - 1];
    if (last) editor.setTextCursorPosition(last, 'end');
  };
}
