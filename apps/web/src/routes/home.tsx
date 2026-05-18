import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useDashboardQuery } from '../queries/dashboard.ts';
import {
  ActivityRow,
  DeletedDocumentRow,
  MyDocumentRow,
} from '../components/DocumentListRow.tsx';
import { AddVersionModal } from '../components/AddVersionModal.tsx';

export function HomePage() {
  const q = useDashboardQuery();
  const [showAddVersion, setShowAddVersion] = useState(false);
  const [showDeleted, setShowDeleted] = useState(false);

  return (
    <div className="space-y-8 max-w-3xl">
      <header className="flex items-center justify-between border-b border-neutral-200 pb-3">
        <h1 className="text-2xl font-semibold">Primer</h1>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowAddVersion(true)}
            className="rounded border border-neutral-300 bg-white px-3 py-1.5 text-sm text-neutral-700 hover:bg-neutral-50"
          >
            + Add new version
          </button>
          <Link
            to="/upload"
            className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800"
          >
            + Upload document
          </Link>
        </div>
      </header>

      {q.isLoading && <div className="text-sm text-neutral-500">Loading…</div>}
      {q.error && (
        <div className="text-sm text-red-600">
          Could not load dashboard: {(q.error as Error).message}
        </div>
      )}

      {q.data && (
        <>
          <section>
            <div className="mb-2 flex items-baseline justify-between border-b border-neutral-200 pb-1">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-900">
                My documents
              </h2>
              <span className="text-xs text-neutral-500">
                {q.data.myDocuments.length}{' '}
                {q.data.myDocuments.length === 1 ? 'doc' : 'docs'}
              </span>
            </div>
            {q.data.myDocuments.length === 0 ? (
              <div className="px-1 py-4 text-sm italic text-neutral-500">
                No documents yet. Upload your first one.
              </div>
            ) : (
              q.data.myDocuments.map((doc) => <MyDocumentRow key={doc.id} doc={doc} />)
            )}
          </section>

          <section>
            <div className="mb-2 flex items-baseline justify-between border-b border-neutral-200 pb-1">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-900">
                Recently viewed or commented
              </h2>
              <span className="text-xs text-neutral-500">Last 30 days</span>
            </div>
            {q.data.recentlyViewedOrCommented.length === 0 ? (
              <div className="px-1 py-4 text-sm italic text-neutral-500">Nothing recent.</div>
            ) : (
              q.data.recentlyViewedOrCommented.map((entry) => (
                <ActivityRow key={entry.id} entry={entry} />
              ))
            )}
          </section>

          <section>
            <button
              type="button"
              onClick={() => setShowDeleted((s) => !s)}
              className="flex w-full items-baseline justify-between border-b border-neutral-200 pb-1 text-left"
              aria-expanded={showDeleted}
            >
              <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-900">
                Recently deleted
              </h2>
              <span className="text-xs text-neutral-500">
                {q.data.recentlyDeleted.length === 0
                  ? showDeleted
                    ? 'none'
                    : '—'
                  : `${q.data.recentlyDeleted.length}`}{' '}
                {showDeleted ? '▾' : '▸'}
              </span>
            </button>
            {showDeleted && (
              <>
                {q.data.recentlyDeleted.length === 0 ? (
                  <div className="px-1 py-4 text-sm italic text-neutral-500">
                    No deleted documents.
                  </div>
                ) : (
                  q.data.recentlyDeleted.map((entry) => (
                    <DeletedDocumentRow key={entry.id} entry={entry} />
                  ))
                )}
              </>
            )}
          </section>
        </>
      )}

      <AddVersionModal open={showAddVersion} onClose={() => setShowAddVersion(false)} />
    </div>
  );
}
