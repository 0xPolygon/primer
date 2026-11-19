import { t } from '../i18n/index.ts';
import type { DeletedDocumentEntry } from '@polygonlabs/primer-api-types';
import { useRestoreDocument } from '../queries/documents.ts';

interface DeletedRowProps {
  entry: DeletedDocumentEntry;
}

export function DeletedDocumentRow({ entry }: DeletedRowProps) {
  const restore = useRestoreDocument(entry.id);
  const isUrgent = entry.daysRemaining <= 3;

  return (
    <div className="flex items-center justify-between border-b border-neutral-100 dark:border-neutral-800 px-1 py-2.5">
      <div className="flex flex-col gap-0.5 min-w-0 flex-1 mr-3">
        <span className="text-sm font-medium text-neutral-800 dark:text-neutral-200 truncate">{entry.title}</span>
        <span className="text-xs text-neutral-500">
          {t('documentListRow.deleted', { date: new Date(entry.deletedAt).toLocaleDateString() })}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            isUrgent ? 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-300' : 'bg-neutral-100 dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400'
          }`}
        >
          {entry.daysRemaining === 1 ? t('documentListRow.dayLeft', { count: 1 }) : t('documentListRow.daysLeft', { count: entry.daysRemaining })}
        </span>
        <button
          type="button"
          disabled={restore.isPending}
          onClick={() => restore.mutate()}
          className="rounded border border-neutral-300 dark:border-neutral-700 bg-white dark:bg-neutral-900 px-2 py-0.5 text-xs text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800 disabled:opacity-50"
        >
          {restore.isPending ? t('documentListRow.restoring') : t('documentListRow.restore')}
        </button>
      </div>
    </div>
  );
}
