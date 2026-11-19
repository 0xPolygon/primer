import { useEffect, useMemo, useState } from 'react';
import { copyText, type CopyResult } from '../lib/clipboardCopy.ts';
import { countWords, NOTEBOOKLM_URL } from '../lib/notebookLm.ts';
import { t } from '../i18n';

type CopyStatus = 'copying' | 'copied' | 'failed';

interface Props {
  /** The version's HTML, fetched when the modal was opened. */
  html: Promise<string>;
  /** The copy started inside the click that opened the modal (the browser
   *  only allows it there), with comments included. */
  initialCopy: Promise<CopyResult>;
  commentCount: number;
  buildSource: (html: string, includeComments: boolean) => string;
  filename: string;
  onClose: () => void;
}

/** Hands a document to NotebookLM: the source is already on the clipboard
 *  when this opens, so the user only has to open NotebookLM and paste. */
export function NotebookLmModal({
  html: htmlPromise,
  initialCopy,
  commentCount,
  buildSource,
  filename,
  onClose,
}: Props) {
  const [html, setHtml] = useState<string | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>('copying');
  const [includeComments, setIncludeComments] = useState(true);

  useEffect(() => {
    let live = true;
    htmlPromise.then(
      (h) => live && setHtml(h),
      () => live && setLoadFailed(true),
    );
    initialCopy.then(
      (r) => live && setCopyStatus(r === 'failed' ? 'failed' : 'copied'),
      () => live && setCopyStatus('failed'),
    );
    return () => {
      live = false;
    };
  }, [htmlPromise, initialCopy]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const source = useMemo(
    () => (html === null ? null : buildSource(html, includeComments)),
    [html, includeComments, buildSource],
  );

  async function copy(text: string) {
    setCopyStatus('copying');
    const result = await copyText(text);
    setCopyStatus(result === 'failed' ? 'failed' : 'copied');
  }

  function toggleComments(next: boolean) {
    setIncludeComments(next);
    if (html !== null) void copy(buildSource(html, next));
  }

  function download() {
    if (source === null) return;
    const blob = new Blob([source], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const words = source === null ? null : countWords(source);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="notebooklm-title"
        className="w-full max-w-md rounded-lg bg-white shadow-lg dark:bg-neutral-900"
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <h2 id="notebooklm-title" className="text-base font-semibold">
            {t('notebookLmModal.title')}
          </h2>
          <button
            type="button"
            aria-label={t('notebookLmModal.close')}
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800"
          >
            ×
          </button>
        </header>

        <div className="space-y-4 px-4 py-4 text-sm text-neutral-700 dark:text-neutral-300">
          <div role="status" aria-live="polite" className="flex items-start gap-2">
            {loadFailed ? (
              <p className="text-red-600 dark:text-red-400">
                {t('notebookLmModal.loadFailed')}
              </p>
            ) : copyStatus === 'copying' ? (
              <p className="text-neutral-500">{t('notebookLmModal.copying')}</p>
            ) : copyStatus === 'copied' ? (
              <p>
                <span aria-hidden="true" className="mr-1 text-green-600 dark:text-green-400">
                  ✓
                </span>
                {words === null ? t('notebookLmModal.copied') : t('notebookLmModal.copiedWithWords', { count: words.toLocaleString() })}
              </p>
            ) : (
              <div className="flex w-full items-center justify-between gap-2">
                <p>{t('notebookLmModal.copyFailed')}</p>
                <button
                  type="button"
                  disabled={source === null}
                  onClick={() => source !== null && void copy(source)}
                  className="shrink-0 rounded border border-neutral-300 px-2 py-0.5 text-xs hover:bg-neutral-50 disabled:opacity-50 dark:border-neutral-700 dark:hover:bg-neutral-800"
                >
                  {t('notebookLmModal.copyText')}
                </button>
              </div>
            )}
          </div>

          {commentCount > 0 && !loadFailed && (
            <label className="flex items-center gap-2 text-xs">
              <input
                type="checkbox"
                checked={includeComments}
                disabled={html === null}
                onChange={(e) => toggleComments(e.target.checked)}
              />
              {t(commentCount === 1 ? 'notebookLmModal.includeCommentsOne' : 'notebookLmModal.includeCommentsMany', { count: commentCount })}
            </label>
          )}

          {!loadFailed && (
            <ol className="list-decimal space-y-1 pl-5 text-xs text-neutral-600 dark:text-neutral-400">
              <li>{t('notebookLmModal.step1')}</li>
              <li>
                {t('notebookLmModal.step2Under')} <strong>{t('notebookLmModal.step2AddSources')}</strong>{t('notebookLmModal.step2Choose')} <strong>{t('notebookLmModal.step2CopiedText')}</strong> {t('notebookLmModal.step2Paste')}
              </li>
              <li>
                {t('notebookLmModal.step3Use')} <strong>{t('notebookLmModal.step3AudioOverview')}</strong> {t('notebookLmModal.step3Rest')}
              </li>
            </ol>
          )}

          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={download}
              disabled={source === null}
              className="text-xs text-neutral-500 underline hover:text-neutral-800 disabled:opacity-50 dark:hover:text-neutral-200"
            >
              {t('notebookLmModal.downloadMarkdown')}
            </button>
            <a
              href={NOTEBOOKLM_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center rounded bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-neutral-700 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-300"
            >
              {t('notebookLmModal.open')}
            </a>
          </div>
        </div>

        <footer className="border-t border-neutral-200 px-4 py-2 text-[11px] text-neutral-400 dark:border-neutral-800">
          {t('notebookLmModal.footer')}
        </footer>
      </div>
    </div>
  );
}
