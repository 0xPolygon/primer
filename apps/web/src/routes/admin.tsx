import { useAdminStats } from '../queries/admin.ts';
import type { AdminStatsResponse } from '@primer/shared';
import { DesktopOnly } from '../components/DesktopOnly.tsx';
import { StatCard, SkeletonCard } from '../components/admin/StatCard.tsx';

const METRICS: { key: 'users' | 'documents' | 'versions' | 'threads' | 'comments' | 'documentViews'; label: string }[] = [
  { key: 'users',         label: 'Users' },
  { key: 'documents',     label: 'Documents' },
  { key: 'versions',      label: 'Versions' },
  { key: 'threads',       label: 'Threads' },
  { key: 'comments',      label: 'Comments' },
  { key: 'documentViews', label: 'Document views' },
];

export function AdminPage() {
  const q = useAdminStats();

  return (
    <DesktopOnly>
      <div className="max-w-3xl space-y-4">
        <header className="border-b border-neutral-200 pb-3 dark:border-neutral-800">
          <h1 className="text-2xl font-semibold">Admin</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Top-line Primer usage. Read-only.
          </p>
        </header>

        {q.error && (
          <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300">
            Couldn't load stats — {(q.error as Error).message}.{' '}
            <button
              type="button"
              onClick={() => q.refetch()}
              className="underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {q.isLoading || !q.data
            ? METRICS.map((m) => <SkeletonCard key={m.key} />)
            : METRICS.map((m) => (
                <StatCard key={m.key} label={m.label} bucket={q.data[m.key]} />
              ))}
        </div>
      </div>
    </DesktopOnly>
  );
}
