import { BlockNoteSchema, createCodeBlockSpec, createExtension, defaultBlockSpecs, defaultInlineContentSpecs } from '@blocknote/core';
import { CommentMark } from '@blocknote/core/comments';
import { codeBlockOptions } from '@blocknote/code-block';
import { createReactMathBlockSpec } from '@blocknote/math-block';
import { createReactDiagramBlockSpec } from '@blocknote/diagram-block';
import { dateChip, dropdownChip, mentionChip } from './chips.tsx';
import { citationChip } from './citation.tsx';
import { sourceBlock } from './source.tsx';
import { pendingBlock } from './pending.tsx';
import { choiceBlock, choiceOptionBlock } from './choice.tsx';
import { taskBlock } from './task.tsx';
import { pageBlock } from './page.tsx';
import { calloutBlock } from './callout.tsx';
import { columnBlock, columnListBlock } from './columns.tsx';
import { embedBlock } from './embed.tsx';

/**
 * Primer's document model: every stock BlockNote block, code with languages,
 * math, Mermaid, and Primer's own blocks as they land. The API's server editor
 * and the web editor both use it, so a document reads the same everywhere.
 */
export const primerSchema = BlockNoteSchema.create({
  blockSpecs: {
    ...defaultBlockSpecs,
    codeBlock: createCodeBlockSpec(codeBlockOptions),
    mathBlock: createReactMathBlockSpec(),
    diagram: createReactDiagramBlockSpec(),
    source: sourceBlock(),
    pending: pendingBlock(),
    choice: choiceBlock(),
    choiceOption: choiceOptionBlock(),
    task: taskBlock(),
    page: pageBlock(),
    callout: calloutBlock(),
    columnList: columnListBlock(),
    column: columnBlock(),
    embed: embedBlock(),
  },
  inlineContentSpecs: { ...defaultInlineContentSpecs, mention: mentionChip, date: dateChip, dropdown: dropdownChip, citation: citationChip },
});

export type PrimerSchema = typeof primerSchema;

/**
 * BlockNote's `comment` mark, registered without the comments UI. Comment
 * marks are part of the document (they anchor threads), so every editor that
 * opens a Y.Doc must know the mark: y-prosemirror deletes text whose marks the
 * schema doesn't know. The web editor swaps this for BlockNote's
 * CommentsExtension, which registers the same mark, once comments ship.
 */
export const commentMarkExtension = createExtension({
  key: 'primerCommentMark',
  tiptapExtensions: [CommentMark],
});
