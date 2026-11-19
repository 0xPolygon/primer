import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { VersionSummaryDTO } from '@polygonlabs/primer-api-types';
import { useVersionsQuery } from '../queries/versions.ts';
import { useDocument } from '../queries/documents.ts';
import { pickDefaultFromVersion } from '../lib/compareParams.ts';
import { t } from '../i18n/index.ts';

const EMPTY_VERSIONS: VersionSummaryDTO[] = [];

function relativeTime(iso: string): string {
  const d = new Date(iso);
  const diffMs = Date.now() - d.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return t('compareSelect.justNow');
  const min = Math.floor(sec / 60);
  if (min < 60) return t('compareSelect.minutesAgo', { count: min });
  const hr = Math.floor(min / 60);
  if (hr < 24) return t('compareSelect.hoursAgo', { count: hr });
  const day = Math.floor(hr / 24);
  if (day < 7) return t('compareSelect.daysAgo', { count: day });
  return d.toLocaleDateString();
}

export default function CompareSelectPage() {
  const { docId = '' } = useParams<{ docId: string }>();
  const navigate = useNavigate();
  const query = useVersionsQuery(docId);
  const docQuery = useDocument(docId);

  const versions: VersionSummaryDTO[] = query.data?.versions ?? EMPTY_VERSIONS;
  const latest = versions[0];
  const defaultFrom = useMemo(
    () => (latest ? pickDefaultFromVersion(versions, latest.versionNumber) : null),
    [versions, latest],
  );

  const [fromV, setFromV] = useState<number | null>(null);
  const [toV, setToV] = useState<number | null>(null);

  // Apply defaults once versions arrive (after first render to avoid setState-in-render).
  // Runs exactly once when `latest` first becomes available; subsequent refetches and
  // user radio clicks do not re-enter.
  const initialized = useRef(false);
  useEffect(() => {
    if (!latest || initialized.current) return;
    initialized.current = true;
    if (defaultFrom) setFromV(defaultFrom.versionNumber);
    setToV(latest.versionNumber);
  }, [latest?.versionNumber, defaultFrom]);

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
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Link to={`/d/${docId}`} className="text-xs text-neutral-500 underline">
          {t('compareSelect.backToDocument')}
        </Link>
        {docQuery.data?.document.title && (
          <div className="mt-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {docQuery.data.document.title}
          </div>
        )}
        <div className="mt-4 text-sm text-neutral-500">{t('compareSelect.loadingVersions')}</div>
      </div>
    );
  }
  if (query.isError) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Link to={`/d/${docId}`} className="text-xs text-neutral-500 underline">
          {t('compareSelect.backToDocument')}
        </Link>
        {docQuery.data?.document.title && (
          <div className="mt-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {docQuery.data.document.title}
          </div>
        )}
        <div className="mt-4 text-sm text-red-600 dark:text-red-400">
          {t('compareSelect.loadVersionsFailed')}{' '}
          <button
            type="button"
            onClick={() => query.refetch()}
            className="underline"
          >
            {t('compareSelect.retry')}
          </button>
        </div>
      </div>
    );
  }

  if (versions.length < 2) {
    return (
      <div className="mx-auto max-w-2xl p-6">
        <Link to={`/d/${docId}`} className="text-xs text-neutral-500 underline">
          {t('compareSelect.backToDocument')}
        </Link>
        {docQuery.data?.document.title && (
          <div className="mt-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {docQuery.data.document.title}
          </div>
        )}
        <h1 className="mt-4 text-lg font-semibold">{t('compareSelect.title')}</h1>
        <p className="mt-4 text-sm text-neutral-600 dark:text-neutral-400">
          {t('compareSelect.onlyOneVersion')}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl p-6">
      <Link to={`/d/${docId}`} className="text-xs text-neutral-500 underline">
        {t('compareSelect.backToDocument')}
      </Link>
      {docQuery.data?.document.title && (
        <div className="mt-2 text-sm font-medium text-neutral-700 dark:text-neutral-300">
          {docQuery.data.document.title}
        </div>
      )}
      <h1 className="mt-4 text-lg font-semibold">{t('compareSelect.title')}</h1>
      <p className="mt-1 text-xs text-neutral-500">
        {t('compareSelect.pickTwo')}
      </p>

      <div className="mt-6 overflow-hidden rounded border border-neutral-200 dark:border-neutral-800">
        <div className="grid grid-cols-[auto_auto_1fr] items-center gap-3 border-b border-neutral-200 bg-neutral-50 px-3 py-2 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:border-neutral-800 dark:bg-neutral-900">
          <span>{t('compareSelect.from')}</span>
          <span>{t('compareSelect.to')}</span>
          <span>{t('compareSelect.version')}</span>
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
                  aria-label={t('compareSelect.useAsFrom', { number: v.versionNumber })}
                  checked={fromV === v.versionNumber}
                  onChange={() => setFrom(v.versionNumber)}
                />
                <input
                  type="radio"
                  name="compare-to"
                  aria-label={t('compareSelect.useAsTo', { number: v.versionNumber })}
                  checked={toV === v.versionNumber}
                  onChange={() => setTo(v.versionNumber)}
                />
                <div className="min-w-0 text-sm">
                  <span className="font-mono text-neutral-700 dark:text-neutral-300">
                    {t('compareSelect.versionLabel', { number: v.versionNumber })}
                  </span>
                  {isLatest && (
                    <span className="ml-2 rounded-full bg-neutral-900 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-white dark:bg-neutral-100 dark:text-neutral-900">
                      {t('compareSelect.latest')}
                    </span>
                  )}
                  <span className="ml-2 text-neutral-500">
                    {v.versionNote ?? <span className="italic text-neutral-400">{t('compareSelect.noNote')}</span>}
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
          {t('compareSelect.compare')}
        </button>
      </div>
    </div>
  );
}
