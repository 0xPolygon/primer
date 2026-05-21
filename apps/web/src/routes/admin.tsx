import { useAdminStats } from '../queries/admin.ts';
import type { AdminStatsBucket, AdminStatsResponse } from '@primer/shared';

interface StatCardProps {
  label: string;
  bucket: AdminStatsBucket;
}

function StatCard({ label, bucket }: StatCardProps) {
  const deltaClass = bucket.last7d > 0 ? 'text-neutral-500' : 'text-neutral-400';
  return (
    <div className="rounded border border-neutral-200 bg-white p-4">
      <div className="text-xs uppercase tracking-wider text-neutral-600">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-neutral-900">
        {bucket.total.toLocaleString()}
      </div>
      <div className={`mt-1 text-xs ${deltaClass}`}>
        +{bucket.last7d.toLocaleString()} this week
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded border border-neutral-200 bg-white p-4">
      <div className="h-3 w-20 rounded bg-neutral-200" />
      <div className="mt-2 h-8 w-16 rounded bg-neutral-200" />
      <div className="mt-2 h-3 w-24 rounded bg-neutral-200" />
    </div>
  );
}

const METRICS: { key: keyof AdminStatsResponse; label: string }[] = [
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
    <div className="max-w-3xl space-y-4">
      <header className="border-b border-neutral-200 pb-3">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <p className="text-sm text-neutral-600">
          Top-line Primer usage. Read-only.
        </p>
      </header>

      {q.error && (
        <div className="rounded border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
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
  );
}
