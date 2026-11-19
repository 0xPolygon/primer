import { BlockNoteSchema, createCodeBlockSpec, createExtension, defaultBlockSpecs } from '@blocknote/core';
import { CommentMark } from '@blocknote/core/comments';
import { codeBlockOptions } from '@blocknote/code-block';
import { createReactMathBlockSpec } from '@blocknote/math-block';
import { createReactDiagramBlockSpec } from '@blocknote/diagram-block';
import { sourceBlock } from './source.tsx';
import { choiceBlock, choiceOptionBlock } from './choice.tsx';
import { taskBlock } from './task.tsx';

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
    choice: choiceBlock(),
    choiceOption: choiceOptionBlock(),
    task: taskBlock(),
  },
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
