import { t } from '../i18n/index.ts';
import { useState } from 'react';
import type { FolderDTO } from '@polygonlabs/primer-api-types';
import { FOLDER_UNCATEGORIZED } from '../lib/library.ts';
import {
  useCreateFolder,
  useRenameFolder,
  useDeleteFolder,
} from '../queries/library.ts';
import { normalizeFolderNameClient } from '../lib/library.ts';

export interface LibrarySidebarProps {
  folders: FolderDTO[];
  uncategorizedCount: number;
  totalCount: number;
  selectedFolderId: string | null;
  onSelect: (folderId: string | null) => void;
}

export function LibrarySidebar(props: LibrarySidebarProps) {
  const create = useCreateFolder();
  const [isAdding, setIsAdding] = useState(false);
  const [draftName, setDraftName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);

  const submitCreate = () => {
    const normalized = normalizeFolderNameClient(draftName);
    if (!normalized.ok) {
      setCreateError(normalized.reason === 'empty' ? t('librarySidebar.nameRequired') : t('librarySidebar.tooLong'));
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
          setCreateError(String(e).includes('409') ? t('librarySidebar.nameUsed') : t('librarySidebar.couldNotCreate'));
        },
      },
    );
  };

  return (
    <aside className="hidden md:flex md:w-56 shrink-0 flex-col gap-1 border-r border-neutral-200 pr-4 text-sm dark:border-neutral-800">
      <div className="text-xs font-semibold uppercase tracking-wider text-neutral-500">{t('librarySidebar.folders')}</div>
      <SidebarLink
        label={t('librarySidebar.allDocs')}
        count={props.totalCount}
        active={props.selectedFolderId === null}
        onClick={() => props.onSelect(null)}
      />
      <SidebarLink
        label={t('librarySidebar.uncategorized')}
        count={props.uncategorizedCount}
        active={props.selectedFolderId === FOLDER_UNCATEGORIZED}
        onClick={() => props.onSelect(FOLDER_UNCATEGORIZED)}
      />
      <div className="my-1 border-t border-neutral-200 dark:border-neutral-800" />
      {props.folders.map((f) => (
        <FolderRow
          key={f.id}
          folder={f}
          active={props.selectedFolderId === f.id}
          onSelect={() => props.onSelect(f.id)}
        />
      ))}
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
              placeholder={t('librarySidebar.newFolderName')}
              className="rounded border border-neutral-300 px-2 py-1 text-xs dark:border-neutral-700 dark:bg-neutral-900"
              disabled={create.isPending}
            />
            {createError && <span className="text-xs text-red-600 dark:text-red-400">{createError}</span>}
          </form>
        ) : (
          <button
            type="button"
            onClick={() => setIsAdding(true)}
            className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            {t('librarySidebar.newFolder')}
          </button>
        )}
      </div>
    </aside>
  );
}

function SidebarLink(props: { label: string; count: number; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={
        'flex items-center justify-between rounded px-2 py-1 text-left ' +
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

function FolderRow(props: { folder: FolderDTO; active: boolean; onSelect: () => void }) {
  const rename = useRenameFolder();
  const del = useDeleteFolder();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.folder.name);
  const [error, setError] = useState<string | null>(null);

  const submit = () => {
    const normalized = normalizeFolderNameClient(draft);
    if (!normalized.ok) {
      setError(normalized.reason === 'empty' ? t('librarySidebar.nameRequired') : t('librarySidebar.tooLong'));
      return;
    }
    if (normalized.name === props.folder.name) {
      setEditing(false);
      return;
    }
    rename.mutate(
      { id: props.folder.id, name: normalized.name },
      {
        onSuccess: () => {
          setEditing(false);
          setError(null);
        },
        onError: (e) => setError(String(e).includes('409') ? t('librarySidebar.nameUsed') : t('librarySidebar.couldNotRename')),
      },
    );
  };

  const askDelete = () => {
    if (window.confirm(t('librarySidebar.confirmDelete', { name: props.folder.name }))) {
      del.mutate({ id: props.folder.id });
    }
  };

  if (editing) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
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
          onBlur={submit}
          className="rounded border border-neutral-300 px-2 py-0.5 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          disabled={rename.isPending}
        />
        {error && <span className="text-xs text-red-600 dark:text-red-400">{error}</span>}
      </form>
    );
  }

  return (
    <div
      className={
        'group flex items-center justify-between rounded px-2 py-1 ' +
        (props.active
          ? 'bg-neutral-100 dark:bg-neutral-800'
          : 'hover:bg-neutral-50 dark:hover:bg-neutral-800')
      }
    >
      <button type="button" onClick={props.onSelect} className="flex-1 min-w-0 text-left">
        <span className="truncate block">{props.folder.name}</span>
      </button>
      <div className="flex items-center gap-1">
        <span className="text-xs text-neutral-500">{props.folder.docCount}</span>
        <div className="hidden group-hover:flex items-center gap-1">
          <button
            type="button"
            aria-label={t('librarySidebar.rename')}
            onClick={() => setEditing(true)}
            className="text-xs text-neutral-500 hover:text-neutral-800 dark:hover:text-neutral-200"
          >
            ✎
          </button>
          <button
            type="button"
            aria-label={t('librarySidebar.delete')}
            onClick={askDelete}
            className="text-xs text-neutral-500 hover:text-red-600 dark:hover:text-red-400"
            disabled={del.isPending}
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}
