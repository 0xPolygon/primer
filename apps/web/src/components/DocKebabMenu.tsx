import { useState, useRef, useEffect } from 'react';
import type { LibraryDocument, FolderDTO } from '@primer/shared';
import { FolderPickerMenu } from './FolderPickerMenu.tsx';
import { useAssignFolder, useCreateFolder } from '../queries/library.ts';

export interface DocKebabMenuProps {
  doc: LibraryDocument;
  folders: FolderDTO[];
}

export function DocKebabMenu({ doc, folders }: DocKebabMenuProps) {
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
        aria-label="More"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700"
      >
        ⋯
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
