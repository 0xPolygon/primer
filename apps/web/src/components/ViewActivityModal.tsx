import { useEffect } from 'react';
import { useExternalShareViews } from '../queries/externalShare.ts';
import { relativeTime } from '../lib/relativeTime.ts';
import { t } from '../i18n';

interface Props {
  open: boolean;
  docId: string;
  onClose: () => void;
}

/** Whole-share external view audit log. Stacks above ShareModal, so the ESC
 *  handler registers in the capture phase and stops propagation — one press
 *  closes only this modal, not the ShareModal underneath. */
export function ViewActivityModal({ open, docId, onClose }: Props) {
  const views = useExternalShareViews(docId, open);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/30 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="view-activity-title"
        className="w-full max-w-md rounded-lg bg-white shadow-lg dark:bg-neutral-900"
      >
        <header className="flex items-center justify-between border-b border-neutral-200 px-4 py-3 dark:border-neutral-800">
          <h2 id="view-activity-title" className="text-base font-semibold">
            {t('viewActivityModal.title')}
          </h2>
          <button
            type="button"
            aria-label={t('viewActivityModal.close')}
            onClick={onClose}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900 dark:hover:bg-neutral-800"
          >
            ×
          </button>
        </header>

        <div className="max-h-80 overflow-y-auto px-4 py-3">
          {views.isLoading && <p className="text-sm text-neutral-500">{t('viewActivityModal.loading')}</p>}
          {views.isError && <p className="text-sm text-red-600">{t('viewActivityModal.loadFailed')}</p>}
          {views.data && views.data.views.length === 0 && (
            <p className="text-sm text-neutral-500">{t('viewActivityModal.noViews')}</p>
          )}
          {views.data && views.data.views.length > 0 && (
            <ul className="divide-y divide-neutral-100 dark:divide-neutral-800">
              {views.data.views.map((v) => (
                <li
                  key={v.id}
                  title={new Date(v.viewedAt).toLocaleString()}
                  className="flex items-center justify-between gap-3 py-2 text-xs"
                >
                  <span className="truncate">{v.email}</span>
                  <span className="shrink-0 text-neutral-400">
                    {t('viewActivityModal.versionAndTime', { number: v.versionNumber, time: relativeTime(v.viewedAt) })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {views.data && views.data.total > views.data.views.length && (
          <footer className="border-t border-neutral-200 px-4 py-2 text-[11px] text-neutral-400 dark:border-neutral-800">
            {t('viewActivityModal.showingLatest', { shown: views.data.views.length, total: views.data.total })}
          </footer>
        )}
      </div>
    </div>
  );
}
