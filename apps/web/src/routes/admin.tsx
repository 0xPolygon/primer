import { useAdminStats } from '../queries/admin.ts';
import type { AdminStatsResponse } from '@polygonlabs/primer-api-types';
import { DesktopOnly } from '../components/DesktopOnly.tsx';
import { StatCard, SkeletonCard } from '../components/admin/StatCard.tsx';
import { AreaChart } from '../components/admin/AreaChart.tsx';
import { LineChart } from '../components/admin/LineChart.tsx';
import { BarList } from '../components/admin/BarList.tsx';
import { Histogram } from '../components/admin/Histogram.tsx';
import { StackedBar } from '../components/admin/StackedBar.tsx';
import { Sparkline } from '../components/admin/Sparkline.tsx';
import { formatBytes } from '../components/admin/chartGeom.ts';

const METRICS: { key: 'users' | 'documents' | 'versions' | 'threads' | 'comments' | 'documentViews'; label: string }[] = [
  { key: 'users',         label: 'Users' },
  { key: 'documents',     label: 'Documents' },
  { key: 'versions',      label: 'Versions' },
  { key: 'threads',       label: 'Threads' },
  { key: 'comments',      label: 'Comments' },
  { key: 'documentViews', label: 'Document views' },
];

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded border border-neutral-200 bg-white p-4 dark:border-neutral-800 dark:bg-neutral-900">
      <h3 className="mb-3 text-sm font-medium text-neutral-700 dark:text-neutral-300">{title}</h3>
      {children}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">{title}</h2>
      {children}
    </section>
  );
}

export function AdminPage() {
  const q = useAdminStats();

  return (
    <DesktopOnly>
      <div className="mx-auto max-w-[1100px] space-y-6">
        <header className="border-b border-neutral-200 pb-3 dark:border-neutral-800">
          <h1 className="text-2xl font-semibold">Admin</h1>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            Primer usage over the last 30 days. Read-only.
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

        {/* Top-line cards */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {q.isLoading || !q.data
            ? METRICS.map((m) => <SkeletonCard key={m.key} />)
            : METRICS.map((m) => (
                <StatCard key={m.key} label={m.label} bucket={q.data[m.key]} />
              ))}
        </div>

        {q.data && (
          <>
            <Section title="Adoption">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Card title="Content created per day">
                  <AreaChart data={q.data.adoption.createdPerDay} />
                </Card>
                <Card title="Daily active users">
                  <LineChart
                    data={q.data.adoption.activeUsersPerDay}
                    ariaLabel="Daily active users"
                  />
                </Card>
                <Card title="Cumulative users">
                  <LineChart
                    data={q.data.adoption.cumulativeUsers}
                    ariaLabel="Cumulative users"
                  />
                </Card>
              </div>
            </Section>

            <Section title="Engagement">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Card title="Top 10 documents by viewers">
                  <BarList
                    items={q.data.engagement.topDocumentsByViewers.map((d, i) => ({
                      key: String(i),
                      label: d.title,
                      value: d.viewers,
                    }))}
                  />
                </Card>
                <Card title="Top 10 commenters (last 30d)">
                  <BarList
                    items={q.data.engagement.topCommenters.map((c, i) => ({
                      key: String(i),
                      label: c.displayName,
                      value: c.comments,
                    }))}
                  />
                </Card>
                <div className="md:col-span-2">
                  <Card title="Distribution: viewers per document">
                    <Histogram buckets={q.data.engagement.viewersPerDocHistogram} />
                  </Card>
                </div>
              </div>
            </Section>

            <Section title="Operational">
              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Card title="Storage used (cumulative)">
                  <LineChart
                    data={q.data.operational.storageBytesPerDay}
                    ariaLabel="Storage used"
                    formatY={formatBytes}
                  />
                </Card>
                <Card title="Threads opened vs resolved">
                  <StackedBar data={q.data.operational.threadsOpenedVsResolved} />
                </Card>
                <div className="md:col-span-2">
                  <Card title="Open threads aging > 14 days">
                    <div className="flex items-center gap-4">
                      <div className="text-4xl font-semibold tabular-nums text-neutral-900 dark:text-neutral-100">
                        {q.data.operational.openThreadsAgingOver14d.count.toLocaleString()}
                      </div>
                      <div className="flex-1">
                        <Sparkline data={q.data.operational.openThreadsAgingOver14d.sparkline} />
                      </div>
                    </div>
                  </Card>
                </div>
              </div>
            </Section>
          </>
        )}
      </div>
    </DesktopOnly>
  );
}
