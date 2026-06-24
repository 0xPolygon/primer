import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { VersionSummaryDTO } from '@primer/shared';
import { useVersionsQuery } from '../queries/versions.ts';
import { pickDefaultFromVersion } from '../lib/compareParams.ts';

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return d.toLocaleDateString();
}

export default function CompareSelectPage() {
  const { docId = '' } = useParams<{ docId: string }>();
  const navigate = useNavigate();
  const query = useVersionsQuery(docId);

  const versions: VersionSummaryDTO[] = query.data?.versions ?? [];
  const latest = versions[0];
  const defaultFrom = useMemo(
    () => (latest ? pickDefaultFromVersion(versions, latest.versionNumber) : null),
    [versions, latest],
  );

  const [fromV, setFromV] = useState<number | null>(null);
  const [toV, setToV] = useState<number | null>(null);

  // Apply defaults once versions arrive (after first render to avoid setState-in-render).
  // Only fires when `latest` first becomes available; subsequent refetches do not
  // overwrite the user's picks.
  useEffect(() => {
    if (!latest) return;
    if (fromV !== null || toV !== null) return;
    if (defaultFrom) setFromV(defaultFrom.versionNumber);
    setToV(latest.versionNumber);
  }, [latest?.versionNumber, defaultFrom, fromV, toV]);

  const canCompare = fromV !== null && toV !== null && fromV !== toV;

  function onCompare() {
    if (!canCompare) return;
    navigate(`/d/${docId}/compare/${fromV}/${toV}`);
  }

  function setFrom(n: number) {
    setFromV(n);
    if (toV === n) setToV(null);
  }
  function setTo(n: number) {
    setToV(n);
    if (fromV === n) setFromV(null);
  }

  if (query.isLoading) {
    return <div className="p-6 text-sm text-neutral-500">Loading versions…</div>;
  }
  if (query.isError) {
    return (
      <div className="p-6 text-sm text-red-600 dark:text-red-400">
        Failed to load versions.{' '}
        <button
          type="button"
          onClick={() => query.refetch()}
          className="underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (versions.length < 2) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Link to={`/d/${docId}`} className="text-xs text-neutral-500 underline">
          ← Back to document
        </Link>
        <h1 className="mt-4 text-lg font-semibold">Compare versions</h1>
        <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
          This document only has one version. Add another version to compare.
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link to={`/d/${docId}`} className="text-xs text-neutral-500 underline">
        ← Back to document
      </Link>
      <h1 className="mt-4 text-lg font-semibold">Compare versions</h1>
      <p className="mt-1 text-xs text-neutral-500">
        Pick two versions to see a diff of their rendered text.
      </p>

      <div className="mt-6 overflow-hidden rounded border border-neutral-200 dark:border-neutral-800">
        <div className="grid grid-cols-[auto_auto_1fr] items-center gap-3 border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
          <span>From</span>
          <span>To</span>
          <span>Version</span>
        </div>
        <ul>
          {versions.map((v) => {
            const isLatest = v.versionNumber === latest?.versionNumber;
            return (
              <li
                key={v.id}
                className="grid grid-cols-[auto_auto_1fr] items-center gap-3 border-b border-neutral-100 px-3 py-2 last:border-b-0 dark:border-neutral-800"
              >
                <input
                  type="radio"
                  name="compare-from"
                  aria-label={`Use v${v.versionNumber} as the From side`}
                  checked={fromV === v.versionNumber}
                  onChange={() => setFrom(v.versionNumber)}
                />
                <input
                  type="radio"
                  name="compare-to"
                  aria-label={`Use v${v.versionNumber} as the To side`}
                  checked={toV === v.versionNumber}
                  onChange={() => setTo(v.versionNumber)}
                />
                <div className="min-w-0 text-sm">
                  <span className="font-mono text-neutral-700 dark:text-neutral-300">
                    v{v.versionNumber}
                  </span>
                  {isLatest && (
                    <span className="ml-2 rounded-full bg-neutral-900 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white dark:bg-neutral-100 dark:text-neutral-900">
                      Latest
                    </span>
                  )}
                  <span className="ml-2 text-neutral-500">
                    {v.versionNote ?? <span className="italic text-neutral-400">no note</span>}
                  </span>
                  <span className="ml-2 text-[10px] text-neutral-400">
                    {relativeTime(v.createdAt)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>

      <div className="mt-4 flex justify-end">
        <button
          type="button"
          disabled={!canCompare}
          onClick={onCompare}
          className="inline-flex h-8 items-center rounded bg-neutral-900 px-3 text-xs font-medium text-white hover:bg-neutral-700 disabled:cursor-not-allowed disabled:bg-neutral-300 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300 dark:disabled:bg-neutral-700 dark:disabled:text-neutral-500"
        >
          Compare →
        </button>
      </div>
    </div>
  );
}
