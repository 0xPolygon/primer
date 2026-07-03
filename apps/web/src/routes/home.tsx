import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useLibraryQuery } from '../queries/library.ts';
import {
  filterAndSort,
  FOLDER_UNCATEGORIZED,
  type Chip,
  type SortKey,
} from '../lib/library.ts';
import { LibraryToolbar } from '../components/LibraryToolbar.tsx';
import { LibrarySidebar } from '../components/LibrarySidebar.tsx';
import { DocRow } from '../components/DocRow.tsx';
import { DocCard } from '../components/DocCard.tsx';
import { DeletedDocumentRow } from '../components/DocumentListRow.tsx';
import { AddVersionModal } from '../components/AddVersionModal.tsx';
import { MobileFoldersSheet } from '../components/MobileFoldersSheet.tsx';

const LAYOUT_KEY = 'primer.library.layout';
const SORT_KEY = 'primer.library.sort';

function readLayout(): 'list' | 'cards' {
  try {
    const v = localStorage.getItem(LAYOUT_KEY);
    return v === 'cards' ? 'cards' : 'list';
  } catch {
    return 'list';
  }
}

function readSort(): SortKey {
  try {
    const v = localStorage.getItem(SORT_KEY);
    if (v === 'activity' || v === 'uploaded' || v === 'title-asc' || v === 'title-desc') return v;
  } catch { /* ignore */ }
  return 'activity';
}

function useDebounced<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

export function HomePage() {
  const q = useLibraryQuery();
  const [params, setParams] = useSearchParams();
  const [showAddVersion, setShowAddVersion] = useState(false);
  const [foldersOpen, setFoldersOpen] = useState(false);
  const [chip, setChip] = useState<Chip>('all');
  const [layout, setLayout] = useState<'list' | 'cards'>(() => readLayout());
  const [sortKey, setSortKey] = useState<SortKey>(() => readSort());
  const [qInput, setQInput] = useState('');
  const qDebounced = useDebounced(qInput, 150);

  // URL-synced folder selection.
  const folderIdRaw = params.get('folder');
  const folderId: string | null =
    folderIdRaw === null ? null : folderIdRaw === '' ? FOLDER_UNCATEGORIZED : folderIdRaw;

  const setFolderId = (next: string | null) => {
    const p = new URLSearchParams(params);
    if (next === null) p.delete('folder');
    else p.set('folder', next);
    setParams(p, { replace: true });
  };

  // Persist layout + sort.
  useEffect(() => {
    try { localStorage.setItem(LAYOUT_KEY, layout); } catch { /* ignore */ }
  }, [layout]);
  useEffect(() => {
    try { localStorage.setItem(SORT_KEY, sortKey); } catch { /* ignore */ }
  }, [sortKey]);

  // 'Deleted' chip → reset folder highlight to All docs.
  useEffect(() => {
    if (chip === 'deleted' && folderId !== null) setFolderId(null);
  }, [chip]);

  const data = q.data;

  const uncategorizedCount = useMemo(
    () => (data ? data.documents.filter((d) => d.folderId === null).length : 0),
    [data],
  );

  const visibleDocs = useMemo(() => {
    if (!data) return [];
    if (chip === 'deleted') return [];
    return filterAndSort(data.documents, { folderId, chip, q: qDebounced, sortKey });
  }, [data, folderId, chip, qDebounced, sortKey]);

  const deletedFiltered = useMemo(() => {
    if (!data || chip !== 'deleted') return [];
    const needle = qDebounced.trim().toLowerCase();
    return needle
      ? data.recentlyDeleted.filter((d) => d.title.toLowerCase().includes(needle))
      : data.recentlyDeleted;
  }, [data, chip, qDebounced]);

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between border-b border-neutral-200 pb-3 dark:border-neutral-800">
        <h1 className="text-2xl font-semibold">Primer</h1>
        <div className="hidden md:flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAddVersion(true)}
            className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
          >
            + Add new version
          </button>
          <Link
            to="/upload"
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
          >
            + Upload document
          </Link>
        </div>
      </header>

      {q.isLoading && <div className="text-sm text-neutral-500">Loading…</div>}
      {q.error && (
        <div className="text-sm text-red-600 dark:text-red-400">
          Could not load library: {(q.error as Error).message}
        </div>
      )}

      {data && (
        <div className="flex gap-6">
          <LibrarySidebar
            folders={data.folders}
            uncategorizedCount={uncategorizedCount}
            totalCount={data.documents.length}
            selectedFolderId={folderId}
            onSelect={setFolderId}
          />
          <main className="flex-1 min-w-0 space-y-3">
            <LibraryToolbar
              q={qInput}
              onQChange={setQInput}
              chip={chip}
              onChipChange={setChip}
              sortKey={sortKey}
              onSortKeyChange={setSortKey}
              layout={layout}
              onLayoutChange={setLayout}
              showFoldersButton={true}
              onOpenFolders={() => setFoldersOpen(true)}
            />

            {chip === 'deleted' ? (
              deletedFiltered.length === 0 ? (
                <EmptyState message="No recently deleted documents." />
              ) : (
                <div>
                  {deletedFiltered.map((entry) => (
                    <DeletedDocumentRow key={entry.id} entry={entry} />
                  ))}
                </div>
              )
            ) : visibleDocs.length === 0 ? (
              <LibraryEmpty
                totalDocs={data.documents.length}
                folderId={folderId}
                folderName={data.folders.find((f) => f.id === folderId)?.name ?? null}
                chip={chip}
                q={qDebounced}
                onClearSearch={() => setQInput('')}
                onClearFilters={() => {
                  setChip('all');
                  setFolderId(null);
                }}
              />
            ) : layout === 'list' ? (
              <div>
                {visibleDocs.map((d) => (
                  <DocRow key={d.id} doc={d} folders={data.folders} />
                ))}
              </div>
            ) : (
              <div className="grid gap-3 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
                {visibleDocs.map((d) => (
                  <DocCard key={d.id} doc={d} folders={data.folders} />
                ))}
              </div>
            )}
          </main>
        </div>
      )}

      <AddVersionModal open={showAddVersion} onClose={() => setShowAddVersion(false)} />
      {data && (
        <MobileFoldersSheet
          open={foldersOpen}
          folders={data.folders}
          uncategorizedCount={uncategorizedCount}
          totalCount={data.documents.length}
          selectedFolderId={folderId}
          onSelect={(id) => {
            setFolderId(id);
            setFoldersOpen(false);
          }}
          onClose={() => setFoldersOpen(false)}
        />
      )}
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return <div className="px-1 py-4 text-sm italic text-neutral-500">{message}</div>;
}

function LibraryEmpty(props: {
  totalDocs: number;
  folderId: string | null;
  folderName: string | null;
  chip: Chip;
  q: string;
  onClearSearch: () => void;
  onClearFilters: () => void;
}) {
  // Zero docs library-wide (new user).
  if (props.totalDocs === 0) {
    return (
      <div className="px-2 py-8 text-center">
        <blockquote className="mx-auto max-w-lg text-sm italic leading-relaxed text-neutral-600 dark:text-neutral-400">
          &ldquo;The Primer was a book in appearance only. Its interior was a tissue of paper, but each page was a
          separate flat-panel display, which formed itself into pictures, words, and animations responsive to the
          reader.&rdquo;
        </blockquote>
        <p className="mt-2 text-xs text-neutral-400 dark:text-neutral-500">— Neal Stephenson, <em>The Diamond Age</em></p>
        <p className="mt-6 text-sm text-neutral-500">
          No documents yet.{' '}
          <Link to="/upload" className="font-medium text-neutral-700 underline hover:text-neutral-900 dark:text-neutral-300 dark:hover:text-neutral-100">
            Upload your first one
          </Link>
          .
        </p>
      </div>
    );
  }
  if (props.q.length > 0) {
    return (
      <div className="px-1 py-4 text-sm text-neutral-500">
        No docs matching &ldquo;{props.q}&rdquo;.{' '}
        <button type="button" onClick={props.onClearSearch} className="underline">
          Clear search
        </button>
      </div>
    );
  }
  if (props.folderName) {
    return (
      <div className="px-1 py-4 text-sm text-neutral-500">
        Nothing in <strong>{props.folderName}</strong> yet. Move docs here from the ⋯ menu.
      </div>
    );
  }
  return (
    <div className="px-1 py-4 text-sm text-neutral-500">
      No documents match this view.{' '}
      <button type="button" onClick={props.onClearFilters} className="underline">
        Clear filters
      </button>
    </div>
  );
}
