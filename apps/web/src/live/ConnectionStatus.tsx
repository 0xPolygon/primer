import { t } from '../i18n/index.ts';
import { useEffect, useState } from 'react';
import type { HocuspocusProvider } from '@hocuspocus/provider';
import { CLOSE_FORBIDDEN, CLOSE_SAVE_FAILED } from './provider.ts';
import { connectionView, UNSAVED_AFTER_MS } from './connectionState.ts';

/**
 * Says when edits may not be reaching the server: "Reconnecting…" while the
 * socket is down, "Unsaved changes" when the server hasn't acknowledged
 * changes for more than five seconds, and "Changes not saved" with Retry
 * when the server closed the connection because it couldn't store an update.
 */
export function ConnectionStatus({ provider }: { provider: HocuspocusProvider }) {
  // The socket may already be up when this mounts: start from where it is.
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected'>(
    () => (provider.configuration?.websocketProvider?.status as 'connecting' | 'connected' | 'disconnected' | undefined) ?? 'connecting',
  );
  const [lastCloseCode, setLastCloseCode] = useState<number | null>(null);
  const [unsyncedSince, setUnsyncedSince] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const onStatus = ({ status: next }: { status: 'connecting' | 'connected' | 'disconnected' }) => setStatus(next);
    const onClose = ({ event }: { event: { code: number } }) => {
      if (event.code === CLOSE_SAVE_FAILED || event.code === CLOSE_FORBIDDEN) setLastCloseCode(event.code);
    };
    const onUnsynced = ({ number }: { number: number }) =>
      setUnsyncedSince((since) => (number > 0 ? (since ?? Date.now()) : null));
    provider.on('status', onStatus);
    provider.on('close', onClose);
    provider.on('unsyncedChanges', onUnsynced);
    return () => {
      provider.off('status', onStatus);
      provider.off('close', onClose);
      provider.off('unsyncedChanges', onUnsynced);
    };
  }, [provider]);

  // Re-evaluate once the unsaved threshold passes.
  useEffect(() => {
    if (unsyncedSince === null) return;
    const timer = setTimeout(() => setNow(Date.now()), UNSAVED_AFTER_MS + 50);
    return () => clearTimeout(timer);
  }, [unsyncedSince]);

  const view = connectionView({ status, lastCloseCode, unsyncedSince, now: Math.max(now, Date.now()) });
  if (view.kind === 'ok') return null;
  const tone =
    view.kind === 'save-failed' || view.kind === 'forbidden'
      ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-900/20 dark:text-red-200'
      : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200';
  return (
    <div role="status" data-connection={view.kind} className={`flex items-center gap-2 border-b px-4 py-1.5 text-xs ${tone}`}>
      {view.kind === 'reconnecting' && <span>{t('connectionStatus.reconnecting')}</span>}
      {view.kind === 'unsaved' && <span>{t('connectionStatus.unsaved')}</span>}
      {view.kind === 'forbidden' && <span>{t('connectionStatus.forbidden')}</span>}
      {view.kind === 'save-failed' && (
        <>
          <span>{t('connectionStatus.notSaved')}</span>
          <button
            type="button"
            className="rounded border border-current px-2 py-0.5"
            onClick={() => {
              setLastCloseCode(null);
              void provider.connect();
            }}
          >
            {t('connectionStatus.retry')}
          </button>
        </>
      )}
    </div>
  );
}
