import { useState } from 'react';
import { createReactBlockSpec } from '@blocknote/react';

/**
 * A slice of Markdown that BlockNote can't represent (raw HTML, footnotes, or a
 * group whose text didn't survive conversion), kept verbatim so nothing is lost.
 *
 * `previewHtml` is rendered by the server at import (markdown-it, then the
 * upload sanitizer with scripts removed). It is shown in an iframe with an empty
 * sandbox: an opaque origin with no scripts. "Source" shows the raw Markdown,
 * which people can edit; the preview is refreshed server-side on the next import.
 */
export const sourceBlock = createReactBlockSpec(
  {
    type: 'source',
    propSchema: {
      markdown: { default: '' },
      previewHtml: { default: '' },
    },
    content: 'none',
  },
  {
    render: ({ block, editor }) => <SourceView block={block} editor={editor} />,
  },
);

type SourceViewProps = {
  block: { id: string; props: { markdown: string; previewHtml: string } };
  editor: { isEditable: boolean; updateBlock: (id: string, update: { props: { markdown: string } }) => unknown };
};

function SourceView({ block, editor }: SourceViewProps) {
  // View state only: whether this viewer sees the preview or the source.
  const [showSource, setShowSource] = useState(false);
  return (
    <div className="primer-source" data-primer-source="">
      <button type="button" className="primer-source-toggle" onClick={() => setShowSource((s) => !s)}>
        {showSource ? 'Preview' : 'Source'}
      </button>
      {showSource ? (
        <textarea
          className="primer-source-text"
          value={block.props.markdown}
          readOnly={!editor.isEditable}
          spellCheck={false}
          onChange={(e) => editor.updateBlock(block.id, { props: { markdown: e.target.value } })}
        />
      ) : (
        <iframe className="primer-source-preview" sandbox="" srcDoc={block.props.previewHtml} title="Source preview" />
      )}
    </div>
  );
}
