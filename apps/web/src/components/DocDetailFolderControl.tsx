import { useState, useRef, useEffect } from 'react';
import type { FolderDTO } from '@polygonlabs/primer-api-types';
import { FolderPickerMenu } from './FolderPickerMenu.tsx';
import { useAssignFolder, useCreateFolder } from '../queries/library.ts';

export interface DocDetailFolderControlProps {
  docId: string;
  currentFolderId: string | null;
  currentFolderName: string | null;
  folders: FolderDTO[];
}

export function DocDetailFolderControl({ docId, currentFolderId, currentFolderName, folders }: DocDetailFolderControlProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const assign = useAssignFolder();
  const create = useCreateFolder();

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (!ref.current) return;
      if (!ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const label = currentFolderName ?? 'Folder';

  const handleCreateAndPick = (name: string) => {
    create.mutate(
      { name },
      { onSuccess: (folder) => assign.mutate({ docId, folderId: folder.id }) },
    );
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-7 max-w-[12rem] items-center gap-1 rounded border border-neutral-300 bg-white px-2.5 text-xs font-medium text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        <span className="truncate">{label}</span>
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true" className="text-neutral-500">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1">
          <FolderPickerMenu
            folders={folders}
            currentFolderId={currentFolderId}
            onPick={(folderId) => assign.mutate({ docId, folderId })}
            onCreateAndPick={handleCreateAndPick}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
