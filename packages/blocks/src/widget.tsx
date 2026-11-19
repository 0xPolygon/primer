import { createReactBlockSpec } from '@blocknote/react';
import { usePrimerBlockServices } from './services.ts';

/**
 * Props of a `widget` block: an agent-drawn SVG diagram or chart. The widget
 * itself (source, rows, the published SVG for each theme) lives in the API's
 * `widgets` table; the document holds its id, the hash of the live publish
 * (so viewers redraw when it changes) and its label text ids, space-separated.
 * Each label's words live in the fragment `widget/<blockId>/<textId>`.
 */
export type WidgetBlockProps = { widgetId: string; hash: string; textIds: string };

export const widgetBlock = createReactBlockSpec(
  {
    type: 'widget',
    propSchema: {
      widgetId: { default: '' },
      hash: { default: '' },
      textIds: { default: '' },
    },
    content: 'none',
  },
  {
    render: ({ block }) => <WidgetSlot blockId={block.id} props={block.props as WidgetBlockProps} />,
    // Markdown and external HTML keep a reference, never nothing: a fenced
    // `primer-widget` block naming the widget.
    toExternalHTML: ({ block }) => (
      <pre>
        <code className="language-primer-widget">{(block.props as WidgetBlockProps).widgetId}</code>
      </pre>
    ),
  },
);

/** The web app draws the widget through `WidgetView` (its SVG, label editing
 *  and comments); elsewhere (the server editor, static renders) a placeholder
 *  renders, which a checkpoint's static rendering swaps for the SVG. */
function WidgetSlot(props: { blockId: string; props: WidgetBlockProps }) {
  const WidgetView = usePrimerBlockServices()?.WidgetView;
  if (WidgetView) return <WidgetView {...props} />;
  return <div className="primer-widget" data-widget-id={props.props.widgetId} />;
}
