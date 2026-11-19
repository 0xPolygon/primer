import { createReactInlineContentSpec } from '@blocknote/react';

/**
 * Inline chips (M10d): a mention of a person, a date, a dropdown value. They
 * are inline content, so they work in paragraphs, headings, lists and table
 * cells (which is what gives tables date and dropdown cells).
 *
 * Every prop is writable by anyone who can edit the document, so none of them
 * is trusted: a chip shows what it holds and nothing looks anything up from it.
 * A mention keeps the person's id and the name it was made with, never an
 * email, which would travel with the document into shares and exports.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The options of a dropdown, from its stored JSON; anything unreadable is no options. */
export function dropdownOptions(stored: string): string[] {
  try {
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((o): o is string => typeof o === 'string' && o.length > 0 && o.length <= 100).slice(0, 50);
  } catch {
    return [];
  }
}

export const mentionChip = createReactInlineContentSpec(
  { type: 'mention', propSchema: { userId: { default: '' }, name: { default: '' } }, content: 'none' },
  {
    render: ({ inlineContent }) => {
      const { userId, name } = inlineContent.props;
      return (
        <span className="primer-chip primer-mention" data-user-id={UUID.test(userId) ? userId : undefined}>
          @{name}
        </span>
      );
    },
  },
);

export const dateChip = createReactInlineContentSpec(
  { type: 'date', propSchema: { date: { default: '' } }, content: 'none' },
  {
    render: ({ inlineContent, updateInlineContent, editor, getPos }) => {
      const date = ISO_DATE.test(inlineContent.props.date) ? inlineContent.props.date : '';
      // Serialised (exports, static pages) the chip is its text; only the live editor edits it.
      if (!editor.isEditable || getPos() === undefined) {
        return (
          <time className="primer-chip primer-date" dateTime={date || undefined}>
            {date}
          </time>
        );
      }
      return (
        <span className="primer-chip primer-date">
          <input
            type="date"
            value={date}
            onChange={(e) => updateInlineContent({ type: 'date', props: { date: e.target.value } })}
          />
        </span>
      );
    },
  },
);

export const dropdownChip = createReactInlineContentSpec(
  { type: 'dropdown', propSchema: { options: { default: '[]' }, value: { default: '' } }, content: 'none' },
  {
    render: ({ inlineContent, updateInlineContent, editor, getPos }) => {
      const options = dropdownOptions(inlineContent.props.options);
      const { value } = inlineContent.props;
      if (!editor.isEditable || getPos() === undefined) return <span className="primer-chip primer-dropdown">{value}</span>;
      return (
        <span className="primer-chip primer-dropdown">
          <select
            value={value}
            onChange={(e) => updateInlineContent({ type: 'dropdown', props: { options: inlineContent.props.options, value: e.target.value } })}
          >
            {/* A value that is no longer an option stays visible until someone picks another. */}
            {!options.includes(value) && <option value={value}>{value}</option>}
            {options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </span>
      );
    },
  },
);
