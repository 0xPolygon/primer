import { filterSuggestionItems, type BlockNoteEditor } from '@blocknote/core';
import { getDefaultReactSlashMenuItems, SuggestionMenuController, type DefaultReactSuggestionItem } from '@blocknote/react';
import type { PrimerSchema } from '@primer/blocks';
import { useMentionableUsers } from '../queries/users.ts';
import { t } from '../i18n/index.ts';

type PrimerEditor = BlockNoteEditor<PrimerSchema['blockSchema'], PrimerSchema['inlineContentSchema'], PrimerSchema['styleSchema']>;

const MAX_MENTIONS = 8;

/**
 * The suggestion menus for inline chips: `@` mentions a person, and the `/`
 * menu gains Date and Dropdown next to BlockNote's own items. A chip is
 * inline content, so all three work in table cells too.
 */
export function ChipMenus({ editor }: { editor: PrimerEditor }) {
  const people = useMentionableUsers().data ?? [];

  const slashItems = async (query: string): Promise<DefaultReactSuggestionItem[]> =>
    filterSuggestionItems(
      [
        ...getDefaultReactSlashMenuItems(editor),
        {
          title: t('chips.date'),
          subtext: t('chips.dateHint'),
          aliases: ['date', 'today', 'when', 'due'],
          group: t('chips.group'),
          onItemClick: () => {
            editor.insertInlineContent([{ type: 'date', props: { date: new Date().toISOString().slice(0, 10) } }, ' ']);
          },
        },
        {
          title: t('chips.dropdown'),
          subtext: t('chips.dropdownHint'),
          aliases: ['dropdown', 'select', 'status', 'choice'],
          group: t('chips.group'),
          onItemClick: () => {
            const options = (window.prompt(t('chips.optionsPrompt'), t('chips.optionsDefault')) ?? '')
              .split(',')
              .map((o) => o.trim())
              .filter((o) => o.length > 0 && o.length <= 100)
              .slice(0, 50);
            if (options.length === 0) return;
            editor.insertInlineContent([{ type: 'dropdown', props: { options: JSON.stringify(options), value: options[0]! } }, ' ']);
          },
        },
      ],
      query,
    );

  const mentionItems = async (query: string): Promise<DefaultReactSuggestionItem[]> =>
    people
      .filter((p) => p.displayName.toLowerCase().includes(query.toLowerCase()))
      .slice(0, MAX_MENTIONS)
      .map((p) => ({
        title: p.displayName,
        onItemClick: () => {
          editor.insertInlineContent([{ type: 'mention', props: { userId: p.id, name: p.displayName } }, ' ']);
        },
      }));

  return (
    <>
      <SuggestionMenuController triggerCharacter="/" getItems={slashItems} />
      <SuggestionMenuController triggerCharacter="@" getItems={mentionItems} />
    </>
  );
}
