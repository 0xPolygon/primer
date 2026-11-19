import { t } from '../i18n/index.ts';
import { useEffect, useState, type FormEvent } from 'react';
import type { AnchorData } from '@polygonlabs/primer-api-types';
import { MentionTextarea } from './MentionTextarea.tsx';

interface Props {
  anchor: AnchorData;
  submitting: boolean;
  onSubmit: (body: string, mentions: string[]) => void;
  onCancel: () => void;
  /** Fires with `true` once the user has typed any non-whitespace content,
   *  `false` when the field becomes empty again. Used by callers that want
   *  to keep the composer open across iframe interactions only while the
   *  user has unsaved input. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Focus the textarea on mount. Off by default: when the composer opens
   *  because of a text selection in the iframe, grabbing focus would kill
   *  the selection's Cmd+C. Explicit flows (pick mode) opt in. */
  autoFocus?: boolean;
  /** Set by the caller when the last submit attempt failed. The draft body
   *  is left intact (below) so retrying doesn't lose what was typed. */
  error?: string | null;
  /** True when `error` is the "not_latest_version" guard — a newer version
   *  published while this composer was open. Shows a "Switch to latest"
   *  action instead of just the error text, since retrying as-is will
   *  always fail again. */
  errorIsNonLatestVersion?: boolean;
  onGoToLatest?: () => void;
}

function anchorPreview(a: AnchorData): string {
  if (a.type === 'text-range') {
    return `"…${a.selectorText.slice(0, 80)}${a.selectorText.length > 80 ? '…' : ''}"`;
  }
  const inner = a.innerText;
  if (inner && inner.length > 0) {
    return `"${inner.slice(0, 80)}${inner.length > 80 ? '…' : ''}"`;
  }
  return a.path;
}

export function NewThreadComposer({
  anchor,
  submitting,
  onSubmit,
  onCancel,
  onDirtyChange,
  autoFocus = false,
  error = null,
  errorIsNonLatestVersion = false,
  onGoToLatest,
}: Props) {
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<string[]>([]);

  useEffect(() => {
    onDirtyChange?.(body.trim().length > 0);
  }, [body, onDirtyChange]);

  useEffect(() => {
    return () => {
      onDirtyChange?.(false);
    };
  }, [onDirtyChange]);

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (body.trim().length === 0) return;
    onSubmit(body.trim(), mentions);
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="border-b border-yellow-200 dark:border-amber-800 bg-yellow-50 dark:bg-amber-900/20 px-3 py-2 text-xs"
    >
      <div className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-amber-700 dark:text-amber-300">
        {t('newThreadComposer.newComment')}
      </div>
      <div className="mb-2 border-l-2 border-yellow-300 dark:border-amber-700 pl-2 italic text-neutral-600 dark:text-neutral-400">
        {anchorPreview(anchor)}
      </div>
      <MentionTextarea
        value={body}
        onChange={setBody}
        onMentionsChange={setMentions}
        placeholder={t('newThreadComposer.writeComment')}
        rows={3}
        autoFocus={autoFocus}
      />
      {error && (
        <div
          role="alert"
          className="mt-2 rounded border border-red-300 bg-red-50 px-2 py-1.5 text-xs text-red-700 dark:border-red-700 dark:bg-red-900/20 dark:text-red-400"
        >
          <p>
            {errorIsNonLatestVersion
              ? t('newThreadComposer.notLatestVersion')
              : error}
          </p>
          {errorIsNonLatestVersion && onGoToLatest && (
            <button
              type="button"
              onClick={onGoToLatest}
              className="mt-1 rounded border border-red-400 px-1.5 py-0.5 text-red-800 hover:bg-red-100 dark:border-red-600 dark:text-red-300 dark:hover:bg-red-900/30"
            >
              {t('newThreadComposer.switchToLatest')}
            </button>
          )}
        </div>
      )}
      <div className="mt-2 flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-3 py-1 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
        >
          {t('newThreadComposer.cancel')}
        </button>
        <button
          type="submit"
          disabled={submitting || body.trim().length === 0}
          className="rounded bg-neutral-900 px-3 py-1 text-xs text-white hover:bg-neutral-800 disabled:opacity-50 dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200"
        >
          {submitting ? t('newThreadComposer.saving') : t('newThreadComposer.comment')}
        </button>
      </div>
    </form>
  );
}
