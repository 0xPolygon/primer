import { t } from '../i18n/index.ts';
import { useRef } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { useDocumentTitle } from '../lib/useDocumentTitle.ts';
import { extractCanonicalDocId } from '../lib/docIdParam.ts';

/**
 * "Print / PDF" for a live document: the server's static rendering in a
 * sandboxed frame, which opens the browser's print dialog once it has loaded
 * (the frame is the only place a served page may do that). The page's own
 * chrome never prints; the button asks the frame to print again.
 */
export function PrintPage() {
  const { docId: raw = '' } = useParams();
  const [params] = useSearchParams();
  const docId = extractCanonicalDocId(raw);
  const frame = useRef<HTMLIFrameElement>(null);
  useDocumentTitle(t('print.title'));
  if (!docId) return null;
  const version = params.get('version');
  const src = `/api/documents/${docId}/print${version ? `?version=${encodeURIComponent(version)}` : ''}`;
  return (
    <div className="flex h-screen flex-col bg-neutral-100 dark:bg-neutral-900">
      <div className="flex items-center justify-end gap-2 border-b border-neutral-200 px-4 py-2 print:hidden dark:border-neutral-800">
        <button
          type="button"
          onClick={() => frame.current?.contentWindow?.postMessage('primer:print', '*')}
          className="h-7 rounded border border-neutral-300 px-3 text-xs text-neutral-700 hover:bg-neutral-100 dark:border-neutral-700 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          {t('print.printPdf')}
        </button>
      </div>
      <iframe ref={frame} src={src} sandbox="allow-scripts allow-modals" title={t('print.preview')} className="min-h-0 flex-1 bg-white" />
    </div>
  );
}
