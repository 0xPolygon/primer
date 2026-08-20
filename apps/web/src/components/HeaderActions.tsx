import { useEffect, useRef, useState } from 'react';
import type { VersionSummaryDTO } from '@polygonlabs/primer-api-types';
import { VersionSelector } from './VersionSelector.tsx';
import { buildMenuItems, type MenuItemId } from '../lib/documentActionsMenu.ts';

export interface ActionFeedback {
  kind: 'success' | 'error';
  message: string;
}

interface Props {
  /** 'mobile' collapses Share into the ⋯ menu; 'desktop' shows the Share
   * button. The caller gates visibility per breakpoint (md:hidden vs
   * hidden md:flex), so each instance owns its popover state and
   * outside-click handling without cross-instance ref clashes. */
  variant: 'mobile' | 'desktop';
  docId: string;
  versions: VersionSummaryDTO[];
  currentVersionNumber: number;
  isViewingLatest: boolean;
  onAddVersion?: () => void;
  isUploader: boolean;
  onShare: () => void;
  onOpenFullScreen: () => void;
  /** Resolves to feedback to surface next to the menu; null = silent success. */
  onDownloadHtml: () => Promise<ActionFeedback | null>;
  onCopyComments: () => Promise<ActionFeedback>;
  onExportComments: () => void;
  onDelete: () => Promise<void>;
}

type MenuState = 'closed' | 'menu' | 'confirm';

export function HeaderActions({
  variant,
  docId,
  versions,
  currentVersionNumber,
  isViewingLatest,
  onAddVersion,
  isUploader,
  onShare,
  onOpenFullScreen,
  onDownloadHtml,
  onCopyComments,
  onExportComments,
  onDelete,
}: Props) {
  const [menuState, setMenuState] = useState<MenuState>('closed');
  const [feedback, setFeedback] = useState<ActionFeedback | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const feedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    if (menuState !== 'menu') return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuState('closed');
      }
    }
    window.document.addEventListener('mousedown', onDown);
    return () => window.document.removeEventListener('mousedown', onDown);
  }, [menuState]);

  useEffect(() => {
    return () => {
      if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current);
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function showFeedback(
    fb: ActionFeedback,
    dismissMs: number = fb.kind === 'error' ? 3000 : 2000,
  ) {
    if (feedbackTimerRef.current !== null) clearTimeout(feedbackTimerRef.current);
    setFeedback(fb);
    feedbackTimerRef.current = setTimeout(() => {
      setFeedback(null);
      feedbackTimerRef.current = null;
    }, dismissMs);
  }

  const onClickFor: Record<Exclude<MenuItemId, 'separator'>, () => void> = {
    share: () => {
      setMenuState('closed');
      onShare();
    },
    'open-fullscreen': () => {
      setMenuState('closed');
      onOpenFullScreen();
    },
    'download-html': () => {
      setMenuState('closed');
      void onDownloadHtml()
        .then((fb) => {
          if (fb) showFeedback(fb);
        })
        .catch(() =>
          showFeedback({ kind: 'error', message: 'Download failed. Try again.' }),
        );
    },
    copy: () => {
      setMenuState('closed');
      void onCopyComments()
        .then((fb) => showFeedback(fb))
        .catch(() =>
          showFeedback({ kind: 'error', message: 'Copy failed. Try Download instead.' }),
        );
    },
    download: () => {
      setMenuState('closed');
      onExportComments();
    },
    delete: () => setMenuState('confirm'),
  };

  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {versions.length > 0 && (
        <VersionSelector
          docId={docId}
          versions={versions}
          currentVersionNumber={currentVersionNumber}
          isViewingLatest={isViewingLatest}
          onAddVersion={onAddVersion}
        />
      )}
      {variant === 'desktop' && isUploader && (
        <button
          type="button"
          onClick={onShare}
          className="inline-flex h-7 items-center rounded border border-neutral-300 bg-white px-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          Share
        </button>
      )}
      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setMenuState((s) => (s === 'closed' ? 'menu' : 'closed'))}
          aria-label="More actions"
          aria-haspopup="menu"
          aria-expanded={menuState === 'menu'}
          className="inline-flex h-7 items-center justify-center rounded border border-neutral-300 bg-white px-2 text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
            <circle cx="5" cy="12" r="1.6" />
            <circle cx="12" cy="12" r="1.6" />
            <circle cx="19" cy="12" r="1.6" />
          </svg>
        </button>
        {menuState === 'menu' && (
          <div
            role="menu"
            className="absolute right-0 z-10 mt-1 w-56 overflow-hidden rounded border border-neutral-200 bg-white py-1 shadow-md dark:border-neutral-800 dark:bg-neutral-900"
          >
            {buildMenuItems({ isUploader, includeShare: variant === 'mobile' }).map(
              (item, index) => {
                if (item.id === 'separator') {
                  return (
                    <div
                      key={`sep-${index}`}
                      className="my-1 border-t border-neutral-200 dark:border-neutral-800"
                      aria-hidden="true"
                    />
                  );
                }
                return (
                  <button
                    key={item.id}
                    type="button"
                    role="menuitem"
                    onClick={onClickFor[item.id]}
                    className={`block w-full px-3 py-1.5 text-left text-xs ${
                      item.destructive
                        ? 'text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20'
                        : 'text-neutral-700 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-neutral-800'
                    }`}
                  >
                    {item.label}
                  </button>
                );
              },
            )}
          </div>
        )}
        {menuState === 'confirm' && (
          <div className="absolute right-0 z-10 mt-1 w-64 rounded border border-neutral-200 bg-white p-3 shadow-md dark:border-neutral-800 dark:bg-neutral-900">
            <p className="text-xs text-neutral-700 dark:text-neutral-300">
              Delete this document? You can restore it within 30 days from the home page.
            </p>
            <div className="mt-2 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setMenuState('closed')}
                className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={async () => {
                  try {
                    await onDelete();
                    if (mountedRef.current) setMenuState('closed');
                  } catch {
                    if (mountedRef.current) {
                      showFeedback({ kind: 'error', message: 'Delete failed. Try again.' });
                    }
                  }
                }}
                className="rounded bg-red-600 px-2 py-0.5 text-xs text-white hover:bg-red-700"
              >
                Delete
              </button>
            </div>
          </div>
        )}
        {feedback && (
          <div
            role="status"
            aria-live="polite"
            className={`absolute right-0 z-10 mt-1 rounded border px-2 py-1 text-xs shadow-md ${
              feedback.kind === 'success'
                ? 'border-neutral-200 bg-white text-neutral-700 dark:border-neutral-800 dark:bg-neutral-900 dark:text-neutral-300'
                : 'border-red-300 bg-red-50 text-red-700 dark:border-red-700 dark:bg-red-900/20 dark:text-red-400'
            }`}
          >
            {feedback.message}
          </div>
        )}
      </div>
    </div>
  );
}
