/** @jsxRuntime automatic */
/** @jsxImportSource react */
import { createReactBlockSpec } from '@blocknote/react';
import { useBlockText, usePrimerBlockServices } from './services.ts';

/**
 * Columns: a `columnList` lays its `column` children side by side, and each
 * column holds any blocks except another column list. Built on BlockNote's
 * layout-block pattern. A list left with one column dissolves into that
 * column's blocks, and a column emptied of blocks goes away.
 */
export const columnListBlock = createReactBlockSpec(
  {
    type: 'columnList',
    propSchema: {},
    content: 'none',
    layoutOnly: true,
    children: { allow: ['column'], min: 2, dissolve: true },
  },
  {
    renderFrame: (props) => <ColumnListFrame {...(props as unknown as FrameProps)} />,
    // Exports read the columns one after another.
    toExternalHTML: (props) => <div data-primer-columns="" ref={props.childrenRef} />,
  },
);

export const columnBlock = createReactBlockSpec(
  {
    type: 'column',
    propSchema: {},
    content: 'none',
    layoutOnly: true,
    placeable: 'namedOnly',
    children: { exclude: ['columnList'] },
  },
  {
    renderFrame: (props) => <div className="primer-column" data-primer-column="" ref={(props as unknown as FrameProps).slotRef} />,
    toExternalHTML: (props) => <div data-primer-column="" ref={props.childrenRef} />,
  },
);

type FrameProps = {
  block: { id: string; children: { id: string }[] };
  editor: {
    isEditable: boolean;
    insertBlocks(blocks: unknown[], reference: string, placement: 'before' | 'after'): unknown[];
  };
  slotRef: (node: HTMLElement | null) => void;
};

function ColumnListFrame({ block, editor, slotRef }: FrameProps) {
  const text = useBlockText();
  const live = usePrimerBlockServices() !== null;
  const last = block.children[block.children.length - 1];
  return (
    <div className="primer-columns" data-primer-columns="">
      <div className="primer-columns-row" ref={slotRef} />
      {live && editor.isEditable && last && block.children.length < MAX_COLUMNS && (
        <button
          type="button"
          className="primer-columns-add"
          contentEditable={false}
          onClick={() => editor.insertBlocks([{ type: 'column', children: [{ type: 'paragraph' }] }], last.id, 'after')}
        >
          {text.addColumn}
        </button>
      )}
    </div>
  );
}

const MAX_COLUMNS = 6;
