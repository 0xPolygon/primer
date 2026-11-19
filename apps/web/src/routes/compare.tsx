import { useMemo } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { useVersionsQuery } from '../queries/versions.ts';
import { useDocument } from '../queries/documents.ts';
import { useTheme } from '../lib/useTheme.ts';
import { api } from '../lib/fetch.ts';
import { extractText } from '../lib/extractText.ts';
import {
  parseViewParam,
  resolveCompareParams,
  type CompareView,
} from '../lib/compareParams.ts';

/**
 * The text compared for one version. A checkpoint of a live document diffs
 * its bundle's export (Markdown or text, exactly as exported); an HTML
 * version, including those a document had before it went live, diffs the
 * text of its rendered page.
 */
function useVersionText(docId: string, version: { id: string; versionNumber: number } | undefined, live: boolean | undefined) {
  return useQuery({
    queryKey: ['version-text', docId, version?.id ?? '', live],
    queryFn: async ({ signal }): Promise<string> => {
      if (!version) throw new Error('version required');
      if (live) {
        const res = await api(`/api/documents/${docId}/export?version=${version.versionNumber}`, { signal });
        if (res.ok) return res.text();
        if (res.status !== 404) throw new Error(`export fetch failed: ${res.status}`);
      }
      const res = await api(`/api/versions/${version.id}/content`, { signal });
      if (!res.ok) throw new Error(`content fetch failed: ${res.status}`);
      return extractText(await res.text());
    },
    enabled: !!version && live !== undefined,
    staleTime: 60_000,
  });
}

function diffStylesFromTheme(isDark: boolean) {
  if (isDark) {
    return {
      variables: {
        dark: {
          diffViewerBackground: '#0a0a0a',
          diffViewerColor: '#e5e5e5',
          addedBackground: '#0f3a1f',
          addedColor: '#d1fae5',
          removedBackground: '#3f1a1a',
          removedColor: '#fecaca',
          wordAddedBackground: '#16632e',
          wordRemovedBackground: '#7a1f1f',
          gutterBackground: '#171717',
          gutterColor: '#525252',
          emptyLineBackground: '#0f0f0f',
        },
      },
    };
  }
  return {
    variables: {
      light: {
        diffViewerBackground: '#ffffff',
        diffViewerColor: '#1f2937',
        addedBackground: '#dcfce7',
        addedColor: '#14532d',
        removedBackground: '#fee2e2',
        removedColor: '#7f1d1d',
        wordAddedBackground: '#86efac',
        wordRemovedBackground: '#fca5a5',
        gutterBackground: '#fafafa',
        gutterColor: '#9ca3af',
        emptyLineBackground: '#f9fafb',
      },
    },
  };
}

export default function ComparePage() {
  const { docId = '', fromV, toV } = useParams<{
    docId: string;
    fromV: string;
    toV: string;
  }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const view: CompareView = parseViewParam(searchParams.get('view'));

  const versionsQuery = useVersionsQuery(docId);
  const versions = versionsQuery.data?.versions ?? [];
  const resolution = useMemo(
    () => resolveCompareParams(versions, fromV, toV),
    [versions, fromV, toV],
  );

  const docQuery = useDocument(docId);
  const live = docQuery.data ? docQuery.data.document.format !== null : undefined;
  const fromContent = useVersionText(docId, resolution.kind === 'ok' ? resolution.from : undefined, live);
  const toContent = useVersionText(docId, resolution.kind === 'ok' ? resolution.to : undefined, live);
  const fromText = fromContent.data ?? '';
  const toText = toContent.data ?? '';

  const { effective } = useTheme();
  const isDark = effective === 'dark';

  function toggleView(next: CompareView) {
    const params = new URLSearchParams(searchParams);
    if (next === 'split') params.delete('view');
    else params.set('view', next);
    setSearchParams(params, { replace: true });
  }

  const header = (
    <div className="flex items-center justify-between gap-4 border-b border-neutral-200 px-6 py-3 dark:border-neutral-800">
      <div className="flex items-center gap-3">
        <Link to={`/d/${docId}`} className="text-xs text-neutral-500 underline">
          ← Back
        </Link>
        {docQuery.data?.document.title && (
          <span className="truncate text-sm font-medium text-neutral-700 dark:text-neutral-300">
            {docQuery.data.document.title}
          </span>
        )}
        {resolution.kind === 'ok' && (
          <span className="font-mono text-sm text-neutral-700 dark:text-neutral-300">
            v{resolution.from.versionNumber} → v{resolution.to.versionNumber}
          </span>
        )}
      </div>
      <div className="inline-flex overflow-hidden rounded border border-neutral-200 text-xs dark:border-neutral-800">
        <button
          type="button"
          onClick={() => toggleView('split')}
          aria-pressed={view === 'split'}
          className={`px-3 py-1 ${
            view === 'split'
              ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
              : 'bg-white text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300'
          }`}
        >
          Split
        </button>
        <button
          type="button"
          onClick={() => toggleView('unified')}
          aria-pressed={view === 'unified'}
          className={`px-3 py-1 ${
            view === 'unified'
              ? 'bg-neutral-900 text-white dark:bg-neutral-100 dark:text-neutral-900'
              : 'bg-white text-neutral-700 dark:bg-neutral-900 dark:text-neutral-300'
          }`}
        >
          Unified
        </button>
      </div>
    </div>
  );

  if (versionsQuery.isLoading) {
    return (
      <div>
        {header}
        <div className="p-6 text-sm text-neutral-500">Loading versions…</div>
      </div>
    );
  }

  if (versionsQuery.isError) {
    return (
      <div>
        {header}
        <div className="p-6 text-sm text-red-600 dark:text-red-400">
          <p>Failed to load versions.</p>
          <button
            type="button"
            onClick={() => versionsQuery.refetch()}
            className="mt-2 underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (resolution.kind === 'invalid') {
    return (
      <div>
        {header}
        <div className="p-6 text-sm text-neutral-700 dark:text-neutral-300">
          <p>Invalid compare URL.</p>
          <Link to={`/d/${docId}/compare`} className="mt-2 inline-block underline">
            Pick versions to compare →
          </Link>
        </div>
      </div>
    );
  }

  if (resolution.kind === 'not-found') {
    return (
      <div>
        {header}
        <div className="p-6 text-sm text-neutral-700 dark:text-neutral-300">
          <p>Version v{resolution.missing} not found.</p>
          <Link to={`/d/${docId}/compare`} className="mt-2 inline-block underline">
            Pick versions to compare →
          </Link>
        </div>
      </div>
    );
  }

  if (resolution.kind === 'identical') {
    return (
      <div>
        {header}
        <div className="p-6 text-sm text-neutral-700 dark:text-neutral-300">
          <p>These two versions render to identical text.</p>
          <Link to={`/d/${docId}/compare`} className="mt-2 inline-block underline">
            Pick versions to compare →
          </Link>
        </div>
      </div>
    );
  }

  if (fromContent.isLoading || toContent.isLoading) {
    return (
      <div>
        {header}
        <div className="p-6 text-sm text-neutral-500">Loading diff…</div>
      </div>
    );
  }

  if (fromContent.isError || toContent.isError) {
    return (
      <div>
        {header}
        <div className="p-6 text-sm text-red-600 dark:text-red-400">
          <p>Failed to load version content.</p>
          <button
            type="button"
            onClick={() => {
              fromContent.refetch();
              toContent.refetch();
            }}
            className="mt-2 underline"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  if (fromText === toText) {
    return (
      <div>
        {header}
        <div className="p-6 text-sm text-neutral-700 dark:text-neutral-300">
          <p>These two versions render to identical text.</p>
          <Link to={`/d/${docId}/compare`} className="mt-2 inline-block underline">
            Pick versions to compare →
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      {header}
      <div className="p-2">
        <ReactDiffViewer
          oldValue={fromText}
          newValue={toText}
          splitView={view === 'split'}
          compareMethod={DiffMethod.WORDS}
          showDiffOnly={false}
          useDarkTheme={isDark}
          leftTitle={`v${resolution.from.versionNumber}`}
          rightTitle={`v${resolution.to.versionNumber}`}
          styles={diffStylesFromTheme(isDark)}
        />
      </div>
    </div>
  );
}
