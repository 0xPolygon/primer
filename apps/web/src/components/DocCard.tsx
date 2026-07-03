import { Link } from 'react-router-dom';
import type { LibraryDocument, FolderDTO } from '@primer/shared';
import { PrivateLockIcon } from './PrivateLockIcon.tsx';
import { DocKebabMenu } from './DocKebabMenu.tsx';
import { DocFolderChip } from './DocFolderChip.tsx';
import { hashHue } from '../lib/library.ts';
import { relativeTime } from '../lib/relativeTime.ts';

export interface DocCardProps {
  doc: LibraryDocument;
  folders: FolderDTO[];
  selectedFolderId: string | null;
}

export function DocCard({ doc, folders, selectedFolderId }: DocCardProps) {
  const hue = hashHue(doc.id);
  const hue2 = (hue + 40) % 360;
  const banner =
    doc.visibility === 'private'
      ? { background: 'linear-gradient(135deg, hsl(220, 15%, 25%), hsl(220, 15%, 45%))' }
      : { background: `linear-gradient(135deg, hsl(${hue}, 65%, 55%), hsl(${hue2}, 65%, 55%))` };

  const byline = doc.ownership === 'mine' ? 'just you' : `by ${doc.uploaderDisplayName}`;

  const assignedFolder =
    doc.folderId !== null && doc.folderId !== selectedFolderId
      ? folders.find((f) => f.id === doc.folderId)
      : undefined;

  return (
    <div className="relative flex flex-col overflow-hidden rounded-lg border border-neutral-200 bg-white hover:shadow-md dark:border-neutral-800 dark:bg-neutral-900">
      <Link to={`/d/${doc.id}`} className="block">
        <div className="h-9 w-full relative" style={banner}>
          {doc.visibility === 'private' && (
            <span className="absolute left-2 top-2 flex items-center gap-1 text-xs text-white">
              <PrivateLockIcon className="h-3 w-3" />
              private
            </span>
          )}
        </div>
        <div className="p-3">
          <div className="line-clamp-1 text-sm font-medium text-neutral-900 dark:text-neutral-100">
            {doc.title}
          </div>
          <div className="mt-1 line-clamp-2 h-8 text-xs text-neutral-500">
            {doc.description ?? <em className="text-neutral-400 dark:text-neutral-600">no description</em>}
          </div>
          <div className="mt-2 flex items-center justify-between text-[11px] text-neutral-500">
            <span className="truncate">
              {byline} · {relativeTime(doc.lastActivityAt)}
            </span>
            <span>
              {doc.threadCount === 0 ? 'no threads' : `${doc.activeThreadCount}/${doc.threadCount} active`}
            </span>
          </div>
        </div>
      </Link>
      <div className="absolute right-2 top-1">
        {assignedFolder ? (
          <DocFolderChip doc={doc} folderName={assignedFolder.name} folders={folders} />
        ) : (
          <DocKebabMenu doc={doc} folders={folders} />
        )}
      </div>
    </div>
  );
}
