import { useEffect, useState } from 'react';
import type { FolderDTO } from '@polygonlabs/primer-api-types';
import { BottomSheet, type SnapPoint } from './BottomSheet.tsx';
import { FOLDER_UNCATEGORIZED, normalizeFolderNameClient } from '../lib/library.ts';
import { useCreateFolder } from '../queries/library.ts';

export interface MobileFoldersSheetProps {
  open: boolean;
  folders: FolderDTO[];
  uncategorizedCount: number;
  totalCount: number;
  /** null = All, FOLDER_UNCATEGORIZED = Uncategorized, other = folder id */
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
  onClose: () => void;
}

export function MobileFoldersSheet(props: MobileFoldersSheetProps) {
  const [snap, setSnap] = useState<SnapPoint>('handle');
  const create = useCreateFolder();
  const [isAdding, setIsAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  // When `open` flips to true, expand the sheet.
  useEffect(() => {
    if (props.open) {
      setSnap('expanded');
    }
  }, [props.open]);

  function close() {
    setSnap('handle');
    props.onClose();
  }

  function handleSnapChange(next: SnapPoint) {
    setSnap(next);
    // If user drags to handle, treat as close.
    if (next === 'handle') {
      props.onClose();
    }
  }

  function select(folderId: string | null) {
    props.onSelect(folderId);
    close();
  }

  function submitCreate() {
    const normalized = normalizeFolderNameClient(draftName);
    if (!normalized.ok) {
      setCreateError(normalized.reason === 'empty' ? 'Name required' : 'Too long (max 60)');
      return;
    }
    create.mutate(
      { name: normalized.name },
      {
        onSuccess: () => {
          setDraftName('');
          setIsAdding(false);
          setCreateError(null);
        },
        onError: (e) => {
          setCreateError(String(e).includes('409') ? 'Name already used' : 'Could not create');
        },
      },
    );
  }

  const handleLabel = buildHandleLabel(props.selectedFolderId, props.folders);

  return (
    <div className="md:hidden">
      <BottomSheet
        snap={snap}
        onSnapChange={handleSnapChange}
        handleLabel={handleLabel}
        showBackdrop={true}
      >
        <div className="flex flex-col gap-1 px-3 py-2 text-sm">
          {/* All docs shortcut */}
          <SheetRow
            label="All docs"
            count={props.totalCount}
            active={props.selectedFolderId === null}
            onClick={() => select(null)}
          />
          {/* Uncategorized shortcut */}
          <SheetRow
            label="Uncategorized"
            count={props.uncategorizedCount}
            active={props.selectedFolderId === FOLDER_UNCATEGORIZED}
            onClick={() => select(FOLDER_UNCATEGORIZED)}
          />

          <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />

          {/* Folder list */}
          {props.folders.map((f) => (
            <SheetRow
              key={f.id}
              label={f.name}
              count={f.docCount}
              active={props.selectedFolderId === f.id}
              onClick={() => select(f.id)}
            />
          ))}

          {/* + New folder inline input */}
          <div className="mt-2">
            {isAdding ? (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  submitCreate();
                }}
                className="flex flex-col gap-1"
              >
                <input
                  autoFocus
                  value={draftName}
                  onChange={(e) => {
                    setDraftName(e.target.value);
                    setCreateError(null);
                  }}
                  onBlur={() => {
                    if (draftName.trim().length === 0) {
                      setIsAdding(false);
                      setCreateError(null);
                    }
                  }}
                  placeholder="New folder name"
                  className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
                  disabled={create.isPending}
                />
                {createError && (
                  <span className="text-xs text-red-600 dark:text-red-400">{createError}</span>
                )}
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setIsAdding(true)}
                className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
              >
                + New folder
              </button>
            )}
          </div>
        </div>
      </BottomSheet>
    </div>
  );
}

function buildHandleLabel(selectedFolderId: string | null, folders: FolderDTO[]): string {
  if (selectedFolderId === null) return 'Folders';
  if (selectedFolderId === FOLDER_UNCATEGORIZED) return 'Folders · Uncategorized';
  const folder = folders.find((f) => f.id === selectedFolderId);
  return folder ? `Folders · ${folder.name}` : 'Folders';
}

function SheetRow(props: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={
        'flex items-center justify-between rounded px-2 py-2 text-left ' +
        (props.active
          ? 'bg-neutral-100 text-neutral-900 dark:bg-neutral-800 dark:text-neutral-100'
          : 'text-neutral-700 hover:bg-neutral-50 dark:text-neutral-300 dark:hover:bg-neutral-800')
      }
    >
      <span>{props.label}</span>
      <span className="text-xs text-neutral-500">{props.count}</span>
    </button>
  );
}
