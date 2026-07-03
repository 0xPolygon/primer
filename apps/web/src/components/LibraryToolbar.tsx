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
  { key: 'all', label: 'All' },
  { key: 'mine', label: 'Mine' },
  { key: 'shared', label: 'Shared with me' },
  { key: 'deleted', label: 'Deleted' },
];

const SORT_OPTIONS: ReadonlyArray<{ key: SortKey; label: string }> = [
  { key: 'activity', label: 'Recent activity' },
  { key: 'uploaded', label: 'Recently uploaded' },
  { key: 'title-asc', label: 'Title A→Z' },
  { key: 'title-desc', label: 'Title Z→A' },
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
            Folders ▾
          </button>
        )}
        <input
          type="search"
          value={props.q}
          onChange={(e) => props.onQChange(e.target.value)}
          placeholder="Search…"
          className="flex-1 rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
        />
      </div>
      <div className="flex items-center gap-2 overflow-x-auto">
        <div className="flex gap-1 shrink-0" role="tablist" aria-label="Filter">
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
            Sort{' '}
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
              aria-label="List view"
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
              aria-label="Cards view"
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
