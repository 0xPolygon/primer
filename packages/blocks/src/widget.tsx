import { createContext, useContext, type ComponentType } from 'react';
import { createReactBlockSpec } from '@blocknote/react';

/**
 * Props of a `widget` block: an agent-drawn SVG diagram or chart. The widget
 * itself (source, rows, the published SVG for each theme) lives in the API's
 * `widgets` table; the document holds its id, the hash of the live publish
 * (so viewers redraw when it changes) and its label text ids, space-separated.
 * Each label's words live in the fragment `widget/<blockId>/<textId>`.
 */
export type WidgetBlockProps = { widgetId: string; hash: string; textIds: string };

export type WidgetViewProps = { blockId: string; props: WidgetBlockProps; editable: boolean };

/** The view a host app draws a widget with (the web app's live view, with
 *  label editing and comments). Without one, a placeholder renders. */
export const WidgetViewContext = createContext<ComponentType<WidgetViewProps> | null>(null);

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
    render: ({ block, editor }) => (
      <WidgetSlot blockId={block.id} props={block.props as WidgetBlockProps} editable={editor.isEditable} />
    ),
    // Markdown and external HTML keep a reference, never nothing: a fenced
    // `primer-widget` block naming the widget.
    toExternalHTML: ({ block }) => (
      <pre>
        <code className="language-primer-widget">{(block.props as WidgetBlockProps).widgetId}</code>
      </pre>
    ),
  },
);

function WidgetSlot(props: WidgetViewProps) {
  const View = useContext(WidgetViewContext);
  if (View) return <View {...props} />;
  return <div className="primer-widget" data-widget-id={props.props.widgetId} />;
}
