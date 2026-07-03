import { useState, useRef, useEffect } from 'react';
import type { FolderDTO } from '@primer/shared';
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

  const label = currentFolderName ? `In: ${currentFolderName} ▾` : 'Add to folder ▾';

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
        className="rounded border border-neutral-300 bg-white px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-50 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-300 dark:hover:bg-neutral-800"
      >
        {label}
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
