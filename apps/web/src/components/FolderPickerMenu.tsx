import { useState } from 'react';
import type { FolderDTO } from '@polygonlabs/primer-api-types';
import { normalizeFolderNameClient } from '../lib/library.ts';

export interface FolderPickerMenuProps {
  folders: FolderDTO[];
  currentFolderId: string | null;
  onPick: (folderId: string | null) => void;
  onCreateAndPick: (name: string) => void;
  onClose: () => void;
}

export function FolderPickerMenu(props: FolderPickerMenuProps) {
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submitNew = () => {
    const normalized = normalizeFolderNameClient(draft);
    if (!normalized.ok) {
      setError(normalized.reason === 'empty' ? 'Name required' : 'Too long (max 60)');
      return;
    }
    props.onCreateAndPick(normalized.name);
    props.onClose();
  };

  return (
    <div className="min-w-[220px] rounded border border-neutral-200 bg-white p-1 shadow-md dark:border-neutral-700 dark:bg-neutral-900">
      <button
        type="button"
        onClick={() => {
          props.onPick(null);
          props.onClose();
        }}
        className={
          'flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm ' +
          (props.currentFolderId === null ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800')
        }
      >
        <span>None (Uncategorized)</span>
        {props.currentFolderId === null && <span aria-hidden>✓</span>}
      </button>
      {props.folders.map((f) => (
        <button
          key={f.id}
          type="button"
          onClick={() => {
            props.onPick(f.id);
            props.onClose();
          }}
          className={
            'flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm ' +
            (props.currentFolderId === f.id ? 'bg-neutral-100 dark:bg-neutral-800' : 'hover:bg-neutral-50 dark:hover:bg-neutral-800')
          }
        >
          <span className="truncate">{f.name}</span>
          {props.currentFolderId === f.id && <span aria-hidden>✓</span>}
        </button>
      ))}
      <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
      {creating ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitNew();
          }}
          className="flex flex-col gap-1 px-2 py-1"
        >
          <input
            autoFocus
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            placeholder="New folder name"
            className="rounded border border-neutral-300 px-2 py-0.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          />
          {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="w-full rounded px-2 py-1 text-left text-sm text-neutral-600 hover:bg-neutral-50 dark:text-neutral-400 dark:hover:bg-neutral-800"
        >
          + New folder…
        </button>
      )}
    </div>
  );
}
