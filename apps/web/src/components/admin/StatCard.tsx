import type { AdminStatsBucket } from '@polygonlabs/primer-api-types';
import { t } from '../../i18n/index.ts';

interface StatCardProps {
  label: string;
  bucket: AdminStatsBucket;
}

export function StatCard({ label, bucket }: StatCardProps) {
  const deltaClass = bucket.last7d > 0
    ? 'text-neutral-500'
    : 'text-neutral-400 dark:text-neutral-500';
  return (
    <div className="rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="text-xs uppercase tracking-wider text-neutral-600 dark:text-neutral-400">{label}</div>
      <div className="mt-1 text-3xl font-semibold text-neutral-900 dark:text-neutral-100">
        {bucket.total.toLocaleString()}
      </div>
      <div className={`mt-1 text-xs ${deltaClass}`}>
        +{bucket.last7d.toLocaleString()} {t('statCard.thisWeek')}
      </div>
    </div>
  );
}

export function SkeletonCard() {
  return (
    <div className="rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <div className="h-3 w-20 rounded bg-neutral-200 dark:bg-neutral-700" />
      <div className="mt-2 h-8 w-16 rounded bg-neutral-200 dark:bg-neutral-700" />
      <div className="mt-2 h-3 w-24 rounded bg-neutral-200 dark:bg-neutral-700" />
    </div>
  );
}
