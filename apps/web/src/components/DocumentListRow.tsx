import { Link } from 'react-router-dom';
import type {
  DashboardActivityEntry,
  DashboardDocumentSummary,
  DeletedDocumentEntry,
} from '@primer/shared';
import { useRestoreDocument } from '../queries/documents.ts';

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

interface MyDocProps {
  doc: DashboardDocumentSummary;
}

export function MyDocumentRow({ doc }: MyDocProps) {
  return (
    <Link
      to={`/d/${doc.id}`}
      className="flex items-center justify-between border-b border-neutral-100 px-1 py-2.5 hover:bg-neutral-50"
    >
      <div className="flex flex-col gap-0.5 min-w-0 flex-1 mr-3">
        <span className="text-sm font-medium text-neutral-900 truncate">{doc.title}</span>
        <span className="text-xs text-neutral-500 truncate">
          {doc.description ? doc.description : <em className="text-neutral-400">no description</em>}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
          {doc.threadCount === 0
            ? 'no threads yet'
            : `${doc.activeThreadCount}/${doc.threadCount} active`}
        </span>
        <span className="w-20 text-right text-xs text-neutral-500">
          {relativeTime(doc.lastActivityAt)}
        </span>
      </div>
    </Link>
  );
}

interface ActivityProps {
  entry: DashboardActivityEntry;
}

export function ActivityRow({ entry }: ActivityProps) {
  const signalLabel =
    entry.signal === 'commented'
      ? `you commented ${relativeTime(entry.signalAt)}`
      : `viewed ${relativeTime(entry.signalAt)}`;

  return (
    <Link
      to={`/d/${entry.id}`}
      className="flex items-center justify-between border-b border-neutral-100 px-1 py-2.5 hover:bg-neutral-50"
    >
      <div className="flex flex-col gap-0.5 min-w-0 flex-1 mr-3">
        <span className="text-sm font-medium text-neutral-900 truncate">{entry.title}</span>
        <span className="text-xs text-neutral-500 truncate">
          by {entry.uploaderDisplayName} · {signalLabel}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span className="rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600">
          {entry.threadCount === 0
            ? 'no threads'
            : `${entry.activeThreadCount}/${entry.threadCount} active`}
        </span>
        <span className="w-20 text-right text-xs text-neutral-500">
          {relativeTime(entry.signalAt)}
        </span>
      </div>
    </Link>
  );
}

interface DeletedRowProps {
  entry: DeletedDocumentEntry;
}

export function DeletedDocumentRow({ entry }: DeletedRowProps) {
  const restore = useRestoreDocument(entry.id);
  const isUrgent = entry.daysRemaining <= 3;

  return (
    <div className="flex items-center justify-between border-b border-neutral-100 px-1 py-2.5">
      <div className="flex flex-col gap-0.5 min-w-0 flex-1 mr-3">
        <span className="text-sm font-medium text-neutral-800 truncate">{entry.title}</span>
        <span className="text-xs text-neutral-500">
          Deleted {new Date(entry.deletedAt).toLocaleDateString()}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-3">
        <span
          className={`rounded-full px-2 py-0.5 text-xs ${
            isUrgent ? 'bg-red-100 text-red-700' : 'bg-neutral-100 text-neutral-600'
          }`}
        >
          {entry.daysRemaining} {entry.daysRemaining === 1 ? 'day' : 'days'} left
        </span>
        <button
          type="button"
          disabled={restore.isPending}
          onClick={() => restore.mutate()}
          className="rounded border border-neutral-300 bg-white px-2 py-0.5 text-xs text-neutral-700 hover:bg-neutral-50 disabled:opacity-50"
        >
          {restore.isPending ? 'Restoring…' : 'Restore'}
        </button>
      </div>
    </div>
  );
}
