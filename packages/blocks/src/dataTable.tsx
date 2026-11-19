import { createReactBlockSpec } from '@blocknote/react';
import { usePrimerBlockServices } from './services.ts';

/**
 * Props of a `dataTable` block: a view over one records collection of the
 * document, never a store of its own. The rows are the collection's records
 * (shared, or the viewer's own personal ones), read and written through the
 * records API; the block only says which collection, which columns
 * (`columns`: JSON `[{ key, label, type, options? }]`) and which scope.
 * A collection named `query:<name>` holds a named warehouse query's results,
 * written by an agent, and shows read-only.
 */
export type DataTableBlockProps = { collection: string; columns: string; scope: 'shared' | 'personal' };

export const dataTableBlock = createReactBlockSpec(
  {
    type: 'dataTable',
    propSchema: {
      collection: { default: '' },
      columns: { default: '[]' },
      scope: { default: 'shared', values: ['shared', 'personal'] as const },
    },
    content: 'none',
  },
  {
    render: ({ block, editor }) => (
      <DataTableSlot
        blockId={block.id}
        props={block.props as DataTableBlockProps}
        update={(props) => editor.updateBlock(block, { props } as never)}
      />
    ),
    // Markdown and external HTML keep a reference: a fenced `primer-data-table`
    // block with the table's props.
    toExternalHTML: ({ block }) => {
      const { collection, columns, scope } = block.props as DataTableBlockProps;
      return (
        <pre>
          <code className="language-primer-data-table">{JSON.stringify({ collection, scope, columns: safeJson(columns) })}</code>
        </pre>
      );
    },
  },
);

function safeJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

/** The web app draws the rows through `DataTableView` (editing, live
 *  refresh, row comments); elsewhere (the server editor, static renders) a
 *  placeholder renders, which a checkpoint's static rendering fills with the
 *  rows frozen in its bundle (`records.json`). */
function DataTableSlot(props: { blockId: string; props: DataTableBlockProps; update: (props: Partial<DataTableBlockProps>) => void }) {
  const DataTableView = usePrimerBlockServices()?.DataTableView;
  if (DataTableView) return <DataTableView {...props} />;
  return <div className="primer-data-table" data-block-id={props.blockId} />;
}
