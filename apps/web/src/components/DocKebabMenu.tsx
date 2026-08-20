import { useState, useRef, useEffect } from 'react';
import type { LibraryDocument, FolderDTO } from '@polygonlabs/primer-api-types';
import { FolderPickerMenu } from './FolderPickerMenu.tsx';
import { useAssignFolder, useCreateFolder } from '../queries/library.ts';

export interface DocKebabMenuProps {
  doc: LibraryDocument;
  folders: FolderDTO[];
  /**
   * `plain`  — hover-only pill; suited to rows on a neutral background.
   * `solid`  — always-visible pill matching DocFolderChip's styling; use on
   *            colored surfaces (e.g. card banners) where a hover-only glyph
   *            would be invisible against the gradient.
   */
  variant?: 'plain' | 'solid';
}

export function DocKebabMenu({ doc, folders, variant = 'plain' }: DocKebabMenuProps) {
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

  const buttonClass =
    variant === 'solid'
      ? 'flex items-center rounded-full bg-neutral-100 px-2 py-0.5 text-xs text-neutral-600 hover:bg-neutral-200 dark:bg-neutral-800 dark:text-neutral-400 dark:hover:bg-neutral-700'
      : 'rounded px-1.5 py-0.5 text-neutral-500 hover:bg-neutral-200 dark:hover:bg-neutral-700';

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
        className={buttonClass}
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
