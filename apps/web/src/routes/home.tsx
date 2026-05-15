import { Link } from 'react-router-dom';
import { useDashboardQuery } from '../queries/dashboard.ts';
import { ActivityRow, MyDocumentRow } from '../components/DocumentListRow.tsx';

export function HomePage() {
  const q = useDashboardQuery();
  return (
    <div className="space-y-8 max-w-3xl">
      <header className="flex items-center justify-between border-b border-neutral-200 pb-3">
        <h1 className="text-2xl font-semibold">Primer</h1>
        <Link
          to="/upload"
          className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white hover:bg-neutral-800"
        >
          + Upload document
        </Link>
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
        </>
      )}
    </div>
  );
}
