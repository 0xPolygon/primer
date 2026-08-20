import { useState, useRef, useEffect } from 'react';
import type { LibraryDocument, FolderDTO } from '@polygonlabs/primer-api-types';
import { FolderPickerMenu } from './FolderPickerMenu.tsx';
import { useAssignFolder, useCreateFolder } from '../queries/library.ts';

export interface DocFolderChipProps {
  doc: LibraryDocument;
  folderName: string;
  folders: FolderDTO[];
}

export function DocFolderChip({ doc, folderName, folders }: DocFolderChipProps) {
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

  const handleCreateAndPick = (name: string) => {
    create.mutate(
      { name },
      {
        onSuccess: (folder) => {
          assign.mutate({ docId: doc.id, folderId: folder.id });
        },
      },
    );
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex max-w-[10rem] items-center gap-1 rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700"
      >
        <span className="truncate">{folderName}</span>
        <span aria-hidden className="text-[0.6rem] opacity-60">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1" onClick={(e) => e.stopPropagation()}>
          <FolderPickerMenu
            folders={folders}
            currentFolderId={doc.folderId}
            onPick={(folderId) => assign.mutate({ docId: doc.id, folderId })}
            onCreateAndPick={handleCreateAndPick}
            onClose={() => setOpen(false)}
          />
        </div>
      )}
    </div>
  );
}
