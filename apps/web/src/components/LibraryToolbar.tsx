import { t } from '../i18n/index.ts';
import type { Chip, SortKey } from '../lib/library.ts';

export interface LibraryToolbarProps {
  q: string;
  onQChange: (q: string) => void;
  chip: Chip;
  onChipChange: (chip: Chip) => void;
  sortKey: SortKey;
  onSortKeyChange: (k: SortKey) => void;
  layout: 'list' | 'cards';
  onLayoutChange: (l: 'list' | 'cards') => void;
  showFoldersButton?: boolean;
  onOpenFolders?: () => void;
}

const CHIPS: ReadonlyArray<{ key: Chip; label: string }> = [
  { key: 'all', label: t('libraryToolbar.all') },
  { key: 'mine', label: t('libraryToolbar.mine') },
  { key: 'shared', label: t('libraryToolbar.shared') },
  { key: 'templates', label: t('libraryToolbar.templates') },
  { key: 'deleted', label: t('libraryToolbar.deleted') },
];

const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'activity', label: t('libraryToolbar.recentActivity') },
  { key: 'uploaded', label: t('libraryToolbar.recentlyUploaded') },
  { key: 'title-asc', label: t('libraryToolbar.titleAsc') },
  { key: 'title-desc', label: t('libraryToolbar.titleDesc') },
];

export function LibraryToolbar(props: LibraryToolbarProps) {
  return (
    <div className="flex flex-col gap-2 border-b border-neutral-200 pb-3 dark:border-neutral-800">
      <div className="flex items-center gap-2">
        {props.showFoldersButton && (
          <button
            type="button"
            onClick={props.onOpenFolders}
            className="md:hidden rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700"
          >
            {t('libraryToolbar.folders')}
          </button>
        )}
        <input
          type="search"
          value={props.q}
          onChange={(e) => props.onQChange(e.target.value)}
          placeholder={t('libraryToolbar.search')}
          className="flex-1 rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <div className="flex items-center gap-2 overflow-x-auto">
        <div className="flex gap-1 shrink-0" role="tablist" aria-label={t('libraryToolbar.filter')}>
          {CHIPS.map((c) => {
            const active = c.key === props.chip;
            return (
              <button
                key={c.key}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => props.onChipChange(c.key)}
                className={
                  'rounded-full px-3 py-1 text-xs whitespace-nowrap ' +
                  (active
                    ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
                    : 'bg-neutral-100 text-neutral-700 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-300 dark:hover:bg-neutral-700')
                }
              >
                {c.label}
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-2 shrink-0">
          <label className="text-xs text-neutral-500">
            {t('libraryToolbar.sort')}{' '}
            <select
              value={props.sortKey}
              onChange={(e) => props.onSortKeyChange(e.target.value as SortKey)}
              className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 text-xs dark:border-neutral-700 dark:bg-neutral-900"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex overflow-hidden rounded border border-neutral-300 dark:border-neutral-700">
            <button
              type="button"
              aria-label={t('libraryToolbar.listView')}
              aria-pressed={props.layout === 'list'}
              onClick={() => props.onLayoutChange('list')}
              className={
                'px-2 py-1 text-xs ' +
                (props.layout === 'list' ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : '')
              }
            >
              ▤
            </button>
            <button
              type="button"
              aria-label={t('libraryToolbar.cardsView')}
              aria-pressed={props.layout === 'cards'}
              onClick={() => props.onLayoutChange('cards')}
              className={
                'px-2 py-1 text-xs ' +
                (props.layout === 'cards' ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900' : '')
              }
            >
              ▦
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
